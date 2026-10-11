import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import { IrrigationSystemAccessory, type IrrigationDeviceContext } from './accessories/irrigationSystemAccessory.js';
import { ProgramSwitchAccessory, type ProgramSwitchDeviceContext } from './accessories/programSwitchAccessory.js';
import { RainDelayAccessory, type RainDelayDeviceContext } from './accessories/rainDelayAccessory.js';
import { SensorAccessory, type SensorDeviceContext } from './accessories/sensorAccessory.js';
import { WaterLevelAccessory, type WaterLevelDeviceContext } from './accessories/waterLevelAccessory.js';
import { OpenSprinklerClient } from './openSprinklerClient.js';
import { OpenSprinklerMqtt } from './openSprinklerMqtt.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { summarizePrograms } from './types.js';

export interface MqttConfig {
  enabled: boolean;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  topicPrefix: string;
}

export interface ControllerConfig {
  name: string;
  host: string;
  port?: number;
  /** MD5 hash of the admin password — see OpenSprinklerClientConfig.passwordHash for how to get it. */
  passwordHash: string;
  rainDelay?: { enabled: boolean; defaultHours?: number };
  programSwitches?: boolean;
  sensors?: boolean;
  waterLevel?: boolean;
  mqtt?: MqttConfig;
}

export interface OpenSprinklerPlatformConfig extends PlatformConfig {
  controllers?: ControllerConfig[];
}

/**
 * Main platform constructor — parses config, discovers/registers accessories.
 * One controller config produces one Irrigation System accessory plus
 * whichever optional accessories (rain delay, program switches, sensors,
 * water level) are enabled for it.
 */
export class OpenSprinklerPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories = new Map<string, PlatformAccessory>();
  private readonly discoveredUUIDs: string[] = [];
  private readonly irrigationHandlers: IrrigationSystemAccessory[] = [];
  private readonly rainDelayHandlers: RainDelayAccessory[] = [];
  private readonly sensorHandlers: SensorAccessory[] = [];
  private readonly waterLevelHandlers: WaterLevelAccessory[] = [];
  private readonly mqttClients: OpenSprinklerMqtt[] = [];

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.api.on('didFinishLaunching', () => {
      void this.discoverDevices();
    });

    this.api.on('shutdown', () => this.shutdown());
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Loading accessory from cache: %s', accessory.displayName);
    this.accessories.set(accessory.UUID, accessory);
  }

  private getOrCreate(uniqueId: string, displayName: string): PlatformAccessory {
    const uuid = this.api.hap.uuid.generate(uniqueId);
    let accessory = this.accessories.get(uuid);

    if (accessory) {
      this.log.info('Restoring accessory from cache: %s', displayName);
    } else {
      this.log.info('Adding new accessory: %s', displayName);
      accessory = new this.api.platformAccessory(displayName, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.set(uuid, accessory);
    }

    this.discoveredUUIDs.push(uuid);
    return accessory;
  }

  private async discoverDevices(): Promise<void> {
    const config = this.config as OpenSprinklerPlatformConfig;
    const controllers = config.controllers ?? [];

    if (controllers.length === 0) {
      this.log.warn('No OpenSprinkler controllers configured.');
    }

    for (const controllerConfig of controllers) {
      await this.setUpController(controllerConfig);
    }

    for (const [uuid, accessory] of this.accessories) {
      if (!this.discoveredUUIDs.includes(uuid)) {
        this.log.info('Removing stale accessory: %s', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.delete(uuid);
      }
    }
  }

  private async setUpController(cfg: ControllerConfig): Promise<void> {
    const client = new OpenSprinklerClient({ host: cfg.host, port: cfg.port, passwordHash: cfg.passwordHash });
    const controllerId = cfg.host;

    let mqttClient: OpenSprinklerMqtt | undefined;
    if (cfg.mqtt?.enabled) {
      mqttClient = new OpenSprinklerMqtt(
        {
          host: cfg.mqtt.host ?? cfg.host,
          port: cfg.mqtt.port,
          username: cfg.mqtt.username,
          password: cfg.mqtt.password,
          topicPrefix: cfg.mqtt.topicPrefix,
        },
        this.log,
      );
      mqttClient.connect();
      this.mqttClients.push(mqttClient);
    }

    let stations: IrrigationDeviceContext['stations'];
    try {
      const [data, stationAttribs] = await Promise.all([client.getData(), client.getStationAttribs()]);
      stations = IrrigationSystemAccessory.buildStationList(data.stations.snames, stationAttribs.stn_dis);
    } catch (err) {
      this.log.error('Could not reach OpenSprinkler controller "%s" at %s: %s', cfg.name, cfg.host, (err as Error).message);
      return;
    }

    const irrigationAccessory = this.getOrCreate(`${controllerId}-irrigation`, cfg.name);
    const existingDurations = (irrigationAccessory.context.device as IrrigationDeviceContext | undefined)?.valveDurations;
    irrigationAccessory.context.device = {
      controllerId, host: cfg.host, stations, valveDurations: existingDurations,
    } satisfies IrrigationDeviceContext;
    this.api.updatePlatformAccessories([irrigationAccessory]);
    this.irrigationHandlers.push(new IrrigationSystemAccessory(this, irrigationAccessory, client, mqttClient));

    if (cfg.rainDelay?.enabled) {
      const rdAccessory = this.getOrCreate(`${controllerId}-raindelay`, `${cfg.name} Rain Delay`);
      rdAccessory.context.device = {
        controllerId, defaultHours: cfg.rainDelay.defaultHours ?? 24,
      } satisfies RainDelayDeviceContext;
      this.api.updatePlatformAccessories([rdAccessory]);
      this.rainDelayHandlers.push(new RainDelayAccessory(this, rdAccessory, client, mqttClient));
    }

    if (cfg.programSwitches) {
      const programs = await client.getPrograms().catch(() => ({ pd: [] }));
      // Every defined program gets a switch, regardless of its own
      // auto-schedule "enabled" flag — that flag only controls whether the
      // program runs on its own schedule, not whether it's a valid manual
      // trigger target. A seasonally-paused program should still be
      // runnable on demand from HomeKit.
      for (const program of summarizePrograms(programs)) {
        const pAccessory = this.getOrCreate(`${controllerId}-program-${program.pid}`, `${cfg.name} ${program.name}`);
        pAccessory.context.device = {
          controllerId, pid: program.pid, name: program.name,
        } satisfies ProgramSwitchDeviceContext;
        this.api.updatePlatformAccessories([pAccessory]);
        new ProgramSwitchAccessory(this, pAccessory, client, mqttClient);
      }
    }

    if (cfg.sensors) {
      const options = await client.getOptions().catch(() => undefined);
      if (options) {
        for (const index of [1, 2] as const) {
          const sensorType = index === 1 ? options.sn1t : options.sn2t;
          if (sensorType !== 1 && sensorType !== 3) {
            continue;
          }
          const name = `${cfg.name} Sensor ${index}`;
          const sAccessory = this.getOrCreate(`${controllerId}-sensor${index}`, name);
          sAccessory.context.device = {
            controllerId, index, name, sensorType,
          } satisfies SensorDeviceContext;
          this.api.updatePlatformAccessories([sAccessory]);
          this.sensorHandlers.push(new SensorAccessory(this, sAccessory, client, mqttClient));
        }
      }
    }

    if (cfg.waterLevel) {
      const wAccessory = this.getOrCreate(`${controllerId}-waterlevel`, `${cfg.name} Water Level`);
      wAccessory.context.device = { controllerId } satisfies WaterLevelDeviceContext;
      this.api.updatePlatformAccessories([wAccessory]);
      this.waterLevelHandlers.push(new WaterLevelAccessory(this, wAccessory, client, mqttClient));
    }
  }

  private shutdown(): void {
    for (const mqttClient of this.mqttClients) {
      mqttClient.disconnect();
    }
    for (const handler of this.irrigationHandlers) {
      handler.destroy();
    }
    for (const handler of this.rainDelayHandlers) {
      handler.destroy();
    }
    for (const handler of this.sensorHandlers) {
      handler.destroy();
    }
    for (const handler of this.waterLevelHandlers) {
      handler.destroy();
    }
  }
}
