import dgram from "dgram";

import { MeshThingModule } from "../../core/index.js";

const DEFAULT_PORT = 41234;
// A Tempest broadcasts every minute; well past that and we are reporting fiction
const STALE_AFTER_MS = 10 * 60 * 1000;

type WeatherConfig = {
  // UDP port the station broadcasts on
  port?: number;
  // How old a reading may be before it is reported as stale
  staleAfterMs?: number;
  // Only accept observations from this address. Unset accepts any host on the
  // network, which is what the station itself needs on day one -- the log
  // reports where readings are arriving from so this can be filled in.
  stationAddress?: string;
};

const weatherModule: MeshThingModule<WeatherConfig> = {
  name: "weather",
  description: "Live conditions from a Tempest weather station",

  create({ config, log }) {
    const staleAfterMs = config?.staleAfterMs ?? STALE_AFTER_MS;

    const data = {
      temperatureC: 0,
      temperatureF: 0,
      // Zero means nothing has arrived yet, which is not the same as 0 degrees
      lastUpdated: 0,
    };

    const stationAddress = config?.stationAddress;
    const server = dgram.createSocket("udp4");
    const seenSources = new Set<string>();
    let closed = false;

    if (!stationAddress) {
      log("accepting observations from any host on the network; set stationAddress once the log shows where they arrive from");
    }

    server.on("error", (error: Error) => {
      log(`socket error: ${error.message}`);

      if (!closed) {
        closed = true;
        server.close();
      }
    });

    server.on("message", (message, source) => {
      if (stationAddress && source.address !== stationAddress) {
        // Once per address, or a spoofer could fill the log as easily as the
        // readings it is trying to fake
        if (!seenSources.has(source.address)) {
          seenSources.add(source.address);
          log(`ignoring observations from ${source.address}: stationAddress is ${stationAddress}`);
        }

        return;
      }

      try {
        const parsed = JSON.parse(message.toString());

        if (parsed.type !== "obs_st") {
          return;
        }

        // Index 7 of the first observation is air temperature in Celsius. A
        // packet can be valid JSON of roughly the right shape and still not
        // have it -- `obs: [[]]` reads as undefined without throwing. Checking
        // here rather than at render keeps the last good reading instead of
        // poisoning it, and the staleness marker already reports honestly that
        // the reading is old.
        const celsius = parsed.obs?.[0]?.[7];

        if (!Number.isFinite(celsius)) {
          log(`ignored an observation with no usable temperature: ${JSON.stringify(celsius)}`);

          return;
        }

        if (!seenSources.has(source.address)) {
          seenSources.add(source.address);
          log(`observations arriving from ${source.address}`);
        }

        data.temperatureC = celsius;
        data.temperatureF = celsius * (9.0 / 5) + 32;
        data.lastUpdated = Date.now();
      } catch (error) {
        log(`ignored malformed broadcast: ${error}`);
      }
    });

    server.on("listening", () => {
      const address = server.address();

      log(`listening for weather broadcast on ${address.address}:${address.port}`);
    });

    server.bind(config?.port ?? DEFAULT_PORT);

    function temperature() {
      if (!data.lastUpdated) {
        return "No reading from the station yet";
      }

      const age = Date.now() - data.lastUpdated;
      const reading = `${data.temperatureC.toFixed(1)}°C / ${data.temperatureF.toFixed(1)}°F`;

      // Say so rather than quietly serving an old number
      return age > staleAfterMs ? `${reading} (${Math.floor(age / 60000)}m old)` : reading;
    }

    return {
      commands: [{ commandStrings: ["temperature", "temp", "t"], commandFunction: temperature }],
      // Idempotent: a supervisor may stop twice, and the error handler above
      // closes the socket on its own
      stop: () => {
        if (!closed) {
          closed = true;
          server.close();
        }
      },
    };
  },
};

export type { WeatherConfig };

export { weatherModule };
