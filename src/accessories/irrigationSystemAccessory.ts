import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { OpenSprinklerClient } from '../openSprinklerClient.js';
import type { OpenSprinklerMqtt } from '../openSprinklerMqtt.js';
import type { OpenSprinklerPlatform } from '../platform.js';
import { getStationBit } from '../types.js';

export interface StationContext {
  sid: number;
  name: string;
}

export interface IrrigationDeviceContext {
  controllerId: string;
  host: string;
  stations: StationContext[];
  /** Persisted per-station default run duration (seconds), keyed by sid — survives restarts. */
  valveDurations?: Record<number, number>;
}

const DEFAULT_VALVE_DURATION_SECONDS = 300;
const POLL_INTERVAL_MS = 60_000;

/**
 * One accessory per controller: a HomeKit Irrigation System service with one
 * linked Valve service per zone (HomeKit's native sprinkler model — see
 * https://developers.homebridge.io for the Service/Characteristic reference).
 * System-wide Active maps to the controller's operation-enable flag;
 * per-valve Active/InUse/RemainingDuration map to each station's run state,
 * which the controller already computes for us (`settings.ps[sid]`).
 */
export class IrrigationSystemAccessory {
  private readonly systemService: Service;
  private readonly valveServices = new Map<number, Service>();
  private systemActive = false;
  private pollTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly platform: OpenSprinklerPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly client: OpenSprinklerClient,
    private readonly mqtt?: OpenSprinklerMqtt,
  ) {
    const { Service, Characteristic } = platform;
    const device = accessory.context.device as IrrigationDeviceContext;

    accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'OpenSprinkler')
      .setCharacteristic(Characteristic.Model, 'OpenSprinkler Controller')
      .setCharacteristic(Characteristic.SerialNumber, device.controllerId);

    this.systemService = accessory.getService(Service.IrrigationSystem)
      ?? accessory.addService(Service.IrrigationSystem, accessory.displayName);

    this.systemService.setCharacteristic(Characteristic.ProgramMode, Characteristic.ProgramMode.NO_PROGRAM_SCHEDULED);

    this.systemService.getCharacteristic(Characteristic.Active)
      .onGet(() => this.systemActive ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE)
      .onSet((value) => this.setSystemActive(value));

    this.systemService.getCharacteristic(Characteristic.InUse)
      .onGet(() => this.anyValveActive() ? Characteristic.InUse.IN_USE : Characteristic.InUse.NOT_IN_USE);

    this.platform.log.info(
      '[%s] Registering %d station(s): %s',
      accessory.displayName,
      device.stations.length,
      device.stations.map((s) => `${s.name} (sid ${s.sid})`).join(', ') || '(none)',
    );

    for (const station of device.stations) {
      this.valveServices.set(station.sid, this.setUpValve(device, station));
    }

    void this.refresh();
    this.pollTimer = setInterval(() => void this.refresh(), POLL_INTERVAL_MS);

    this.mqtt?.on('station', (e) => this.handleStationEvent(e));
  }

  private setUpValve(device: IrrigationDeviceContext, station: StationContext): Service {
    const { Service, Characteristic } = this.platform;
    const subtype = `valve-${station.sid}`;
    const valve = this.accessory.getServiceById(Service.Valve, subtype)
      ?? this.accessory.addService(Service.Valve, station.name, subtype);

    valve.setCharacteristic(Characteristic.ValveType, Characteristic.ValveType.IRRIGATION);
    valve.setCharacteristic(Characteristic.IsConfigured, Characteristic.IsConfigured.CONFIGURED);
    valve.setCharacteristic(Characteristic.ServiceLabelIndex, station.sid + 1);
    valve.setCharacteristic(Characteristic.Name, station.name);

    const persistedDuration = device.valveDurations?.[station.sid] ?? DEFAULT_VALVE_DURATION_SECONDS;
    valve.getCharacteristic(Characteristic.SetDuration)
      .updateValue(persistedDuration)
      .onSet((value) => this.persistValveDuration(station.sid, value as number));

    valve.getCharacteristic(Characteristic.Active)
      .onSet((value) => this.setValveActive(station.sid, value, valve));

    valve.getCharacteristic(Characteristic.RemainingDuration)
      .setProps({ maxValue: 86400 });

    this.systemService.addLinkedService(valve);
    return valve;
  }

  private persistValveDuration(sid: number, seconds: number): void {
    const device = this.accessory.context.device as IrrigationDeviceContext;
    device.valveDurations = { ...device.valveDurations, [sid]: seconds };
    this.platform.api.updatePlatformAccessories([this.accessory]);
  }

  private async setSystemActive(value: CharacteristicValue): Promise<void> {
    const { Characteristic } = this.platform;
    const enable = value === Characteristic.Active.ACTIVE;
    try {
      if (!enable) {
        // Disabling the system is expected to actually stop water, not just
        // block future schedules — the controller's own enable flag alone
        // doesn't halt an in-progress manual/program run.
        await this.client.stopAll();
      }
      await this.client.setOperationEnabled(enable);
      this.systemActive = enable;
    } catch (err) {
      this.platform.log.warn('Failed to set system active=%s: %s', enable, (err as Error).message);
      throw err;
    }
  }

  private async setValveActive(sid: number, value: CharacteristicValue, valve: Service): Promise<void> {
    const { Characteristic } = this.platform;
    const active = value === Characteristic.Active.ACTIVE;
    try {
      if (active) {
        const duration = valve.getCharacteristic(Characteristic.SetDuration).value as number;
        await this.client.runStation(sid, duration || DEFAULT_VALVE_DURATION_SECONDS);
      } else {
        await this.client.stopStation(sid);
      }
    } catch (err) {
      this.platform.log.warn('Failed to set valve %d active=%s: %s', sid, active, (err as Error).message);
      throw err;
    }
  }

  private anyValveActive(): boolean {
    const { Characteristic } = this.platform;
    for (const valve of this.valveServices.values()) {
      if (valve.getCharacteristic(Characteristic.InUse).value === Characteristic.InUse.IN_USE) {
        return true;
      }
    }
    return false;
  }

  private handleStationEvent(e: { sid: number; active: boolean; duration?: number }): void {
    const valve = this.valveServices.get(e.sid);
    if (!valve) {
      return;
    }
    const { Characteristic } = this.platform;
    valve.updateCharacteristic(Characteristic.Active, e.active ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE);
    valve.updateCharacteristic(Characteristic.InUse, e.active ? Characteristic.InUse.IN_USE : Characteristic.InUse.NOT_IN_USE);
    valve.updateCharacteristic(Characteristic.RemainingDuration, e.active ? (e.duration ?? 0) : 0);
    this.systemService.updateCharacteristic(
      Characteristic.InUse,
      this.anyValveActive() ? Characteristic.InUse.IN_USE : Characteristic.InUse.NOT_IN_USE,
    );
  }

  /** REST poll — the fallback/reconciliation path for state MQTT doesn't cover (system enable) and anything missed. */
  private async refresh(): Promise<void> {
    const { Characteristic } = this.platform;
    try {
      const data = await this.client.getData();
      this.systemActive = data.settings.en !== 0;
      this.systemService.updateCharacteristic(
        Characteristic.Active,
        this.systemActive ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE,
      );

      for (const [sid, valve] of this.valveServices) {
        const running = data.status.sn[sid] === 1;
        const [, remainingSeconds] = data.settings.ps[sid] ?? [0, 0, 0, 0];
        valve.updateCharacteristic(Characteristic.Active, running ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE);
        valve.updateCharacteristic(Characteristic.InUse, running ? Characteristic.InUse.IN_USE : Characteristic.InUse.NOT_IN_USE);
        valve.updateCharacteristic(Characteristic.RemainingDuration, running ? remainingSeconds : 0);
      }
      this.systemService.updateCharacteristic(
        Characteristic.InUse,
        this.anyValveActive() ? Characteristic.InUse.IN_USE : Characteristic.InUse.NOT_IN_USE,
      );
      this.systemService.updateCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.NO_FAULT);
    } catch (err) {
      this.platform.log.debug('Poll failed for %s: %s', this.accessory.displayName, (err as Error).message);
      this.systemService.updateCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.GENERAL_FAULT);
    }
  }

  /**
   * Helper for platform.ts to build the station list from /jn at discovery
   * time. Only `stn_dis` (explicitly disabled) excludes a station — `stn_spe`
   * ("special" station type: GPIO/HTTP/HTTPS/Remote/Bundle instead of the
   * shift-register-driven default) is NOT a "not a real zone" signal. On an
   * OSPi controller, real built-in relay-driven zones are commonly configured
   * as GPIO type for exactly this reason, so excluding on stn_spe was
   * filtering out every real zone — confirmed live against a controller
   * where all 5 actual zones were flagged "special" and only the 3 unused
   * placeholder slots were disabled.
   */
  static buildStationList(snames: string[], disabledMask: number[]): StationContext[] {
    return snames
      .map((name, sid) => ({ sid, name }))
      .filter(({ sid }) => !getStationBit(disabledMask, sid));
  }

  destroy(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
  }
}
