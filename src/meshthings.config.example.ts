// Upstream's reference configuration. Kept current as meshthings are added and
// as their options change.
//
// Do NOT edit this to configure your node -- edit meshthings.config.ts, which
// upstream will never touch. This file changes, and anything you put here will
// conflict the next time you pull.
//
// Copy the parts you want across.

import { MeshthingsConfig, openDatabase } from "./core/index.js";
import { alertsModule } from "./things/alerts/index.js";
import { directoryModule } from "./things/directory/index.js";
import { weatherModule } from "./things/weather/index.js";

function createExampleConfig(): MeshthingsConfig {
  const database = openDatabase(process.env.MESH_DB || "mesh.db");

  return {
    device: process.env.SERIAL_DEVICE || "",
    httpPort: Number(process.env.PORT) || undefined,

    // Core-wide behaviour. The defaults are sensible; these are the knobs.
    options: {
      // Seconds between transmissions. Airtime is shared with everyone on the
      // channel, so lowering this makes your node a worse neighbour.
      minSendIntervalMs: 4000,
      // Outbound messages held before the oldest low-priority one is dropped
      maxQueueLength: 100,
    },

    modules: [
      // Live conditions from a WeatherFlow Tempest broadcasting on the LAN.
      // Commands: t, temp, temperature
      {
        module: weatherModule,
        config: {
          port: 41234,
          // How old a reading may be before it is reported as stale
          staleAfterMs: 10 * 60 * 1000,
        },
      },

      // Registry of what is running on this mesh.
      // Commands: services, find, whois, register, unregister
      {
        module: directoryModule,
        config: { database },
      },

      // NOAA weather radio alerts pushed to subscribers.
      // Commands: subscribe, unsubscribe, status, alerts, receiver
      {
        module: alertsModule,
        config: {
          database,
          timeZone: "America/New_York",
          source: { command: "samedec", args: ["--rate", "22050", "-"] },
          areaNames: { "023005": "Cumberland", "023031": "York" },
          // Days without a weekly test before `receiver` reports STALE
          testIntervalDays: 8,
        },
      },

      // Two meshthings cannot claim the same command word -- startup fails and
      // names both. Resolve it here, without patching either module:
      //
      //   { module: someModule, rename: { status: "otherstatus" } }
      //   { module: someModule, prefix: "wx" }        // status -> wxstatus
      //   { module: someModule, disable: ["status"] }
    ],
  };
}

export { createExampleConfig };
