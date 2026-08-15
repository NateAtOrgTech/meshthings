import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import dgram from "dgram";

import { alertsModule } from "./things/alerts/index";
import { openDatabase } from "./db";
import { directoryModule } from "./things/directory/index";
import { createMeshThing, MAX_TEXT_BYTES, MeshThing } from "./meshthing";
import { createFakeDevice } from "./testing";
import { weatherModule } from "./things/weather/index";

// The deployment shape: every meshthing on one radio, one database
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

async function setup() {
  const database = openDatabase(":memory:");
  const fake = createFakeDevice();
  const thing = createMeshThing({ minSendIntervalMs: 0 });

  let emit: ((line: string) => void) | undefined;

  await thing.listen(fake.device, [
    { module: weatherModule, config: { port: await freePort() } },
    { module: directoryModule, config: { database } },
    {
      module: alertsModule,
      config: {
        database,
        source: {
          start(onLine: (line: string) => void) {
            emit = onLine;
          },
        },
        timeZone: "UTC",
        areaNames: { "023005": "Cumberland" },
      },
    },
  ]);

  running.push(thing);

  async function ask(text: string, from = 0x1000) {
    const before = fake.sent.length;

    fake.receive(text, { from });

    const reply = (await fake.waitForSends(before + 1))[before].text;

    assert.ok(Buffer.byteLength(reply, "utf8") <= MAX_TEXT_BYTES, `reply too long: ${reply}`);

    return reply;
  }

  return { thing, fake, ask, decode: (line: string) => emit?.(line) };
}

describe("all three meshthings on one node", () => {
  test("mounts without a command collision", async () => {
    const { thing } = await setup();

    assert.deepEqual(thing.getModules(), ["weather", "directory", "alerts"]);
  });

  test("routes each command to the right module", async () => {
    const { ask } = await setup();

    assert.match(await ask("t"), /No reading from the station yet/);
    assert.match(await ask("services"), /No services registered/);
    assert.match(await ask("receiver"), /No weekly test seen yet/);
  });

  test("lists every module in one help reply", async () => {
    const { ask } = await setup();

    const help = await ask("help");

    assert.match(help, /weather/);
    assert.match(help, /directory/);
    assert.match(help, /alerts/);
  });

  test("shares one database between directory and alerts", async () => {
    const { ask } = await setup();

    await ask("register tides Tide times for Casco Bay", 111);
    await ask("subscribe 023005", 111);

    assert.match(await ask("whois tides"), /Tide times/);
    assert.match(await ask("status", 111), /Subscribed to weather alerts/);
  });

  test("pushes an alert while still answering commands", async () => {
    const { ask, fake, decode } = await setup();

    await ask("subscribe 023005", 111);
    fake.clear();

    decode("ZCZC-WXR-TOR-023005+0100-1232115-KGYX/NWS-");

    const [alert] = await fake.waitForSends(1);

    assert.match(alert.text, /Tornado Warning: Cumberland/);
    assert.equal(alert.to, 111);

    // The node is still a command responder after pushing
    assert.match(await ask("t"), /No reading/);
  });
});
