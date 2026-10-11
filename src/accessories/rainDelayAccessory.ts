import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { OpenSprinklerClient } from '../openSprinklerClient.js';
import type { OpenSprinklerMqtt } from '../openSprinklerMqtt.js';
import type { OpenSprinklerPlatform } from '../platform.js';

export interface RainDelayDeviceContext {
  controllerId: string;
  defaultHours: number;
}

const POLL_INTERVAL_MS = 60_000;

/** A Switch accessory for rain delay — HomeKit has no native "rain delay" concept. */
export class RainDelayAccessory {
  private readonly service: Service;
  private pollTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly platform: OpenSprinklerPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly client: OpenSprinklerClient,
    private readonly mqtt?: OpenSprinklerMqtt,
  ) {
    const { Service, Characteristic } = platform;
    const device = accessory.context.device as RainDelayDeviceContext;

    accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'OpenSprinkler')
      .setCharacteristic(Characteristic.Model, 'Rain Delay')
      .setCharacteristic(Characteristic.SerialNumber, `${device.controllerId}-raindelay`);

    this.service = accessory.getService(Service.Switch) ?? accessory.addService(Service.Switch, accessory.displayName);

    this.service.getCharacteristic(Characteristic.On)
      .onSet((value) => this.setOn(value));

    void this.refresh();
    this.pollTimer = setInterval(() => void this.refresh(), POLL_INTERVAL_MS);

    this.mqtt?.on('raindelay', (active) => {
      this.service.updateCharacteristic(Characteristic.On, active);
    });
  }

  private async setOn(value: CharacteristicValue): Promise<void> {
    const device = this.accessory.context.device as RainDelayDeviceContext;
    try {
      if (value) {
        await this.client.setRainDelay(device.defaultHours);
      } else {
        await this.client.cancelRainDelay();
      }
    } catch (err) {
      this.platform.log.warn('Failed to set rain delay: %s', (err as Error).message);
      throw err;
    }
  }

  private async refresh(): Promise<void> {
    try {
      const data = await this.client.getData();
      this.service.updateCharacteristic(this.platform.Characteristic.On, data.settings.rd === 1);
    } catch (err) {
      this.platform.log.debug('Rain delay poll failed: %s', (err as Error).message);
    }
  }

  destroy(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
  }
}
