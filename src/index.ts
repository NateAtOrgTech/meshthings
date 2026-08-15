import "dotenv/config";

import { directoryModule } from "./directory";
import { meshServer } from "./meshserver";
import { weatherModule } from "./weather";

// One radio, several meshthings. Modules are constructed by the core, so
// nothing sets up a socket or a database just by being imported.
await meshServer
  .start(process.env.SERIAL_DEVICE || "", [
    {
      module: weatherModule,
      config: { port: Number(process.env.WEATHER_STATION_PORT) || undefined },
    },
    {
      module: directoryModule,
      config: { database: process.env.DIRECTORY_DB },
    },
  ])
  .catch((error) => {
    console.error("Failed to start:", error);
    process.exit(1);
  });
