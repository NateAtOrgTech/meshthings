// ============================================================================
//  THIS FILE IS YOURS.
//
//  Upstream created it once and will never modify it again. That is the whole
//  point: if you fork this repo and describe your node here, `git merge
//  upstream` can never conflict with your configuration, because upstream
//  never has a competing version of this file to merge.
//
//  Edit it, commit it to your fork, and pull upstream changes freely.
//
//  meshthings.config.example.ts is upstream's and is kept current as things
//  are added -- read it for what is available, but do not rely on it, because
//  it does change.
// ============================================================================

import { MeshthingsConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { alertsModule } from "./things/alerts/index.js";
import { directoryModule } from "./things/directory/index.js";
import { weatherModule } from "./things/weather/index.js";

// A function rather than a constant so that importing this file opens no
// sockets and no databases -- nothing happens until the node actually starts.
function createConfig(): MeshthingsConfig {
  // The directory and the alert subscriptions share one file
  const database = openDatabase(process.env.MESH_DB || "mesh.db");

  return {
    device: process.env.SERIAL_DEVICE || "",
    httpPort: Number(process.env.PORT) || undefined,

    modules: [
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
          timeZone: process.env.TIME_ZONE || "America/New_York",

          // The decoder pipeline is site-specific: your SDR, your local NOAA
          // weather radio frequency. Leaving it unset means subscriptions work
          // but no alert is ever received -- `receiver` reports that.
          source: process.env.SAME_DECODER_COMMAND
            ? {
                command: process.env.SAME_DECODER_COMMAND,
                args: (process.env.SAME_DECODER_ARGS || "").split(" ").filter(Boolean),
              }
            : undefined,

          // The counties this mesh covers. Anything unlisted falls back to its
          // raw FIPS code, so list only what you care about.
          areaNames: {
            "023005": "Cumberland",
            "023031": "York",
          },
        },
      },
    ],
  };
}

export { createConfig };
