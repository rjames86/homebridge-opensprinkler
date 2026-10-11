import type { PlatformAccessory, Service } from 'homebridge';

import type { OpenSprinklerClient } from '../openSprinklerClient.js';
import type { OpenSprinklerMqtt, SensorEvent } from '../openSprinklerMqtt.js';
import type { OpenSprinklerPlatform } from '../platform.js';

export interface SensorDeviceContext {
  controllerId: string;
  index: 1 | 2;
  name: string;
  /** OpenSprinkler sensor type: 1 = Rain, 3 = Soil. Only these two map to a binary sensor. */
  sensorType: 1 | 3;
}

const POLL_INTERVAL_MS = 60_000;

/**
 * A ContactSensor accessory for a configured rain or soil sensor (sn1/sn2).
 * Flow sensors aren't exposed this way — a boolean "detected" state isn't a
 * meaningful representation of a flow rate.
 */
export class SensorAccessory {
  private readonly service: Service;
  private pollTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly platform: OpenSprinklerPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly client: OpenSprinklerClient,
    private readonly mqtt?: OpenSprinklerMqtt,
  ) {
    const { Service, Characteristic } = platform;
    const device = accessory.context.device as SensorDeviceContext;

    accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'OpenSprinkler')
      .setCharacteristic(Characteristic.Model, device.sensorType === 1 ? 'Rain Sensor' : 'Soil Sensor')
      .setCharacteristic(Characteristic.SerialNumber, `${device.controllerId}-sensor${device.index}`);

    this.service = accessory.getService(Service.ContactSensor) ?? accessory.addService(Service.ContactSensor, accessory.displayName);

    void this.refresh();
    this.pollTimer = setInterval(() => void this.refresh(), POLL_INTERVAL_MS);

    this.mqtt?.on('sensor', (e: SensorEvent) => {
      if (e.index === device.index) {
        this.applyState(e.active);
      }
    });
  }

  private applyState(active: boolean): void {
    const { Characteristic } = this.platform;
    this.service.updateCharacteristic(
      Characteristic.ContactSensorState,
      active ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED : Characteristic.ContactSensorState.CONTACT_DETECTED,
    );
  }

  private async refresh(): Promise<void> {
    const device = this.accessory.context.device as SensorDeviceContext;
    try {
      const data = await this.client.getData();
      this.applyState((device.index === 1 ? data.settings.sn1 : data.settings.sn2) === 1);
    } catch (err) {
      this.platform.log.debug('Sensor %d poll failed: %s', device.index, (err as Error).message);
    }
  }

  destroy(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
  }
}
