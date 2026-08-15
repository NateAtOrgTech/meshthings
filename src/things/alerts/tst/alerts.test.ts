import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { alertsModule, AlertsConfig, createSpawnSource } from "../index.js";
import { createMeshThing, DatabaseHandle, MAX_TEXT_BYTES, openDatabase } from "../../../core/index.js";
import { createMockDevice } from "../../../testing/index.js";

const NOW = Date.UTC(2024, 4, 2, 21, 20);
const DAY = 24 * 60 * 60 * 1000;

const TORNADO = "ZCZC-WXR-TOR-023005+0100-1232115-KGYX/NWS-";
const TORNADO_ELSEWHERE = "ZCZC-WXR-TOR-023031+0100-1232115-KGYX/NWS-";
const WATCH = "ZCZC-WXR-TOA-023005+0100-1232115-KGYX/NWS-";
const WEEKLY_TEST = "ZCZC-WXR-RWT-023005+0015-1232115-KGYX/NWS-";

const AREA_NAMES = { "023005": "Cumberland", "023031": "York" };

// Stands in for the decoder process
function fakeSource() {
  let emit: ((line: string) => void) | undefined;
  let stopped = false;

  return {
    source: {
      start(onLine: (line: string) => void) {
        emit = onLine;
      },
      stop() {
        stopped = true;
      },
    },
    send(line: string) {
      emit?.(line);
    },
    get stopped() {
      return stopped;
    },
  };
}

async function setup(config: Partial<AlertsConfig> = {}, database?: DatabaseHandle, minSendIntervalMs = 0) {
  const db = database ?? openDatabase(":memory:");
  const decoder = fakeSource();
  const fake = createMockDevice();
  const thing = createMeshThing({ minSendIntervalMs });

  let clock = NOW;

  await thing.listen(fake.device, [
    {
      module: alertsModule,
      config: {
        database: db,
        source: config.source ?? decoder.source,
        areaNames: AREA_NAMES,
        timeZone: "UTC",
        now: () => clock,
        ...config,
      },
    },
  ]);

  async function ask(text: string, from = 0x1000) {
    const before = fake.sent.length;

    fake.receive(text, { from });

    return (await fake.waitForSends(before + 1))[before].text;
  }

  return {
    db,
    fake,
    thing,
    decoder,
    ask,
    advance(milliseconds: number) {
      clock += milliseconds;
    },
  };
}

describe("broadcasting alerts", () => {
  test("pushes a warning to a subscriber in the affected county", async () => {
    const { ask, fake, decoder } = await setup();

    await ask("subscribe 023005", 111);
    fake.clear();

    decoder.send(TORNADO);

    const [message] = await fake.waitForSends(1);

    assert.equal(message.to, 111);
    assert.match(message.text, /Tornado Warning: Cumberland until 22:15/);
  });

  test("skips a subscriber in a different county", async () => {
    const { ask, fake, decoder } = await setup();

    await ask("subscribe 023031", 111);
    fake.clear();

    decoder.send(TORNADO);
    await fake.settle();

    assert.deepEqual(fake.texts(), []);
  });

  test("sends everything to a subscriber with no filter", async () => {
    const { ask, fake, decoder } = await setup();

    await ask("subscribe", 111);
    fake.clear();

    decoder.send(TORNADO_ELSEWHERE);

    assert.equal((await fake.waitForSends(1)).length, 1);
  });

  test("fans out to every matching subscriber", async () => {
    const { ask, fake, decoder } = await setup();

    await ask("subscribe 023005", 111);
    await ask("subscribe 023005", 222);
    await ask("subscribe 023031", 333);
    fake.clear();

    decoder.send(TORNADO);

    const sent = await fake.waitForSends(2);

    assert.deepEqual(
      sent.map((message) => message.to),
      [111, 222],
    );
  });

  test("sends nothing when nobody is subscribed", async () => {
    const { fake, decoder } = await setup();

    decoder.send(TORNADO);
    await fake.settle();

    assert.deepEqual(fake.texts(), []);
  });

  test("keeps the message inside one packet", async () => {
    const { ask, fake, decoder } = await setup();

    await ask("subscribe", 111);
    fake.clear();

    decoder.send("ZCZC-WXR-SVR-023005-023031-023001-023003-023009+0100-1232115-KGYX/NWS-");

    const [message] = await fake.waitForSends(1);

    assert.ok(Buffer.byteLength(message.text, "utf8") <= MAX_TEXT_BYTES);
  });

  test("falls back to the raw code for an unmapped county", async () => {
    const { ask, fake, decoder } = await setup();

    await ask("subscribe", 111);
    fake.clear();

    decoder.send("ZCZC-WXR-TOR-099999+0100-1232115-KGYX/NWS-");

    assert.match((await fake.waitForSends(1))[0].text, /099999/);
  });

  test("puts a life-safety warning ahead of queued traffic", async () => {
    const { ask, fake, thing, decoder } = await setup({}, undefined, 25);

    await ask("subscribe 023005", 111);
    await fake.waitForSends(1);
    fake.clear();

    thing.send("chatter one");
    thing.send("chatter two");
    decoder.send(TORNADO);

    await fake.waitForSends(3);

    const texts = fake.texts();
    const warning = texts.findIndex((text) => /Tornado Warning/.test(text));

    // Ahead of everything already waiting, whatever was mid-flight
    assert.ok(warning >= 0, `no warning in ${JSON.stringify(texts)}`);
    assert.ok(warning < texts.indexOf("chatter two"), `warning did not jump the queue: ${JSON.stringify(texts)}`);
  });

  test("does not jump the queue for a watch", async () => {
    const { ask, fake, thing, decoder } = await setup({}, undefined, 25);

    await ask("subscribe 023005", 111);
    await fake.waitForSends(1);
    fake.clear();

    thing.send("chatter one");
    thing.send("chatter two");
    decoder.send(WATCH);

    await fake.waitForSends(3);

    const texts = fake.texts();
    const watch = texts.findIndex((text) => /Tornado Watch/.test(text));

    // Queued behind the ordinary traffic, not ahead of it
    assert.ok(watch > texts.indexOf("chatter two"), `watch jumped the queue: ${JSON.stringify(texts)}`);
  });
});

describe("suppressing repeats and tests", () => {
  test("sends one message for the three bursts of an alert", async () => {
    const { ask, fake, decoder } = await setup();

    await ask("subscribe 023005", 111);
    fake.clear();

    decoder.send(TORNADO);
    decoder.send(TORNADO);
    decoder.send(TORNADO);

    await fake.waitForSends(1);
    await fake.settle();

    assert.equal(fake.sent.length, 1);
  });

  test("still relays a genuine reissue", async () => {
    const { ask, fake, decoder } = await setup();

    await ask("subscribe 023005", 111);
    fake.clear();

    decoder.send(TORNADO);
    decoder.send("ZCZC-WXR-TOR-023005+0100-1232215-KGYX/NWS-");

    assert.equal((await fake.waitForSends(2)).length, 2);
  });

  test("does not re-broadcast a live alert after a restart", async () => {
    const shared = openDatabase(":memory:");

    const first = await setup({}, shared);

    await first.ask("subscribe 023005", 111);
    first.fake.clear();
    first.decoder.send(TORNADO);
    await first.fake.waitForSends(1);

    // Same database, fresh process -- a crash loop must not re-alert everyone
    const second = await setup({}, shared);

    second.decoder.send(TORNADO);
    await second.fake.settle();

    assert.deepEqual(second.fake.texts(), []);
  });

  test("never puts the weekly test on the mesh", async () => {
    const { ask, fake, decoder } = await setup();

    await ask("subscribe 023005", 111);
    fake.clear();

    decoder.send(WEEKLY_TEST);
    await fake.settle();

    assert.deepEqual(fake.texts(), []);
  });

  test("ignores decoder noise without sending anything", async () => {
    const { ask, fake, decoder } = await setup();

    await ask("subscribe 023005", 111);
    fake.clear();

    decoder.send("Tuning to 162.550 MHz");
    decoder.send("NNNN");
    decoder.send("");
    await fake.settle();

    assert.deepEqual(fake.texts(), []);
  });
});

describe("receiver health", () => {
  test("reports that no test has been seen yet", async () => {
    const { ask } = await setup();

    assert.match(await ask("receiver"), /No weekly test seen yet/);
  });

  test("treats the weekly test as proof the chain works", async () => {
    const { ask, decoder } = await setup();

    decoder.send(WEEKLY_TEST);

    assert.match(await ask("receiver"), /Receiver ok: last test 0d ago/);
  });

  test("goes stale when the weekly test stops arriving", async () => {
    const { ask, decoder, advance } = await setup({ testIntervalDays: 8 });

    decoder.send(WEEKLY_TEST);
    advance(9 * DAY);

    assert.match(await ask("receiver"), /Receiver STALE: last test 9d ago/);
  });

  test("says plainly when no decoder is configured", async () => {
    const fake = createMockDevice();
    const thing = createMeshThing({ minSendIntervalMs: 0 });

    await thing.listen(fake.device, [
      { module: alertsModule, config: { database: openDatabase(":memory:"), now: () => NOW } },
    ]);

    fake.receive("receiver");

    assert.match((await fake.waitForSends(1))[0].text, /Receiver not configured/);
  });

  test("counts subscribers", async () => {
    const { ask, decoder } = await setup();

    await ask("subscribe 023005", 111);
    await ask("subscribe 023031", 222);
    decoder.send(WEEKLY_TEST);

    assert.match(await ask("receiver"), /2 subscribers/);
  });
});

describe("commands", () => {
  test("reports no recent alerts before any arrive", async () => {
    const { ask } = await setup();

    assert.match(await ask("alerts"), /No alerts received/);
  });

  test("lists recent alerts newest first", async () => {
    const { ask, decoder } = await setup();

    decoder.send(TORNADO);
    decoder.send("ZCZC-WXR-SVR-023005+0100-1232215-KGYX/NWS-");

    const listing = await ask("alerts");

    assert.ok(listing.indexOf("Severe Thunderstorm Warning") < listing.indexOf("Tornado Warning"));
  });

  test("keeps a test out of the recent list too", async () => {
    const { ask, decoder } = await setup();

    decoder.send(WEEKLY_TEST);

    assert.match(await ask("alerts"), /No alerts received/);
  });

  test("rejects a filter that is not a FIPS code", async () => {
    const { ask } = await setup();

    assert.match(await ask("subscribe maine", 111), /must be FIPS county codes/);
  });

  test("accepts subscribing to several counties", async () => {
    const { ask, fake, decoder } = await setup();

    await ask("subscribe 023005 023031", 111);
    fake.clear();

    decoder.send(TORNADO_ELSEWHERE);

    assert.equal((await fake.waitForSends(1))[0].to, 111);
  });

  test("stops receiving once unsubscribed", async () => {
    const { ask, fake, decoder } = await setup();

    await ask("subscribe 023005", 111);
    await ask("unsubscribe", 111);
    fake.clear();

    decoder.send(TORNADO);
    await fake.settle();

    assert.deepEqual(fake.texts(), []);
  });
});

describe("teardown", () => {
  test("stops the decoder", async () => {
    const { thing, decoder } = await setup();

    await thing.stop();

    assert.equal(decoder.stopped, true);
  });
});

// The path that runs against a real SAME decoder. Driven with node standing in
// for the decoder process, so the stdout handling is covered without an SDR.
describe("spawned decoder source", () => {
  function collect(script: string, expected: number, timeoutMs = 5000) {
    return new Promise<{ lines: string[]; source: ReturnType<typeof createSpawnSource> }>((resolve, reject) => {
      const lines: string[] = [];
      const source = createSpawnSource({ command: process.execPath, args: ["-e", script] }, () => {});
      const timer = setTimeout(() => reject(new Error(`only saw ${JSON.stringify(lines)}`)), timeoutMs);

      source.start((line) => {
        lines.push(line);

        if (lines.length >= expected) {
          clearTimeout(timer);
          resolve({ lines, source });
        }
      });
    });
  }

  test("emits one call per line of decoder output", async () => {
    const { lines, source } = await collect(`process.stdout.write("${TORNADO}\\n${WEEKLY_TEST}\\n")`, 2);

    source.stop?.();

    assert.deepEqual(lines, [TORNADO, WEEKLY_TEST]);
  });

  test("reassembles a line split across two chunks", async () => {
    const half = TORNADO.slice(0, 10);
    const rest = TORNADO.slice(10);
    const script = `process.stdout.write("${half}"); setTimeout(() => process.stdout.write("${rest}\\n"), 30)`;

    const { lines, source } = await collect(script, 1);

    source.stop?.();

    assert.deepEqual(lines, [TORNADO]);
  });

  test("does not emit a trailing partial line", async () => {
    const { lines, source } = await collect(`process.stdout.write("${TORNADO}\\nleftover")`, 1);

    source.stop?.();

    assert.deepEqual(lines, [TORNADO]);
  });

  test("survives a decoder that cannot be started", async () => {
    const messages: string[] = [];
    const source = createSpawnSource({ command: "definitely-not-a-real-decoder" }, (message) => messages.push(message));

    source.start(() => {});

    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.ok(
      messages.some((message) => /failed to start/.test(message)),
      `expected a start failure, saw ${JSON.stringify(messages)}`,
    );
  });
});
