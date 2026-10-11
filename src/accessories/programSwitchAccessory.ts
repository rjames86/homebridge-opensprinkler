import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { OpenSprinklerClient } from '../openSprinklerClient.js';
import type { OpenSprinklerMqtt } from '../openSprinklerMqtt.js';
import type { OpenSprinklerPlatform } from '../platform.js';

export interface ProgramSwitchDeviceContext {
  controllerId: string;
  pid: number;
  name: string;
}

const AUTO_OFF_DELAY_MS = 1000;

/**
 * A momentary Switch accessory that triggers a program run. There's no
 * native HomeKit "run this program" action, and IrrigationSystem's
 * ProgramMode characteristic is read-only status, not a control — a
 * stateless trigger switch is the standard pattern for this.
 */
export class ProgramSwitchAccessory {
  private readonly service: Service;

  constructor(
    private readonly platform: OpenSprinklerPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly client: OpenSprinklerClient,
    private readonly mqtt?: OpenSprinklerMqtt,
  ) {
    const { Service, Characteristic } = platform;
    const device = accessory.context.device as ProgramSwitchDeviceContext;

    accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'OpenSprinkler')
      .setCharacteristic(Characteristic.Model, 'Program')
      .setCharacteristic(Characteristic.SerialNumber, `${device.controllerId}-program-${device.pid}`);

    this.service = accessory.getService(Service.Switch) ?? accessory.addService(Service.Switch, accessory.displayName);
    this.service.getCharacteristic(Characteristic.On)
      .onSet((value) => this.setOn(value));

    this.mqtt?.on('program', (pid) => {
      if (pid === device.pid) {
        this.service.updateCharacteristic(Characteristic.On, true);
        setTimeout(() => this.service.updateCharacteristic(Characteristic.On, false), AUTO_OFF_DELAY_MS);
      }
    });
  }

  private async setOn(value: CharacteristicValue): Promise<void> {
    const device = this.accessory.context.device as ProgramSwitchDeviceContext;
    if (!value) {
      // Switching off manually (without an MQTT program-start echo) is a no-op —
      // there's no "cancel a program" concept to call through to.
      return;
    }
    try {
      await this.client.runProgram(device.pid);
    } catch (err) {
      this.platform.log.warn('Failed to run program %s (%d): %s', device.name, device.pid, (err as Error).message);
      throw err;
    } finally {
      setTimeout(() => this.service.updateCharacteristic(this.platform.Characteristic.On, false), AUTO_OFF_DELAY_MS);
    }
  }
}
