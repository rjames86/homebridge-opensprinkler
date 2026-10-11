import { EventEmitter } from 'node:events';

import mqtt, { type MqttClient } from 'mqtt';
import type { Logging } from 'homebridge';

/**
 * Subscribes to the MQTT events an OpenSprinkler controller publishes itself
 * (its own built-in MQTT client, configured via the controller's own MQTT
 * options — not Homebridge's broker). Topic/payload shapes verified against
 * OpenSprinkler-Firmware's services/notifier.cpp:
 *
 *   station/<sid>  -> {"state":1,"duration":<sec>} | {"state":0,"duration":<sec>,"flow":<gpm>}
 *   raindelay      -> {"state":1|0}
 *   sensor1..4     -> {"state":1|0}
 *   sensor/flow    -> {"count":N,"volume":V}
 *   program/<pid>  -> fires when a program starts (payload not used)
 *   weather        -> {"water level":N}  (literal space in the key)
 *
 * There is no MQTT event for system enable/disable or water-level outside a
 * weather check — those still need REST polling (see platform.ts).
 */

export interface OpenSprinklerMqttConfig {
  host: string;
  port?: number;
  username?: string;
  password?: string;
  /** Must match the controller's own configured MQTT publish topic prefix. */
  topicPrefix: string;
}

export interface StationEvent {
  sid: number;
  active: boolean;
  duration?: number;
  flowGpm?: number;
}

export interface SensorEvent {
  index: 1 | 2 | 3 | 4;
  active: boolean;
}

export interface FlowEvent {
  count: number;
  volume: number;
}

export interface WeatherEvent {
  waterLevel: number;
}

interface OpenSprinklerMqttEvents {
  station: (e: StationEvent) => void;
  raindelay: (active: boolean) => void;
  sensor: (e: SensorEvent) => void;
  flow: (e: FlowEvent) => void;
  program: (pid: number) => void;
  weather: (e: WeatherEvent) => void;
}

export class OpenSprinklerMqtt extends EventEmitter {
  private client?: MqttClient;

  constructor(
    private readonly config: OpenSprinklerMqttConfig,
    private readonly log: Logging,
  ) {
    super();
  }

  override on<K extends keyof OpenSprinklerMqttEvents>(event: K, listener: OpenSprinklerMqttEvents[K]): this {
    return super.on(event, listener);
  }

  private typedEmit<K extends keyof OpenSprinklerMqttEvents>(event: K, ...args: Parameters<OpenSprinklerMqttEvents[K]>): void {
    super.emit(event, ...args);
  }

  connect(): void {
    const url = `mqtt://${this.config.host}:${this.config.port ?? 1883}`;
    this.client = mqtt.connect(url, {
      username: this.config.username,
      password: this.config.password,
      reconnectPeriod: 5000,
    });

    this.client.on('connect', () => {
      this.log.info('Connected to OpenSprinkler MQTT broker at %s', url);
      this.client?.subscribe(`${this.config.topicPrefix}/#`);
    });

    this.client.on('reconnect', () => this.log.debug('Reconnecting to OpenSprinkler MQTT broker...'));
    this.client.on('error', (err) => this.log.warn('OpenSprinkler MQTT error: %s', err.message));
    this.client.on('message', (topic, payloadBuf) => this.handleMessage(topic, payloadBuf));
  }

  disconnect(): void {
    this.client?.end();
  }

  private handleMessage(topic: string, payloadBuf: Buffer): void {
    const prefix = `${this.config.topicPrefix}/`;
    if (!topic.startsWith(prefix)) {
      return;
    }
    const suffix = topic.slice(prefix.length);

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(payloadBuf.toString());
    } catch {
      this.log.debug('Ignoring non-JSON MQTT payload on %s', topic);
      return;
    }

    const stationMatch = suffix.match(/^station\/(\d+)$/);
    if (stationMatch) {
      this.typedEmit('station', {
        sid: Number(stationMatch[1]),
        active: payload.state === 1,
        duration: typeof payload.duration === 'number' ? payload.duration : undefined,
        flowGpm: typeof payload.flow === 'number' ? payload.flow : undefined,
      });
      return;
    }

    if (suffix === 'raindelay') {
      this.typedEmit('raindelay', payload.state === 1);
      return;
    }

    const sensorMatch = suffix.match(/^sensor([1-4])$/);
    if (sensorMatch) {
      this.typedEmit('sensor', {
        index: Number(sensorMatch[1]) as 1 | 2 | 3 | 4,
        active: payload.state === 1,
      });
      return;
    }

    if (suffix === 'sensor/flow') {
      this.typedEmit('flow', {
        count: Number(payload.count),
        volume: Number(payload.volume),
      });
      return;
    }

    const programMatch = suffix.match(/^program\/(\d+)$/);
    if (programMatch) {
      this.typedEmit('program', Number(programMatch[1]));
      return;
    }

    if (suffix === 'weather') {
      const waterLevel = payload['water level'];
      if (typeof waterLevel === 'number') {
        this.typedEmit('weather', { waterLevel });
      }
    }
  }
}
