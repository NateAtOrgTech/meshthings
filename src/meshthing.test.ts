import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { CommandMap, createMeshThing } from "./meshthing";
import { createFakeDevice, DEFAULT_SENDER, FakeDeviceOptions } from "./testing";

type SetupOptions = {
  // Pacing is exercised on its own below; everywhere else it just gets in the way
  minSendIntervalMs?: number;
  maxQueueLength?: number;
  onUnknown?: CommandMap["default"];
  device?: FakeDeviceOptions;
};

async function setup(commandMap: CommandMap, options: SetupOptions = {}) {
  const fake = createFakeDevice(options.device);
  const thing = createMeshThing({
    minSendIntervalMs: options.minSendIntervalMs ?? 0,
    maxQueueLength: options.maxQueueLength,
    onUnknown: options.onUnknown,
  });

  await thing.listen(fake.device, commandMap);

  return { fake, thing };
}

const echo: CommandMap = {
  commands: [{ commandStrings: ["echo", "e"], commandFunction: (args) => args.join("|") }],
  default: () => "help",
};

describe("command routing", () => {
  test("dispatches a command by name", async () => {
    const { fake } = await setup(echo);

    fake.receive("echo hello");

    assert.deepEqual((await fake.waitForSends(1))[0].text, "hello");
  });

  test("dispatches through an alias", async () => {
    const { fake } = await setup(echo);

    fake.receive("e hello");

    assert.equal((await fake.waitForSends(1))[0].text, "hello");
  });

  test("matches commands case-insensitively", async () => {
    const { fake } = await setup(echo);

    fake.receive("ECHO hello");

    assert.equal((await fake.waitForSends(1))[0].text, "hello");
  });

  test("passes arguments without the command word", async () => {
    const { fake } = await setup(echo);

    fake.receive("echo one two three");

    assert.equal((await fake.waitForSends(1))[0].text, "one|two|three");
  });

  test("collapses repeated whitespace between arguments", async () => {
    const { fake } = await setup(echo);

    fake.receive("echo  one   two ");

    assert.equal((await fake.waitForSends(1))[0].text, "one|two");
  });

  test("falls back to the default handler for an unknown command", async () => {
    const { fake } = await setup(echo);

    fake.receive("nonsense");

    assert.equal((await fake.waitForSends(1))[0].text, "help");
  });

  test("answers an unknown command with aggregated help when there is no default", async () => {
    const { fake } = await setup({ commands: echo.commands });

    fake.receive("nonsense");

    // Lists the app's own commands alongside the core built-ins
    assert.match((await fake.waitForSends(1))[0].text, /echo/);
  });

  test("stays silent on an unknown command when onUnknown declines to reply", async () => {
    const { fake } = await setup({ commands: echo.commands }, { onUnknown: () => undefined });

    fake.receive("nonsense");
    await fake.settle();

    assert.deepEqual(fake.texts(), []);
  });

  // Regression: `default` used to be assigned inside the commands loop, so a
  // map with no commands never registered it
  test("registers a default even when no commands are supplied", async () => {
    const { fake } = await setup({ commands: [], default: () => "help" });

    fake.receive("anything");

    assert.equal((await fake.waitForSends(1))[0].text, "help");
  });

  test("accepts a bare string as the command name", async () => {
    const { fake } = await setup({ commands: [{ commandStrings: "ping", commandFunction: () => "pong" }] });

    fake.receive("ping");

    assert.equal((await fake.waitForSends(1))[0].text, "pong");
  });

  test("rejects duplicate command registrations at startup", async () => {
    await assert.rejects(
      () =>
        setup({
          commands: [
            { commandStrings: ["dup"], commandFunction: () => "a" },
            { commandStrings: ["other", "DUP"], commandFunction: () => "b" },
          ],
        }),
      /Duplicate command registration for "DUP"/,
    );
  });
});

describe("handler contract", () => {
  test("awaits an async handler", async () => {
    const { fake } = await setup({
      commands: [
        {
          commandStrings: "slow",
          commandFunction: async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));

            return "eventually";
          },
        },
      ],
    });

    fake.receive("slow");

    assert.equal((await fake.waitForSends(1))[0].text, "eventually");
  });

  test("sends nothing when a handler returns an empty string", async () => {
    const { fake } = await setup({ commands: [{ commandStrings: "quiet", commandFunction: () => "" }] });

    fake.receive("quiet");
    await fake.settle();

    assert.deepEqual(fake.texts(), []);
  });

  test("sends nothing when a handler returns undefined", async () => {
    const { fake } = await setup({ commands: [{ commandStrings: "quiet", commandFunction: () => undefined }] });

    fake.receive("quiet");
    await fake.settle();

    assert.deepEqual(fake.texts(), []);
  });

  test("survives a throwing handler and counts the error", async () => {
    const { fake, thing } = await setup({
      commands: [
        {
          commandStrings: "boom",
          commandFunction: () => {
            throw new Error("handler exploded");
          },
        },
      ],
    });

    fake.receive("boom");
    await fake.settle();

    assert.deepEqual(fake.texts(), []);
    assert.equal(thing.getStats().errors, 1);
  });

  test("survives a rejected promise from an async handler", async () => {
    const { fake, thing } = await setup({
      commands: [{ commandStrings: "boom", commandFunction: async () => Promise.reject(new Error("nope")) }],
    });

    fake.receive("boom");
    await fake.settle();

    assert.equal(thing.getStats().errors, 1);
  });

  test("gives the handler the sender, original casing, and full text", async () => {
    let seen: any;

    const { fake } = await setup({
      commands: [
        {
          commandStrings: "ctx",
          commandFunction: (args, context) => {
            seen = context;

            return "ok";
          },
        },
      ],
    });

    fake.receive("CtX with args", { from: 4242, channel: 3 as any });
    await fake.waitForSends(1);

    assert.equal(seen.from, 4242);
    assert.equal(seen.command, "CtX");
    assert.equal(seen.text, "CtX with args");
    assert.equal(seen.channel, 3);
  });

  test("replies directly to the sender on their channel", async () => {
    const { fake } = await setup(echo);

    fake.receive("echo hi", { from: 4242, channel: 2 as any });

    const [message] = await fake.waitForSends(1);

    assert.equal(message.to, 4242);
    assert.equal(message.channel, 2);
  });
});

describe("message filtering", () => {
  test("ignores its own messages", async () => {
    const { fake } = await setup(echo);

    fake.receive("echo hi", { from: fake.nodeNum });
    await fake.settle();

    assert.deepEqual(fake.texts(), []);
  });

  test("ignores messages not addressed to it", async () => {
    const { fake } = await setup(echo);

    fake.receive("echo hi", { to: 0xffffffff });
    await fake.settle();

    assert.deepEqual(fake.texts(), []);
  });

  // Would previously throw on `myNodeInfo.myNodeNum` before identity arrived
  test("ignores packets that arrive before the node identity is known", async () => {
    const { fake } = await setup(echo, { device: { deferIdentify: true } });

    fake.receive("echo hi");
    await fake.settle();

    assert.deepEqual(fake.texts(), []);

    fake.identify();
    fake.receive("echo hi");

    assert.equal((await fake.waitForSends(1))[0].text, "hi");
  });
});

describe("outbound queue", () => {
  test("paces transmissions by the configured interval", async () => {
    const { fake, thing } = await setup({ commands: [] }, { minSendIntervalMs: 60 });

    thing.send("one");
    thing.send("two");
    thing.send("three");

    const sent = await fake.waitForSends(3);

    assert.ok(sent[1].at - sent[0].at >= 55, `gap was ${sent[1].at - sent[0].at}ms`);
    assert.ok(sent[2].at - sent[1].at >= 55, `gap was ${sent[2].at - sent[1].at}ms`);
  });

  test("lets high priority jump ahead of queued normal traffic", async () => {
    const { fake, thing } = await setup({ commands: [] }, { minSendIntervalMs: 30 });

    thing.send("normal one");
    thing.send("normal two");
    thing.send("URGENT", { priority: "high" });

    await fake.waitForSends(3);

    // "normal one" is already in flight; the jump is over "normal two"
    assert.deepEqual(fake.texts(), ["normal one", "URGENT", "normal two"]);
  });

  test("broadcasts by default", async () => {
    const { fake, thing } = await setup({ commands: [] });

    thing.send("to everyone");

    assert.equal((await fake.waitForSends(1))[0].to, "broadcast");
  });

  test("fans out one message to many destinations", async () => {
    const { fake, thing } = await setup({ commands: [] });

    const accepted = thing.sendMany("ALERT", [1, 2, 3]);

    await fake.waitForSends(3);

    assert.equal(accepted, 3);
    assert.deepEqual(
      fake.sent.map((message) => message.to),
      [1, 2, 3],
    );
  });

  test("truncates oversize text on a character boundary and counts it", async () => {
    const { fake, thing } = await setup({ commands: [] });

    thing.send("é".repeat(200));

    const [message] = await fake.waitForSends(1);

    assert.ok(Buffer.byteLength(message.text, "utf8") <= 180);
    assert.ok(message.text.endsWith("…"));
    // No partial codepoints: round-tripping must not introduce replacements
    assert.ok(!message.text.includes("�"));
    assert.equal(thing.getStats().truncated, 1);
  });

  test("leaves text at the byte limit alone", async () => {
    const { fake, thing } = await setup({ commands: [] });

    thing.send("x".repeat(180));

    const [message] = await fake.waitForSends(1);

    assert.equal(message.text.length, 180);
    assert.equal(thing.getStats().truncated, 0);
  });

  test("drops the oldest normal message when the queue overflows", async () => {
    const { fake, thing } = await setup({ commands: [] }, { minSendIntervalMs: 20, maxQueueLength: 3 });

    // The first send leaves immediately, so only the rest occupy the queue
    thing.send("in flight");
    thing.send("keep me", { priority: "high" });
    thing.send("oldest");
    thing.send("newest");

    assert.equal(thing.getStats().dropped, 0);

    thing.send("overflowing");

    assert.equal(thing.getStats().dropped, 1);

    await fake.waitForSends(4);

    assert.deepEqual(fake.texts(), ["in flight", "keep me", "newest", "overflowing"]);
  });

  test("refuses a new message rather than dropping queued high priority", async () => {
    const { thing } = await setup({ commands: [] }, { minSendIntervalMs: 5000, maxQueueLength: 3 });

    thing.send("in flight", { priority: "high" });
    thing.send("alert one", { priority: "high" });
    thing.send("alert two", { priority: "high" });
    thing.send("alert three", { priority: "high" });

    assert.equal(thing.send("chatter"), false);
    assert.equal(thing.getStats().dropped, 1);
  });

  test("queues messages sent before the radio is attached", async () => {
    const fake = createFakeDevice();
    const thing = createMeshThing({ minSendIntervalMs: 0 });

    thing.send("early bird");
    await fake.settle();

    assert.deepEqual(fake.texts(), []);

    await thing.listen(fake.device, { commands: [] });

    assert.equal((await fake.waitForSends(1))[0].text, "early bird");
  });

  test("keeps draining after a transmit failure", async () => {
    const { fake, thing } = await setup({ commands: [] });

    fake.failNextSend();
    thing.send("doomed");
    thing.send("survivor");

    await fake.waitForSends(1);

    assert.deepEqual(fake.texts(), ["survivor"]);
    assert.equal(thing.getStats().errors, 1);
  });

  test("stop() clears the queue and refuses further sends", async () => {
    const { fake, thing } = await setup({ commands: [] }, { minSendIntervalMs: 5000, maxQueueLength: 3 });

    thing.send("first");
    thing.send("second");
    thing.stop();

    assert.equal(thing.send("after stop"), false);
    await fake.settle();

    assert.equal(thing.getStats().queued, 0);
  });

  test("ignores empty sends", async () => {
    const { thing } = await setup({ commands: [] });

    assert.equal(thing.send(""), false);
  });
});

describe("stats", () => {
  test("counts handled commands and sent messages", async () => {
    const { fake, thing } = await setup(echo);

    fake.receive("echo a");
    fake.receive("echo b");
    await fake.waitForSends(2);

    const stats = thing.getStats();

    assert.equal(stats.handled, 2);
    assert.equal(stats.sent, 2);
    assert.equal(stats.lastCommand, "echo");
    assert.equal(stats.lastSent, "b");
    assert.equal(stats.queued, 0);
  });

  test("reports current queue depth", async () => {
    const { thing } = await setup({ commands: [] }, { minSendIntervalMs: 5000, maxQueueLength: 3 });

    thing.send("one");
    thing.send("two");

    // One is in flight, the rest are waiting
    assert.ok(thing.getStats().queued >= 1);
  });
});
