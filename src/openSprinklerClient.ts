import axios, { type AxiosInstance } from 'axios';

import type { IOptions, OSData, ProgramsData, StationAttribs } from './types.js';

/** Thrown when the controller rejects the configured password hash (`{"result":2}`). */
export class AuthError extends Error {}

const MD5_HEX_PATTERN = /^[a-f0-9]{32}$/i;

export interface OpenSprinklerClientConfig {
  host: string;
  port?: number;
  /**
   * MD5 hash of the admin password — never the plaintext password. The
   * controller's own API only ever accepts the hash (`pw=<md5>`) and never
   * sees the plaintext either way, so there's no reason to also keep the
   * plaintext in Homebridge's config.json. Get it the same way
   * opensprinkler-ui does: open the controller's web UI, log in, then in the
   * browser console run `localStorage.getItem('os_pw_hash')` — or compute it
   * yourself with `echo -n "<password>" | md5` (macOS) / `md5sum` (Linux).
   */
  passwordHash: string;
}

/** Thin REST client for an OpenSprinkler controller. */
export class OpenSprinklerClient {
  private readonly pwHash: string;
  private readonly http: AxiosInstance;

  constructor(config: OpenSprinklerClientConfig) {
    if (!MD5_HEX_PATTERN.test(config.passwordHash)) {
      throw new Error(
        `"passwordHash" for ${config.host} doesn't look like an MD5 hash (expected 32 hex characters) — ` +
        'make sure the plugin config has the hash, not the plaintext password.',
      );
    }
    const port = config.port ?? 80;
    this.pwHash = config.passwordHash.toLowerCase();
    this.http = axios.create({ baseURL: `http://${config.host}:${port}`, timeout: 8000 });
  }

  private async get<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
    const res = await this.http.get(path, { params: { pw: this.pwHash, ...params } });
    const data = res.data;
    if (data && typeof data === 'object' && 'result' in data && data.result === 2) {
      throw new AuthError('OpenSprinkler rejected the configured password hash');
    }
    return data as T;
  }

  getData(): Promise<OSData> {
    return this.get<OSData>('/ja');
  }

  getOptions(): Promise<IOptions> {
    return this.get<IOptions>('/jo');
  }

  getPrograms(): Promise<ProgramsData> {
    return this.get<ProgramsData>('/jp');
  }

  getStationAttribs(): Promise<StationAttribs> {
    return this.get<StationAttribs>('/jn');
  }

  runStation(sid: number, seconds: number): Promise<unknown> {
    return this.get('/cm', { sid, en: 1, t: seconds });
  }

  stopStation(sid: number): Promise<unknown> {
    return this.get('/cm', { sid, en: 0 });
  }

  stopAll(): Promise<unknown> {
    return this.get('/cv', { rsn: 1 });
  }

  setOperationEnabled(enabled: boolean): Promise<unknown> {
    return this.get('/cv', { en: enabled ? 1 : 0 });
  }

  setRainDelay(hours: number): Promise<unknown> {
    return this.get('/cv', { rd: hours });
  }

  cancelRainDelay(): Promise<unknown> {
    return this.get('/cv', { rd: 0 });
  }

  runProgram(pid: number): Promise<unknown> {
    return this.get('/mp', { pid, uwt: 0 });
  }
}
