import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import dgram from "dgram";

import { createConfig } from "./meshthings.config.js";
import { createExampleConfig } from "./meshthings.config.example.js";
import { createMeshThing, MeshThing } from "./meshthing.js";
import { createFakeDevice } from "./testing.js";

// The deployment's own configuration, mounted for real. A command collision or
// a broken module config fails startup, and finding that here beats finding it
// on a node in a field.

const running: MeshThing[] = [];

after(async () => {
  for (const thing of running) {
    await thing.stop();
  }
});

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const probe = dgram.createSocket("udp4");

    probe.on("error", reject);
    probe.bind(0, () => {
      const { port } = probe.address();

      probe.close(() => resolve(port));
    });
  });
}

// Point the config at throwaway resources rather than the real database and
// the real weather station port
async function withTestEnvironment<T>(run: () => T): Promise<T> {
  const saved = { ...process.env };

  process.env.MESH_DB = ":memory:";
  process.env.WEATHER_STATION_PORT = String(await freePort());
  delete process.env.SAME_DECODER_COMMAND;

  try {
    return run();
  } finally {
    process.env = saved;
  }
}

async function mountConfigured() {
  const config = await withTestEnvironment(() => createConfig());
  const fake = createFakeDevice();
  const thing = createMeshThing({ minSendIntervalMs: 0 });

  await thing.listen(fake.device, config.modules);
  running.push(thing);

  async function ask(text: string) {
    const before = fake.sent.length;

    fake.receive(text);

    return (await fake.waitForSends(before + 1))[before].text;
  }

  return { config, thing, ask };
}

describe("the deployment configuration", () => {
  test("mounts every configured meshthing without a collision", async () => {
    const { thing } = await mountConfigured();

    assert.deepEqual(thing.getModules(), ["weather", "directory", "alerts"]);
  });

  test("routes a command to each of them", async () => {
    const { ask } = await mountConfigured();

    assert.match(await ask("t"), /No reading from the station yet/);
    assert.match(await ask("services"), /No services registered/);
    assert.match(await ask("receiver"), /not configured|No weekly test/);
  });

  test("answers the built-ins too", async () => {
    const { ask } = await mountConfigured();

    assert.equal(await ask("ping"), "pong");
    assert.match(await ask("sys"), /meshthings/);
  });

  test("puts the built-ins on the first page of help", async () => {
    const { ask } = await mountConfigured();

    const first = await ask("help");

    // Whatever else is mounted, `ping` and `sys` stay reachable without paging
    assert.match(first, /core: help/);
  });

  test("lists every mounted thing across the help pages", async () => {
    const { ask } = await mountConfigured();

    const help = (await ask("help")) + "\n" + (await ask("help 2"));

    ["core", "weather", "directory", "alerts"].forEach((name) => {
      assert.ok(help.includes(name), `help omitted ${name}: ${help}`);
    });
  });

  test("takes the device from the environment", async () => {
    const saved = process.env.SERIAL_DEVICE;

    process.env.SERIAL_DEVICE = "/dev/ttyTEST";

    const config = await withTestEnvironment(() => createConfig());

    assert.equal(config.device, "/dev/ttyTEST");

    process.env.SERIAL_DEVICE = saved;
  });
});

describe("the example configuration", () => {
  // Not mounted -- it names a decoder command that would be spawned. This
  // checks it still compiles against the current module options and has not
  // drifted from what it is documenting.
  test("still describes the meshthings that exist", async () => {
    const config = await withTestEnvironment(() => createExampleConfig());

    const names = config.modules.map((spec) => ("module" in spec ? spec.module.name : spec.name));

    assert.deepEqual(names, ["weather", "directory", "alerts"]);
  });
});
