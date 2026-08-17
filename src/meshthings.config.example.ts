// Upstream's reference configuration. Kept current as meshthings are added and
// as their options change.
//
// Do NOT edit this to configure your node -- edit meshthings.config.ts, which
// upstream will never touch. This file changes, and anything you put here will
// conflict the next time you pull.
//
// Copy the parts you want across.

import { commandsModule, createUsageLog, MeshthingsConfig, openDatabase } from "./core/index.js";
import { alertsModule } from "./things/alerts/index.js";
import { directoryModule } from "./things/directory/index.js";
import { weatherModule } from "./things/weather/index.js";

function createExampleConfig(): MeshthingsConfig {
  const database = openDatabase(process.env.MESH_DB || "mesh.db");

  return {
    device: process.env.SERIAL_DEVICE || "",

    // How to reach the radio. Omitted means serial, which is what most nodes
    // are. For a node on wifi, install @meshtastic/transport-http and supply:
    //
    //   connect: async (address) =>
    //     new MeshDevice(await TransportHttp.create(address)),
    //
    // Nothing above this line is serial-specific; the transport is a choice.
    httpPort: Number(process.env.PORT) || undefined,

    // Keeps a record of what the node is used for, so you can tell whether a
    // meshthing earns its keep. Omit it entirely and nothing is written down.
    //
    // Counting reach means storing the node numbers of everyone who sends a
    // command -- not just people who opted into anything. Retention is the
    // control that makes that proportionate; hashing the numbers would not,
    // since the space is small enough to reverse in seconds.
    usage: createUsageLog({ database, retentionDays: 90 }),

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
          port: 50222,
          // How old a reading may be before it is reported as stale
          staleAfterMs: 10 * 60 * 1000,
          // Only accept readings from the station itself. Leave unset at first;
          // the log reports where observations arrive from.
          stationAddress: "192.168.1.50",
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
          // Most subscribers one alert is sent to. Sends are paced, so this is
          // really a channel-time budget: 40 is under three minutes of
          // transmitting. Past it, recipients are dropped and the log says so.
          maxRecipients: 40,
        },
      },

      // Commands that are only about this node, and are nobody else's business
      // to package. commandsModule is for exactly this: a list of commands with
      // no config to receive and nothing to clean up. Anything that opens a
      // socket, reads config, or needs tearing down wants the full module form,
      // because create() is where those belong.
      commandsModule("local", "About this node", [
        {
          commandStrings: ["owner", "who"],
          commandFunction: () => "Nate, Freeport ME. Solar, up 24/7. Reply here or find me on the tides net.",
        },
        {
          commandStrings: ["location", "qth"],
          commandFunction: () => "Bradbury Mtn, 43.90N 70.18W, ~150m ASL",
        },
      ]),

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
