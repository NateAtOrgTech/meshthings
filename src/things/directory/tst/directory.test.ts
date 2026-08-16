import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { createDirectory } from "../index.js";
import { commandsModule, createMeshThing, MAX_TEXT_BYTES } from "../../../core/index.js";
import { createMockDevice } from "../../../testing/index.js";

// Driven through a real meshthing rather than by calling handlers directly, so
// these also cover routing, argument splitting, and the outbound byte cap.
async function setup() {
  const fake = createMockDevice();
  const thing = createMeshThing({ minSendIntervalMs: 0 });

  await thing.listen(fake.device, [
    commandsModule("directory", "Registry of services", createDirectory(":memory:")),
  ]);

  async function ask(text: string, from = 0x1000) {
    const before = fake.sent.length;

    fake.receive(text, { from });

    const sent = await fake.waitForSends(before + 1);
    const reply = sent[before].text;

    // Every reply must fit a packet -- asserted on all of them, everywhere
    assert.ok(
      Buffer.byteLength(reply, "utf8") <= MAX_TEXT_BYTES,
      `reply exceeded ${MAX_TEXT_BYTES} bytes: ${reply}`,
    );

    return reply;
  }

  return { fake, thing, ask };
}

async function seed(ask: (text: string, from?: number) => Promise<string>) {
  await ask("register tides Tide times for Casco Bay", 111);
  await ask("register repeater Solar repeater on Bradbury Mtn", 222);
  await ask("register pager Relay SMS to the outside world", 333);
  await ask("register riverlevel Presumpscot river gauge readings", 444);
  await ask("register weather Live temp from a Tempest station", 555);
}

describe("registration", () => {
  test("registers a service to the calling node", async () => {
    const { ask } = await setup();

    const reply = await ask("register tides Tide times for Casco Bay", 111);

    assert.match(reply, /Registered "tides"/);
    // 111 decimal renders as the meshtastic node id !0000006f
    assert.match(reply, /!0000006f/);
  });

  test("requires both a name and a description", async () => {
    const { ask } = await setup();

    assert.match(await ask("register"), /Usage/);
    assert.match(await ask("register tides"), /Usage/);
  });

  test("rejects a name already held by another node", async () => {
    const { ask } = await setup();

    await ask("register tides Tide times", 111);

    const reply = await ask("register tides my own tides", 222);

    assert.match(reply, /already registered by !0000006f/);
  });

  test("treats name collisions case-insensitively", async () => {
    const { ask } = await setup();

    await ask("register tides Tide times", 111);

    assert.match(await ask("register TIDES something else", 222), /already registered/);
  });

  test("lets a node update its own listing", async () => {
    const { ask } = await setup();

    await ask("register tides Tide times", 111);
    await ask("register tides Now with currents", 111);

    assert.match(await ask("whois tides"), /Now with currents/);
  });

  test("lets a node rename its own service", async () => {
    const { ask } = await setup();

    await ask("register tides Tide times", 111);
    await ask("register currents Current times", 111);

    assert.match(await ask("whois tides"), /No service named/);
    assert.match(await ask("whois currents"), /Current times/);
  });

  test("holds one listing per node", async () => {
    const { ask } = await setup();

    await ask("register tides Tide times", 111);
    await ask("register currents Current times", 111);

    const listing = await ask("services");

    assert.ok(!listing.includes("tides"));
    assert.ok(listing.includes("currents"));
  });

  test("rejects a name with characters that are unsafe to render", async () => {
    const { ask } = await setup();

    // A newline inside a token survives tokenisation, and would forge an extra
    // line in every future listing
    assert.match(await ask("register tides\nbogus Tide times"), /may only contain/);
    assert.match(await ask("register tides! Tide times"), /may only contain/);
    assert.match(await ask("register ti/des Tide times"), /may only contain/);
  });

  test("rejects a description containing control characters", async () => {
    const { ask } = await setup();

    // Would render as a second entry, or as a convincing pagination footer
    assert.match(await ask("register tides Tide times\ncurrents - Current times"), /line breaks/);
    assert.match(await ask("register tides Tide times\u0007bell"), /control characters/);
  });

  test("still accepts ordinary names and descriptions", async () => {
    const { ask } = await setup();

    assert.match(await ask("register river-gauge Presumpscot river levels", 111), /Registered/);
    assert.match(await ask("register wx_1 Live temp, wind and rain (Tempest)", 222), /Registered/);
  });

  test("keeps forged text out of the listing entirely", async () => {
    const { ask } = await setup();

    await ask("register real Genuine service", 111);
    await ask("register fake Something\n(1/9) services 2", 222);

    const listing = await ask("services");

    assert.ok(!listing.includes("(1/9)"), `forged footer reached the listing: ${listing}`);
    assert.ok(!listing.includes("fake"), `rejected registration was stored: ${listing}`);
  });

  test("rejects an overlong name", async () => {
    const { ask } = await setup();

    assert.match(await ask(`register ${"n".repeat(40)} something`), /Name too long/);
  });

  test("truncates an overlong description", async () => {
    const { ask } = await setup();

    await ask(`register verbose ${"word ".repeat(60)}`, 111);

    const reply = await ask("whois verbose");

    assert.ok(reply.includes("…"));
  });
});

describe("unregistration", () => {
  test("removes the caller's listing", async () => {
    const { ask } = await setup();

    await ask("register tides Tide times", 111);

    assert.match(await ask("unregister", 111), /Removed/);
    assert.match(await ask("whois tides"), /No service named/);
  });

  test("is harmless when there is nothing to remove", async () => {
    const { ask } = await setup();

    assert.match(await ask("unregister", 111), /no listing/);
  });

  test("only removes the caller's own listing", async () => {
    const { ask } = await setup();

    await ask("register tides Tide times", 111);
    await ask("unregister", 222);

    assert.match(await ask("whois tides"), /Tide times/);
  });
});

describe("listing", () => {
  test("explains how to register when empty", async () => {
    const { ask } = await setup();

    assert.match(await ask("services"), /No services registered/);
  });

  test("lists services alphabetically", async () => {
    const { ask } = await setup();

    await ask("register zulu Last one", 111);
    await ask("register alpha First one", 222);

    const listing = await ask("services");

    assert.ok(listing.indexOf("alpha") < listing.indexOf("zulu"));
  });

  test("paginates once a listing outgrows one packet", async () => {
    const { ask } = await setup();

    await seed(ask);

    const first = await ask("services");

    assert.match(first, /\(1\/2\) services 2/);

    const second = await ask("services 2");

    assert.match(second, /\(2\/2\)/);
  });

  test("covers every service across its pages", async () => {
    const { ask } = await setup();

    await seed(ask);

    const combined = (await ask("services")) + (await ask("services 2"));

    ["tides", "repeater", "pager", "riverlevel", "weather"].forEach((name) => {
      assert.ok(combined.includes(name), `missing ${name}`);
    });
  });

  test("clamps an out-of-range page", async () => {
    const { ask } = await setup();

    await seed(ask);

    assert.match(await ask("services 99"), /\(2\/2\)/);
    assert.match(await ask("services 0"), /\(1\/2\)/);
    assert.match(await ask("services banana"), /\(1\/2\)/);
  });

  test("answers to its aliases", async () => {
    const { ask } = await setup();

    await ask("register tides Tide times", 111);

    assert.ok((await ask("dir")).includes("tides"));
    assert.ok((await ask("ls")).includes("tides"));
  });
});

describe("search", () => {
  test("matches on description as well as name", async () => {
    const { ask } = await setup();

    await seed(ask);

    assert.ok((await ask("find Bradbury")).includes("repeater"));
    assert.ok((await ask("find riverlevel")).includes("riverlevel"));
  });

  test("reports when nothing matches", async () => {
    const { ask } = await setup();

    await seed(ask);

    assert.match(await ask("find nonsense"), /Nothing matches/);
  });

  test("never tells the reader to send a command that searches instead of pages", async () => {
    const { ask } = await setup();

    await seed(ask);

    const matches = await ask("find e");

    // "find 2" would search for "2". If the footer said that, following it
    // would silently take the reader somewhere else entirely.
    assert.ok(!/find \d/.test(matches), `misleading footer: ${matches}`);
  });

  test("says how to get fewer results when there are too many to show", async () => {
    const { ask } = await setup();

    await seed(ask);

    assert.match(await ask("find e"), /narrow the search/);
  });

  test("shows a single match without any paging noise", async () => {
    const { ask } = await setup();

    await ask("register tides Tide times for Casco Bay", 111);

    const reply = await ask("find tides");

    assert.match(reply, /tides - Tide times/);
    assert.ok(!reply.includes("("), `unexpected footer: ${reply}`);
  });

  test("requires a term", async () => {
    const { ask } = await setup();

    assert.match(await ask("find"), /Usage/);
  });
});

describe("whois", () => {
  test("returns the node id and description", async () => {
    const { ask } = await setup();

    await ask("register tides Tide times for Casco Bay", 111);

    const reply = await ask("whois tides");

    assert.match(reply, /!0000006f/);
    assert.match(reply, /Tide times for Casco Bay/);
  });

  test("is case-insensitive", async () => {
    const { ask } = await setup();

    await ask("register tides Tide times", 111);

    assert.match(await ask("whois TIDES"), /Tide times/);
  });

  test("reports an unknown name", async () => {
    const { ask } = await setup();

    assert.match(await ask("whois nope"), /No service named/);
  });

  test("requires a name", async () => {
    const { ask } = await setup();

    assert.match(await ask("whois"), /Usage/);
  });
});

describe("help", () => {
  test("answers an unrecognised command with the command list", async () => {
    const { ask } = await setup();

    const reply = await ask("what can you do");

    assert.match(reply, /services/);
    assert.match(reply, /register/);
  });
});
