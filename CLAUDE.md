# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Project Overview

A Homebridge dynamic platform plugin for OpenSprinkler irrigation controllers.
Built from scratch (not forked from the two existing, unmaintained
OpenSprinkler Homebridge plugins) on current Homebridge best practices —
see README.md for the full feature rationale.

## Architecture

- `src/index.ts` — registers the platform (ESM default export).
- `src/settings.ts` — `PLATFORM_NAME`/`PLUGIN_NAME` constants.
- `src/platform.ts` — `OpenSprinklerPlatform`, a `DynamicPlatformPlugin`.
  Parses the `controllers` config array; one `OpenSprinklerClient` +
  (optionally) one `OpenSprinklerMqtt` per controller. Discovers stations/
  programs/sensors and creates/restores accessories accordingly.
- `src/openSprinklerClient.ts` — thin REST client. Every call takes
  `pw=<md5 hash>` — the plugin never sees or stores the plaintext password.
- `src/openSprinklerMqtt.ts` — subscribes to the controller's **own** MQTT
  broker (not Homebridge's) for near-real-time updates. See the file's
  top comment for the exact topic/payload shapes, verified against
  `OpenSprinkler-Firmware/services/notifier.cpp`.
- `src/accessories/*.ts` — one file per accessory type. `irrigationSystemAccessory.ts`
  is the core one (`IrrigationSystem` + linked `Valve` per zone).
- `src/types.ts` — OpenSprinkler API response shapes, trimmed to what this
  plugin uses. A fuller reference for the same firmware's API lives in a
  sibling project, `opensprinkler-ui/src/lib/api.ts`.

## Key gotchas (found the hard way — don't re-derive, and don't regress)

- **`stn_spe` (from `/jn`) does NOT mean "not a real zone."** It flags a
  station using a non-standard type (GPIO/HTTP/HTTPS/Remote/Bundle instead
  of the shift-register-driven default). On an OSPi controller, the
  built-in relay-driven zones are commonly configured as GPIO type for
  exactly this reason. `IrrigationSystemAccessory.buildStationList` only
  excludes on `stn_dis` (explicitly disabled) — confirmed live against a
  real controller where every actual zone was flagged "special" and only
  the unused placeholder slots were disabled. Filtering on `stn_spe` too
  silently produces zero valves.
- **`passwordHash` is an MD5 hash, never the plaintext password** — matches
  the controller's own API convention (it only ever accepts `pw=<md5>`).
  `OpenSprinklerClient`'s constructor validates the format and throws a
  clear error if something that isn't a 32-char hex string gets passed in.
- **`settings.ps[sid]` is `[pid, remainingSeconds, startTime, group]`** —
  the controller computes remaining run time itself; don't track run-start
  timestamps client-side to derive it.
- **No MQTT event exists for system enable/disable or water-level outside a
  weather check** — `openSprinklerMqtt.ts`'s doc comment lists exactly which
  topics exist. Those two still need the REST poll fallback.
- **Testing over SSH**: if `homebridge -D` logs `EHOSTUNREACH` reaching the
  controller from Node, but `curl` to the same host from the same shell
  works fine, it's macOS's Local Network privacy permission — it has no
  app to attribute the request to over a raw `sshd`-spawned session, so it
  silently denies rather than prompting. Test from the machine's local
  console instead; this doesn't indicate a code bug.

## Development

```bash
npm install
npm run build
npm run lint
npm link
homebridge -U ./test/hbConfig -D
```

`test/hbConfig/` is gitignored — put real controller credentials there, not
in anything committed.
