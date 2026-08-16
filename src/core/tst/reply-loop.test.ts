import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { commandsModule, createMeshThing, MeshThingOptions } from "../meshthing.js";
import { createMockDevice } from "../../testing/index.js";

// Two nodes running this will talk to each other eventually -- deliberately,
// once discovery exists, and by accident before that. Neither recognises the
// other's reply as a command, so each answers with its help, and they hold the
// channel between them open forever at one message per pacing interval.

async function twoNodesTalking(options: MeshThingOptions = {}) {
  const a = createMockDevice({ nodeNum: 1 });
  const b = createMockDevice({ nodeNum: 2 });
  const first = createMeshThing({ minSendIntervalMs: 0, ...options });
  const second = createMeshThing({ minSendIntervalMs: 0, ...options });

  await first.listen(a.device, [commandsModule("weather", "weather", [])]);
  await second.listen(b.device, [
    commandsModule("directory", "directory", [
      { commandStrings: "services", commandFunction: () => "no services registered" },
    ]),
  ]);

  let deliveredA = 0;
  let deliveredB = 0;

  // Carry each node's transmissions to the other, as the mesh would
  async function runFor(ticks: number) {
    for (let tick = 0; tick < ticks; tick++) {
      await new Promise((resolve) => setTimeout(resolve, 5));

      while (a.sent.length > deliveredA) {
        const message = a.sent[deliveredA++];

        if (message.to === 2) {
          b.receive(message.text, { from: 1, to: 2 });
        }
      }

      while (b.sent.length > deliveredB) {
        const message = b.sent[deliveredB++];

        if (message.to === 1) {
          a.receive(message.text, { from: 2, to: 1 });
        }
      }
    }
  }

  return { a, b, first, second, runFor };
}

describe("two nodes running meshthings", () => {
  test("do not answer each other forever", async () => {
    const { a, b, first, second, runFor } = await twoNodesTalking();

    // One greeting, of the kind discovery would send
    b.receive("Hi, this node answers commands. Send help.", { from: 1, to: 2 });

    await runFor(40);
    await first.stop();
    await second.stop();

    const total = a.sent.length + b.sent.length;

    assert.ok(total <= 4, `the two nodes exchanged ${total} messages from one greeting`);
  });

  test("do not loop on an ordinary command reply either", async () => {
    const { a, b, first, second, runFor } = await twoNodesTalking();

    // A real command, answered normally -- the reply is what does not parse
    b.receive("services", { from: 1, to: 2 });

    await runFor(40);
    await first.stop();
    await second.stop();

    const total = a.sent.length + b.sent.length;

    assert.ok(total <= 4, `a single command produced ${total} messages`);
  });

  test("loop without the cooldown, which is what makes this worth guarding", async () => {
    const { a, b, first, second, runFor } = await twoNodesTalking({ unknownReplyCooldownMs: 0 });

    b.receive("hello", { from: 1, to: 2 });

    await runFor(40);
    await first.stop();
    await second.stop();

    // Confirms the harness reproduces the fault rather than the fix being
    // untested against anything
    assert.ok(a.sent.length + b.sent.length > 10, "expected the unguarded case to run away");
  });
});

describe("the cooldown is narrow", () => {
  async function node(options: MeshThingOptions = {}) {
    const mock = createMockDevice();
    const thing = createMeshThing({ minSendIntervalMs: 0, ...options });

    await thing.listen(mock.device, [
      commandsModule("weather", "weather", [{ commandStrings: "t", commandFunction: () => "18.5°C" }]),
    ]);

    async function ask(text: string, from = 0x1000) {
      const before = mock.sent.length;

      mock.receive(text, { from });
      await mock.settle(20);

      return mock.sent.slice(before).map((message) => message.text);
    }

    return { ask, thing };
  }

  test("a stranger still gets told what the node offers", async () => {
    const { ask } = await node();

    assert.match((await ask("what is this"))[0], /weather: t/);
  });

  test("but not over and over", async () => {
    const { ask } = await node();

    await ask("what is this");

    assert.deepEqual(await ask("still confused"), []);
  });

  test("and it is per node, not global", async () => {
    const { ask } = await node();

    await ask("what is this", 111);

    assert.match((await ask("what is this", 222))[0], /weather: t/);
  });

  test("it expires", async () => {
    const { ask } = await node({ unknownReplyCooldownMs: 30 });

    await ask("what is this");
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.match((await ask("what is this"))[0], /weather: t/);
  });

  test("real commands are never rate limited", async () => {
    const { ask } = await node();

    for (let attempt = 0; attempt < 5; attempt++) {
      assert.deepEqual(await ask("t"), ["18.5°C"], `attempt ${attempt}`);
    }
  });
});
