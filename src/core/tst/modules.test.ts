import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { createMeshThing, MeshThingModule, ModuleSpec } from "../meshthing.js";
import { createMockDevice } from "../../testing/index.js";

function moduleNamed(name: string, words: string[], reply = name): MeshThingModule {
  return {
    name,
    description: `${name} module`,
    create: () => ({ commands: [{ commandStrings: words, commandFunction: () => reply }] }),
  };
}

async function mount(specs: ModuleSpec[]) {
  const fake = createMockDevice();
  const thing = createMeshThing({ minSendIntervalMs: 0 });

  await thing.listen(fake.device, specs);

  async function ask(text: string, from = 0x1000) {
    const before = fake.sent.length;

    fake.receive(text, { from });

    return (await fake.waitForSends(before + 1))[before].text;
  }

  return { fake, thing, ask };
}

describe("composition", () => {
  test("mounts several modules on one device", async () => {
    const { ask, thing } = await mount([
      moduleNamed("weather", ["t", "temp"], "18.2°C"),
      moduleNamed("directory", ["services"], "no services"),
    ]);

    assert.equal(await ask("t"), "18.2°C");
    assert.equal(await ask("services"), "no services");
    assert.deepEqual(thing.getModules(), ["weather", "directory"]);
  });

  test("keeps aliases working across modules", async () => {
    const { ask } = await mount([moduleNamed("weather", ["t", "temp", "temperature"], "18.2°C")]);

    assert.equal(await ask("temp"), "18.2°C");
    assert.equal(await ask("TEMPERATURE"), "18.2°C");
  });

  test("hands each module its own config", async () => {
    const seen: unknown[] = [];

    const recorder: MeshThingModule<{ port: number }> = {
      name: "recorder",
      description: "records its config",
      create: ({ config }) => {
        seen.push(config);

        return { commands: [] };
      },
    };

    await mount([{ module: recorder, config: { port: 4321 } }]);

    assert.deepEqual(seen, [{ port: 4321 }]);
  });

  test("gives a module the outbound API so it can push unprompted", async () => {
    const pusher: MeshThingModule = {
      name: "pusher",
      description: "pushes without being asked",
      create: ({ send }) => {
        send("unprompted", { to: 999 });

        return { commands: [] };
      },
    };

    const { fake } = await mount([pusher]);

    const [message] = await fake.waitForSends(1);

    assert.equal(message.text, "unprompted");
    assert.equal(message.to, 999);
  });

  test("awaits an async module create", async () => {
    const slow: MeshThingModule = {
      name: "slow",
      description: "takes its time starting",
      create: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));

        return { commands: [{ commandStrings: "ready", commandFunction: () => "yes" }] };
      },
    };

    const { ask } = await mount([slow]);

    assert.equal(await ask("ready"), "yes");
  });
});

describe("command collisions", () => {
  test("refuses to start when two modules claim the same word", async () => {
    await assert.rejects(
      () => mount([moduleNamed("alerts", ["status"]), moduleNamed("directory", ["status"])]),
      /claimed by both "alerts" and "directory"/,
    );
  });

  test("names both modules and the offending word", async () => {
    await assert.rejects(
      () => mount([moduleNamed("alerts", ["status"]), moduleNamed("directory", ["status"])]),
      /rename, prefix, or disable/,
    );
  });

  test("catches a collision between an alias and a primary word", async () => {
    await assert.rejects(() => mount([moduleNamed("a", ["one", "shared"]), moduleNamed("b", ["shared"])]), /claimed by both/);
  });

  test("still reports a module colliding with itself as a duplicate", async () => {
    await assert.rejects(
      () => mount([moduleNamed("self", ["dup", "DUP"])]),
      /Duplicate command registration for "DUP"/,
    );
  });

  test("resolves a collision with a prefix", async () => {
    const { ask } = await mount([
      moduleNamed("alerts", ["status"], "alert status"),
      { module: moduleNamed("directory", ["status"], "dir status"), prefix: "dir" },
    ]);

    assert.equal(await ask("status"), "alert status");
    assert.equal(await ask("dirstatus"), "dir status");
  });

  test("resolves a collision by renaming one word", async () => {
    const { ask } = await mount([
      moduleNamed("alerts", ["status"], "alert status"),
      { module: moduleNamed("directory", ["status", "info"], "dir status"), rename: { status: "dstatus" } },
    ]);

    assert.equal(await ask("status"), "alert status");
    assert.equal(await ask("dstatus"), "dir status");
    // The untouched alias still works
    assert.equal(await ask("info"), "dir status");
  });

  test("resolves a collision by disabling one word", async () => {
    const { ask } = await mount([
      moduleNamed("alerts", ["status"], "alert status"),
      { module: moduleNamed("directory", ["status", "info"], "dir status"), disable: ["status"] },
    ]);

    assert.equal(await ask("status"), "alert status");
    assert.equal(await ask("info"), "dir status");
  });
});

describe("aggregated help", () => {
  test("lists every mounted module and its commands", async () => {
    const { ask } = await mount([moduleNamed("weather", ["t", "temp"]), moduleNamed("directory", ["services", "find"])]);

    const help = await ask("help");

    assert.match(help, /weather: t/);
    assert.match(help, /directory: services/);
  });

  test("answers an unknown command with help", async () => {
    const { ask } = await mount([moduleNamed("weather", ["t"])]);

    assert.match(await ask("nonsense"), /weather: t/);
  });

  test("shows the resolved word, not the module's original", async () => {
    const { ask } = await mount([
      moduleNamed("alerts", ["status"]),
      { module: moduleNamed("directory", ["status"]), rename: { status: "dstatus" } },
    ]);

    const help = await ask("help");

    assert.match(help, /directory: dstatus/);
  });

  test("omits a module whose commands were all disabled", async () => {
    const { ask } = await mount([
      moduleNamed("weather", ["t"]),
      { module: moduleNamed("quiet", ["hush"]), disable: ["hush"] },
    ]);

    const help = await ask("help");

    assert.match(help, /weather/);
    assert.ok(!help.includes("quiet"));
  });

  test("paginates help when there are too many modules for one packet", async () => {
    const many = Array.from({ length: 12 }, (unused, index) =>
      moduleNamed(`module${index}`, [`command${index}`, `alias${index}`]),
    );

    const { ask } = await mount(many);

    const first = await ask("help");

    assert.ok(Buffer.byteLength(first, "utf8") <= 180);
    assert.match(first, /\(1\/\d\) help 2/);
    assert.match(await ask("help 2"), /\(2\/\d\)/);
  });

  test("answers to ? as well", async () => {
    const { ask } = await mount([moduleNamed("weather", ["t"])]);

    assert.match(await ask("?"), /weather: t/);
  });

  test("lets a module claim help for itself", async () => {
    const { ask } = await mount([moduleNamed("custom", ["help"], "my own help")]);

    assert.equal(await ask("help"), "my own help");
  });

  test("still offers the built-ins when no modules are mounted", async () => {
    const { ask } = await mount([]);

    // A node with nothing mounted can still be checked for life
    assert.match(await ask("anything"), /core: help/);
  });
});

describe("teardown", () => {
  test("stops every mounted module", async () => {
    const stopped: string[] = [];

    const stoppable = (name: string): MeshThingModule => ({
      name,
      description: name,
      create: () => ({ commands: [], stop: () => void stopped.push(name) }),
    });

    const { thing } = await mount([stoppable("first"), stoppable("second")]);

    await thing.stop();

    assert.deepEqual(stopped, ["first", "second"]);
  });

  test("awaits an async module stop", async () => {
    let finished = false;

    const slow: MeshThingModule = {
      name: "slow",
      description: "slow to shut down",
      create: () => ({
        commands: [],
        stop: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          finished = true;
        },
      }),
    };

    const { thing } = await mount([slow]);

    await thing.stop();

    assert.equal(finished, true);
  });

  test("keeps stopping the rest when one module throws", async () => {
    const stopped: string[] = [];

    const badly: MeshThingModule = {
      name: "badly",
      description: "throws on stop",
      create: () => ({
        commands: [],
        stop: () => {
          throw new Error("could not close");
        },
      }),
    };

    const cleanly: MeshThingModule = {
      name: "cleanly",
      description: "stops fine",
      create: () => ({ commands: [], stop: () => void stopped.push("cleanly") }),
    };

    const { thing } = await mount([badly, cleanly]);

    await thing.stop();

    assert.deepEqual(stopped, ["cleanly"]);
    assert.equal(thing.getStats().errors, 1);
  });
});
