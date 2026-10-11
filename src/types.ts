// OpenSprinkler controller API response shapes, scoped to what this plugin
// actually uses. Verified against a live OpenSprinkler Firmware controller
// and its API source (api/server.cpp, api/stations.cpp) in a separate
// session — see opensprinkler-ui/src/lib/api.ts for the fuller reference
// this was trimmed from (same firmware, same fields).

/** GET /ja — full controller status. */
export interface OSData {
  settings: {
    en: number // 1 = system operation enabled, 0 = disabled
    rd: number // 1 = rain delay currently active
    rdst: number // rain delay stop time (unix seconds)
    sn1: number // live sensor 1 state (0/1) — distinct from sn1t (type) on /jo
    sn2: number // live sensor 2 state (0/1)
    ps: Array<[number, number, number, number]> // per-station: [pid, remainingSeconds, startTime, group] — the controller computes remaining time itself
    nbrd: number
  }
  options: {
    wl: number // weather-adjusted watering percentage (0-200)
  }
  stations: {
    snames: string[]
    stn_dis: number[] // per-board bitmask, 8 stations/board — disabled flag
  }
  status: {
    sn: number[] // per-station: 1 = currently running
  }
}

/** GET /jo — IOPT_*-named fields, a different shape from OSData['settings']. */
export interface IOptions {
  den: number // IOPT_DEVICE_ENABLE — distinct from settings.en
  sn1t: number
  sn2t: number
  [key: string]: unknown
}

/** GET /jn — station attribute bitfields (disable, ignore-rain, master association). */
export interface StationAttribs {
  masop: number[] // master 1 association bitmask, per board
  stn_dis: number[]
  stn_spe: number[] // "special" station types (GPIO/HTTP/remote/bundle) — not real zones
  snames: string[]
}

/** GET /jp — programs. Each entry: [flags, days0, days1, startTimes, durations, name]. */
export type RawProgram = [number, number, number, number[] | number, number[], string];

export interface ProgramsData {
  pd: RawProgram[];
}

export interface ProgramSummary {
  pid: number;
  name: string;
  enabled: boolean;
}

export function summarizePrograms(data: ProgramsData): ProgramSummary[] {
  return data.pd.map((raw, pid) => ({
    pid,
    name: raw[5] || `Program ${pid + 1}`,
    enabled: !!(raw[0] & 1),
  }));
}

/** Per-board bitfield read, matching the firmware's 8-stations-per-board packing. */
export function getStationBit(arr: number[], index: number): boolean {
  const board = Math.floor(index / 8);
  const bit = index % 8;
  return !!((arr[board] ?? 0) & (1 << bit));
}
