import "dotenv/config";

import { alertsModule } from "./things/alerts/index.js";
import { openDatabase } from "./db.js";
import { directoryModule } from "./things/directory/index.js";
import { meshServer } from "./meshserver.js";
import { weatherModule } from "./things/weather/index.js";

// One radio, several meshthings. Modules are constructed by the core, so
// nothing sets up a socket, a database, or a child process just by being imported.
const database = openDatabase(process.env.MESH_DB || "mesh.db");

await meshServer
  .start(process.env.SERIAL_DEVICE || "", [
    {
      module: weatherModule,
      config: { port: Number(process.env.WEATHER_STATION_PORT) || undefined },
    },
    {
      module: directoryModule,
      config: { database },
    },
    {
      module: alertsModule,
      config: {
        database,
        // The decoder pipeline is site-specific: your SDR, your local NWR
        // frequency. Unset means subscriptions work but nothing is received.
        source: process.env.SAME_DECODER_COMMAND
          ? { command: process.env.SAME_DECODER_COMMAND, args: (process.env.SAME_DECODER_ARGS || "").split(" ").filter(Boolean) }
          : undefined,
        timeZone: process.env.TIME_ZONE || "America/New_York",
        areaNames: { "023005": "Cumberland", "023031": "York" },
      },
    },
  ])
  .catch((error) => {
    console.error("Failed to start:", error);
    process.exit(1);
  });
