import type { PlatformAccessory, Service } from 'homebridge';

import type { OpenSprinklerClient } from '../openSprinklerClient.js';
import type { OpenSprinklerMqtt } from '../openSprinklerMqtt.js';
import type { OpenSprinklerPlatform } from '../platform.js';

export interface WaterLevelDeviceContext {
  controllerId: string;
}

const POLL_INTERVAL_MS = 60_000;

/**
 * Shows the weather-adjusted watering percentage (0-200%) as a HumiditySensor
 * reading — HomeKit has no native "generic percentage" service, and reusing
 * HumiditySensor to surface an arbitrary percentage in the Home app is a
 * common community convention. Named clearly so the mismatch is obvious.
 * CurrentRelativeHumidity is clamped to 0-100 by HAP, so values above 100%
 * (OpenSprinkler allows up to 200%) are capped for display purposes.
 */
export class WaterLevelAccessory {
  private readonly service: Service;
  private pollTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly platform: OpenSprinklerPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly client: OpenSprinklerClient,
    private readonly mqtt?: OpenSprinklerMqtt,
  ) {
    const { Service, Characteristic } = platform;
    const device = accessory.context.device as WaterLevelDeviceContext;

    accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'OpenSprinkler')
      .setCharacteristic(Characteristic.Model, 'Water Level')
      .setCharacteristic(Characteristic.SerialNumber, `${device.controllerId}-waterlevel`);

    this.service = accessory.getService(Service.HumiditySensor) ?? accessory.addService(Service.HumiditySensor, accessory.displayName);

    void this.refresh();
    this.pollTimer = setInterval(() => void this.refresh(), POLL_INTERVAL_MS);

    // No dedicated MQTT water-level topic exists outside a weather check —
    // the `weather` topic fires only when the controller actually polls its
    // weather service, which is at most every ~6 hours.
    this.mqtt?.on('weather', (e) => this.applyLevel(e.waterLevel));
  }

  private applyLevel(percent: number): void {
    this.service.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, Math.min(100, percent));
  }

  private async refresh(): Promise<void> {
    try {
      const data = await this.client.getData();
      this.applyLevel(data.options.wl);
    } catch (err) {
      this.platform.log.debug('Water level poll failed: %s', (err as Error).message);
    }
  }

  destroy(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
  }
}
