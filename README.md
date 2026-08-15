# meshthings

Services for a [Meshtastic](https://meshtastic.org) mesh, hosted on a computer attached to a node.

A Meshtastic radio can carry text between people who have no internet. This turns one of those radios into something people can *ask questions of*: send `t` and get the current temperature from a real weather station, send `services` to find out what else is on the mesh, send `subscribe` and get tornado warnings pushed to you. None of it touches the internet at any point.

The tradeoff is that it does not run on the radio. It runs on a computer next to one — a Pi is plenty — because the useful sources of data are a UDP broadcast from a weather station, a file on disk, a radio receiver on USB. Firmware cannot reach any of those.

## How it works

```
        Tempest station          NOAA weather radio
        (UDP on the LAN)         (SDR + SAME decoder)
                 |                        |
                 v                        v
        +--------------------------------------------+
        |  weather      directory      alerts   ...   |   things/
        +--------------------------------------------+
        |                  core                       |   command routing,
        |    routing | outbound queue | database      |   paced sending
        +--------------------------------------------+
                             |
                        serial / TCP
                             |
                      Meshtastic node  ))))  the mesh
```

**Several things share one radio.** You have one node, so `t` reaches the weather thing, `services` reaches the directory, and `subscribe` reaches the alerts thing, all on the same device and the same process.

**Everything outbound is paced.** Airtime is shared by everyone on the channel. A warning going out to forty subscribers would jam the mesh for everybody at the exact moment it matters most, so all transmissions — replies included — go through one queue that spaces them out. Life-safety alerts jump that queue; watches and routine chatter do not.

**Replies must fit one packet.** A Meshtastic text message tops out around 200 bytes. Listings paginate (`services 2`) rather than being cut off.

## What's included

| Thing | Commands | Needs |
| --- | --- | --- |
| **weather** | `t`, `temp`, `temperature` | A WeatherFlow Tempest broadcasting on your LAN |
| **directory** | `services`, `find`, `whois`, `register`, `unregister` | Nothing |
| **alerts** | `subscribe`, `unsubscribe`, `status`, `alerts`, `receiver` | An SDR and a SAME decoder |

Plus built-ins on every node: `ping`, `help`, and `sys` / `sys stats` / `sys modules` for version, uptime, and traffic counters.

### weather

Listens for the UDP broadcast a Tempest station puts on the local network and answers with the current temperature. Says so when it has no reading rather than reporting a default, and marks a reading with its age once it goes stale — a Tempest broadcasts every minute, so silence means something is wrong.

### directory

A registry of what is on your mesh. Anyone can `register tides Tide times for Casco Bay`, and anyone can `find tide` or `whois tides` to get the node number to message. Names are first-come and self-reported, which is fine among neighbours and a squatting vector if it ever goes wide.

### alerts

Decodes NOAA Weather Radio SAME headers from an SDR and pushes warnings to nodes that asked for them, filtered by county.

SAME carries the *classification* of an alert — event code, areas, duration — but never the words being spoken, which are voice audio. So messages are assembled from codes rather than summarised from prose, which is why they fit a packet comfortably.

Two details worth knowing:

- **The scheduled tests never reach the mesh.** NOAA transmits a required weekly test. Relaying it would train people to ignore the channel. Their timestamps are kept instead, so `receiver` can report `STALE` when tests stop arriving — otherwise silence from an alerting system is indistinguishable from "no emergencies".
- **Repeats are suppressed across restarts.** Each alert is transmitted three times for error correction, and the deduplication is stored in the database so a crash loop cannot re-broadcast a live warning to everyone on every restart.

## Getting started

### Requirements

- **Node 22.13 or newer.** SQLite is built in from here, with no flag and nothing to compile. Earlier 22.x may need `--experimental-sqlite`.
- **A Meshtastic node on USB.** Serial today; the core accepts any transport, and `@meshtastic/transport-http` works over wifi.
- Optional: a Tempest station on the same LAN, for the weather thing.
- Optional: an RTL-SDR and a SAME decoder, for alerts.

### Install and run

```bash
npm install
```

```bash
cp .env.example .env
```

Edit `.env` — at minimum set `SERIAL_DEVICE` to your node. On macOS it looks like `/dev/cu.usbmodem…`; on Linux, `/dev/ttyUSB0` or `/dev/ttyACM0`. Find it with:

```bash
ls /dev/cu.usbmodem* /dev/ttyUSB* /dev/ttyACM* 2>/dev/null
```

Then, for development with reload on change:

```bash
npm run dev
```

Or build and run:

```bash
npm run build && npm start
```

You should see `Config complete`, `Event registration complete`, and a line per thing that started. Send `ping` to the node from another Meshtastic device; it replies `pong`. Send `help` to see everything mounted.

### Configuration

Two layers. Secrets and machine-specific paths go in `.env`; which things run and how they behave is in `src/index.ts`.

| Variable | Default | What it does |
| --- | --- | --- |
| `SERIAL_DEVICE` | *(required)* | Serial path of the Meshtastic node |
| `PORT` | — | Port for the local HTTP stats page |
| `WEATHER_STATION_PORT` | `41234` | UDP port the Tempest broadcasts on |
| `MESH_DB` | `mesh.db` | SQLite file for the directory and subscribers |
| `TIME_ZONE` | `America/New_York` | IANA zone for rendering alert expiry times |
| `SAME_DECODER_COMMAND` | *(unset)* | Decoder to spawn. **Unset means no alerts are received.** |
| `SAME_DECODER_ARGS` | — | Space-separated arguments for it |

Which things run is a list in [src/index.ts](src/index.ts):

```ts
await meshServer.start(process.env.SERIAL_DEVICE || "", [
  { module: weatherModule, config: { port: 41234 } },
  { module: directoryModule, config: { database } },
  { module: alertsModule, config: { database, areaNames: { "023005": "Cumberland" } } },
]);
```

Delete an entry to stop running that thing. `areaNames` maps the FIPS county codes your mesh covers to readable names — anything unlisted falls back to its raw code, so only list the counties you care about.

If two things want the same command word, startup fails and tells you which two. Resolve it in the deployment without touching either module:

```ts
{ module: alertsModule, rename: { status: "alertstatus" } }
{ module: directoryModule, prefix: "dir" }   // services -> dirservices
{ module: alertsModule, disable: ["status"] }
```

### Setting up alerts

The alerts thing reads lines from a decoder process. The pipeline is site-specific — your SDR, your local NWR frequency, one of the seven channels between 162.400 and 162.550 MHz. Point `SAME_DECODER_COMMAND` at something that emits decoded SAME headers on stdout; [`samedec`](https://github.com/cbs228/sameold), `multimon-ng`, and `dsame` are the usual candidates.

Then subscribe from a node, with the FIPS codes for your counties:

```
subscribe 023005 023031
```

Send `receiver` to check the receive chain is alive. It reports `STALE` if the weekly test has not arrived in eight days.

> **This is a best-effort relay, not an official alerting channel.** It depends on your receiver, your gateway staying powered, and the mesh reaching the recipient. Say so to anyone who subscribes — people should not drop their other warning sources because of it.

## Writing a meshthing

A thing is an object with a name, a description, and a `create()` that returns its commands:

```ts
const tidesModule: MeshThingModule<TidesConfig> = {
  name: "tides",
  description: "Tide times for the bay",
  create({ config, send, log }) {
    return {
      commands: [{ commandStrings: ["tides", "tide"], commandFunction: () => "High 14:05, low 20:22" }],
      stop: () => {},
    };
  },
};
```

`create()` receives `send` and `sendMany`, so a thing can transmit on its own schedule rather than only in reply — that is what the alerts thing uses. It can be async, and `stop()` releases sockets, child processes, and file handles.

See [docs/writing-a-meshthing.md](docs/writing-a-meshthing.md) for the full contract, the byte budget, and how to test without a radio.

## Testing

```bash
npm test
```

209 tests, no test framework beyond what Node ships. They run without a radio: `src/testing.ts` provides a device-level fake that records what was transmitted, injects inbound messages, and lets tests assert on pacing and priority.

This is deliberately *not* a `Transport`-level mock. Mocking there means hand-building protobuf frames, which tests Meshtastic's plumbing rather than your commands.

## Deployment

A gateway should survive reboots. A minimal systemd unit:

```ini
[Unit]
Description=meshthings
After=network-online.target

[Service]
WorkingDirectory=/home/pi/meshthings
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10
User=pi

[Install]
WantedBy=multi-user.target
```

The user running it needs access to the serial device — on most Linux distributions that means membership of the `dialout` group.

## Known limitations

- **The SAME parser has not been run against real decoder output.** The line handling around it is tested, but confirm the exact format your decoder emits before relying on the alerts thing.
- **Node prints an `ExperimentalWarning` for `node:sqlite`.** Harmless, and worth knowing about before you deploy for other people.
- **Configuration lives in `src/index.ts`**, which upstream also edits. If you fork and customise it there, every upstream merge will conflict in that file. Moving the deployment's module list into a file upstream never touches is a planned change.
- **The directory has no trust model.** Anyone can register anything, and names are first-come.

## Licence

MIT. See [LICENSE](LICENSE).
