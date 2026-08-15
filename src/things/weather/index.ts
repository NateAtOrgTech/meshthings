import dgram from "dgram";

import { MeshThingModule } from "../../meshthing.js";

const DEFAULT_PORT = 41234;
// A Tempest broadcasts every minute; well past that and we are reporting fiction
const STALE_AFTER_MS = 10 * 60 * 1000;

type WeatherConfig = {
  // UDP port the station broadcasts on
  port?: number;
  // How old a reading may be before it is reported as stale
  staleAfterMs?: number;
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

    const server = dgram.createSocket("udp4");
    let closed = false;

    server.on("error", (error: Error) => {
      log(`socket error: ${error.message}`);

      if (!closed) {
        closed = true;
        server.close();
      }
    });

    server.on("message", (message) => {
      try {
        const parsed = JSON.parse(message.toString());

        if (parsed.type === "obs_st") {
          data.temperatureC = parsed.obs[0][7];
          data.temperatureF = data.temperatureC * (9.0 / 5) + 32;
          data.lastUpdated = Date.now();
        }
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
