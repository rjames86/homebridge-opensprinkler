# homebridge-opensprinkler

A Homebridge plugin for [OpenSprinkler](https://opensprinkler.com/) irrigation
controllers.

- Exposes each controller as a HomeKit **Irrigation System** with a linked
  **Valve** per zone, grouped under one tile in the Home app.
- Persists each valve's run duration across Homebridge restarts.
- Subscribes to the controller's own MQTT events for near-instant state
  updates (zone on/off, rain delay, sensors), falling back to REST polling
  for anything MQTT doesn't cover.
- Supports multiple controllers from one config.
- Optionally exposes rain delay, program-trigger switches, configured
  rain/soil sensors, and weather-adjusted water level.

## Features

| Accessory | Service | Notes |
|---|---|---|
| Irrigation System | `IrrigationSystem` + linked `Valve` per zone | Always created. `Active` = system enable/disable; disabling also stops any in-progress run. Each valve's `SetDuration` persists across restarts. |
| Rain Delay | `Switch` | Optional. Turning on applies a configurable default delay (hours); synced instantly via MQTT if enabled. |
| Program switches | `Switch` (momentary) per enabled program | Optional. Triggers the program, then auto-resets off ~1s later — there's no native "run this program" HomeKit action. |
| Sensors | `ContactSensor` per configured rain/soil sensor | Optional. Only created if the controller actually has `sn1`/`sn2` configured as Rain or Soil type. Flow sensors aren't exposed this way. |
| Water Level | `HumiditySensor` | Optional. Shows the weather-adjusted watering percentage as a humidity reading. |

## Configuration

Configure via Homebridge Config UI X, or directly in `config.json`:

```json
{
  "platform": "OpenSprinkler",
  "name": "OpenSprinkler",
  "controllers": [
    {
      "name": "Sprinklers",
      "host": "192.168.1.100",
      "port": 80,
      "passwordHash": "<md5 hash of your admin password>",
      "rainDelay": { "enabled": true, "defaultHours": 24 },
      "programSwitches": false,
      "sensors": false,
      "waterLevel": false,
      "mqtt": {
        "enabled": false,
        "topicPrefix": "opensprinkler"
      }
    }
  ]
}
```

### Getting `passwordHash`

The plugin takes the **MD5 hash** of your controller's admin password, never
the plaintext password — the controller's own API only ever accepts the
hash anyway. Get it by opening the controller's web UI, logging in, then in
your browser's console running:

```js
localStorage.getItem('os_pw_hash')
```

Or compute it yourself: `echo -n "<password>" | md5` (macOS) /
`echo -n "<password>" | md5sum` (Linux).

### MQTT (optional, recommended)

If your controller has MQTT enabled (its own Options → MQTT settings, not
Homebridge's), set `mqtt.enabled: true` and `mqtt.topicPrefix` to match the
controller's configured publish topic prefix exactly. This gets you
near-instant updates for zone state, rain delay, and sensors instead of
waiting for the next poll.

## Development

```bash
npm install
npm run build
npm link
```

Add the plugin to `test/hbConfig/config.json` (gitignored — put your real
controller's host and password hash there), then:

```bash
homebridge -U ./test/hbConfig -D
```

`npm run watch` rebuilds and restarts on file changes (via `nodemon`).

### Releasing

Bump `version` in `package.json`, commit, then:

```bash
npm run release
```

This tags the commit, pushes the tag, creates a GitHub release with
generated notes, and publishes to npm — one command, so a release can't be
skipped.

## License

Apache-2.0
