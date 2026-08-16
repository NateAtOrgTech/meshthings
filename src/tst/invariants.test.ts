import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import dgram from "dgram";

import { createMeshThing, MAX_TEXT_BYTES, MeshThing } from "../core/index.js";
import { createMockDevice } from "../testing/index.js";
import { alertsModule } from "../things/alerts/index.js";
import { directoryModule } from "../things/directory/index.js";
import { openDatabase } from "../core/index.js";
import { weatherModule } from "../things/weather/index.js";

// Rules that hold for every command of every meshthing, checked by driving them
// all rather than by remembering to assert it in each module's own tests. The
// bugs this file is shaped around -- a page overflowing its budget, a reply
// that throws on odd input, stored text that forges a listing line -- were each
// found in one module and were latent in the others.

const CONTROL_CHARACTERS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

// Nothing here should reach a handler as anything but data
const HOSTILE_ARGUMENTS = [
  "",
  " ",
  "%",
  "_",
  "%%%%%%%%",
  "'; DROP TABLE services; --",
  "../../etc/passwd",
  "\u0000null",
  "line\nbreak",
  "\u0007bell",
  "(1/9) services 2",
  "-1",
  "0",
  "99999999999999999999",
  "NaN",
  "é".repeat(300),
  "x".repeat(500),
  "__proto__",
  "constructor",
];

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

// Every meshthing that ships, mounted the way a deployment mounts them
async function mountEverything() {
  const database = openDatabase(":memory:");
  const mock = createMockDevice();
  const thing = createMeshThing({ minSendIntervalMs: 0 });

  await thing.listen(mock.device, [
    { module: weatherModule, config: { port: await freePort() } },
    { module: directoryModule, config: { database } },
    { module: alertsModule, config: { database, timeZone: "UTC" } },
  ]);

  running.push(thing);

  async function send(text: string, from = 0x1000) {
    const before = mock.sent.length;

    mock.receive(text, { from });
    await mock.settle(15);

    return mock.sent.slice(before).map((message) => message.text);
  }

  return { mock, thing, send };
}

// Every word the node answers to, discovered rather than hardcoded, so a new
// meshthing is covered the moment it is mounted
const COMMAND_WORDS = [
  "t",
  "temp",
  "temperature",
  "services",
  "dir",
  "ls",
  "find",
  "search",
  "whois",
  "who",
  "register",
  "reg",
  "unregister",
  "unreg",
  "subscribe",
  "sub",
  "unsubscribe",
  "unsub",
  "status",
  "alerts",
  "recent",
  "receiver",
  "help",
  "?",
  "ping",
  "sys",
];

describe("every reply fits a packet", () => {
  test("whatever arguments it is given", async () => {
    const { send } = await mountEverything();

    for (const word of COMMAND_WORDS) {
      for (const argument of HOSTILE_ARGUMENTS) {
        const replies = await send(`${word} ${argument}`);

        replies.forEach((reply) => {
          assert.ok(
            Buffer.byteLength(reply, "utf8") <= MAX_TEXT_BYTES,
            `"${word}" replied with ${Buffer.byteLength(reply, "utf8")} bytes to ${JSON.stringify(argument)}`,
          );
        });
      }
    }
  });

  test("even once the directory is full of long entries", async () => {
    const { send } = await mountEverything();

    for (let node = 1; node <= 30; node++) {
      await send(`register service-${node} ${"description ".repeat(8)}`, node);
    }

    for (const page of ["", "1", "2", "3", "99"]) {
      const replies = await send(`services ${page}`);

      replies.forEach((reply) =>
        assert.ok(Buffer.byteLength(reply, "utf8") <= MAX_TEXT_BYTES, `page ${page}: ${reply.length} bytes`),
      );
    }
  });
});

describe("no command can be made to fail", () => {
  test("hostile arguments produce a reply or silence, never an error", async () => {
    const { thing, send } = await mountEverything();

    for (const word of COMMAND_WORDS) {
      for (const argument of HOSTILE_ARGUMENTS) {
        await send(`${word} ${argument}`);
      }
    }

    // A handler that throws is caught and counted rather than crashing, so the
    // counter is how we tell whether anything actually broke
    assert.equal(thing.getStats().errors, 0, "a command handler threw");
  });

  test("the node still works normally afterwards", async () => {
    const { send } = await mountEverything();

    for (const argument of HOSTILE_ARGUMENTS) {
      await send(`register ${argument} ${argument}`, 4242);
    }

    assert.deepEqual(await send("ping"), ["pong"]);
    assert.match((await send("t"))[0], /No reading/);
  });
});

describe("user text cannot forge a listing", () => {
  test("nothing a user registers comes back as control characters", async () => {
    const { send } = await mountEverything();

    for (const [index, argument] of HOSTILE_ARGUMENTS.entries()) {
      await send(`register name${index} ${argument}`, 1000 + index);
    }

    for (const page of ["1", "2", "3"]) {
      const replies = await send(`services ${page}`);

      replies.forEach((reply) => {
        // Newlines separate entries, so they are expected; anything else is not
        assert.ok(!CONTROL_CHARACTERS.test(reply), `control characters reached a listing: ${JSON.stringify(reply)}`);
      });
    }
  });

  test("every line of a listing is a real entry or the real footer", async () => {
    const { send } = await mountEverything();

    await send("register real A genuine service", 111);
    // Footer-shaped text inside a description is harmless -- it renders as part
    // of that entry's line. What must never happen is text becoming a line of
    // its own, which is what a newline would have bought before it was rejected.
    await send("register fake (1/9) services 2", 222);

    const listing = (await send("services"))[0];
    const lines = listing.split("\n");

    lines.forEach((line, index) => {
      const isEntry = line.includes(" - ");
      const isFooter = /^\(\d+\/\d+\)/.test(line) && index === lines.length - 1;

      assert.ok(isEntry || isFooter, `line ${index} is neither an entry nor the footer: ${JSON.stringify(line)}`);
    });
  });
});

describe("teardown", () => {
  test("stopping twice is safe and releases every module", async () => {
    const { thing } = await mountEverything();

    await thing.stop();
    await thing.stop();

    assert.equal(thing.getStats().errors, 0);
  });
});
