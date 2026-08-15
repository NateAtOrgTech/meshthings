import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { createMeshThing, MAX_TEXT_BYTES, MeshThingModule, MeshThingOptions, ModuleSpec } from "../meshthing.js";
import { createMockDevice } from "../../testing/index.js";

const START = Date.UTC(2024, 4, 2, 12, 0);

function moduleNamed(name: string, words: string[], description = `${name} module`): MeshThingModule {
  return {
    name,
    description,
    create: () => ({ commands: [{ commandStrings: words, commandFunction: () => name }] }),
  };
}

async function mount(specs: ModuleSpec[] = [], options: MeshThingOptions = {}) {
  const fake = createMockDevice();
  let clock = START;

  const thing = createMeshThing({
    minSendIntervalMs: 0,
    version: "1.2.3",
    now: () => clock,
    ...options,
  });

  await thing.listen(fake.device, specs);

  async function ask(text: string) {
    const before = fake.sent.length;

    fake.receive(text);

    const reply = (await fake.waitForSends(before + 1))[before].text;

    assert.ok(Buffer.byteLength(reply, "utf8") <= MAX_TEXT_BYTES, `reply too long: ${reply}`);

    return reply;
  }

  return { fake, thing, ask, advance: (milliseconds: number) => (clock += milliseconds) };
}

describe("ping", () => {
  test("answers so an operator can confirm the node is alive", async () => {
    const { ask } = await mount();

    assert.equal(await ask("ping"), "pong");
  });

  test("is case-insensitive like any other command", async () => {
    const { ask } = await mount();

    assert.equal(await ask("PING"), "pong");
  });

  test("gives way to a module that wants the word", async () => {
    const { ask } = await mount([moduleNamed("games", ["ping"])]);

    assert.equal(await ask("ping"), "games");
  });
});

describe("sys", () => {
  test("summarises version, uptime and module count", async () => {
    const { ask, advance } = await mount([moduleNamed("weather", ["t"]), moduleNamed("directory", ["services"])]);

    advance(3 * 60 * 60 * 1000 + 25 * 60 * 1000);

    const reply = await ask("sys");

    assert.match(reply, /meshthings 1\.2\.3/);
    assert.match(reply, /up 3h 25m/);
    assert.match(reply, /2 modules/);
  });

  test("reports days once it has been up that long", async () => {
    const { ask, advance } = await mount();

    advance(50 * 60 * 60 * 1000);

    assert.match(await ask("sys"), /up 2d 2h/);
  });

  test("reports seconds when freshly started", async () => {
    const { ask, advance } = await mount();

    advance(12 * 1000);

    assert.match(await ask("sys"), /up 12s/);
  });

  test("counts the commands it has handled", async () => {
    const { ask } = await mount([moduleNamed("weather", ["t"])]);

    await ask("t");
    await ask("t");

    assert.match(await ask("sys"), /3 cmds/);
  });

  test("breaks down the counters under sys stats", async () => {
    const { ask, thing } = await mount([moduleNamed("weather", ["t"])]);

    await ask("t");
    thing.send("x".repeat(400));

    const reply = await ask("sys stats");

    assert.match(reply, /cmds \d+, err 0/);
    assert.match(reply, /cut 1/);
    assert.match(reply, /queue \d+/);
  });

  test("counts a failing command as an error", async () => {
    const failing: MeshThingModule = {
      name: "broken",
      description: "throws",
      create: () => ({
        commands: [
          {
            commandStrings: "boom",
            commandFunction: () => {
              throw new Error("nope");
            },
          },
        ],
      }),
    };

    const { fake, ask } = await mount([failing]);

    fake.receive("boom");
    await fake.settle();

    assert.match(await ask("sys stats"), /err 1/);
  });

  test("lists the mounted modules and what they do", async () => {
    const { ask } = await mount([
      moduleNamed("weather", ["t"], "Live conditions from a Tempest station"),
      moduleNamed("directory", ["services"], "Registry of services on this mesh"),
    ]);

    const reply = await ask("sys modules");

    assert.match(reply, /weather: Live conditions/);
    assert.match(reply, /directory: Registry of services/);
  });

  test("says so when nothing is mounted", async () => {
    const { ask } = await mount();

    assert.equal(await ask("sys modules"), "No modules mounted");
  });

  test("paginates a long module list", async () => {
    const many = Array.from({ length: 10 }, (unused, index) =>
      moduleNamed(`module${index}`, [`command${index}`], `does the ${index} thing for this mesh`),
    );

    const { ask } = await mount(many);

    assert.match(await ask("sys modules"), /\(1\/\d\) sys modules 2/);
    assert.match(await ask("sys modules 2"), /\(2\/\d\)/);
  });

  test("ignores an unknown subcommand rather than failing", async () => {
    const { ask } = await mount();

    assert.match(await ask("sys nonsense"), /meshthings 1\.2\.3/);
  });

  test("reports dev when no version was supplied", async () => {
    const { ask } = await mount([], { version: undefined });

    assert.match(await ask("sys"), /meshthings dev/);
  });

  test("gives way to a module that wants the word", async () => {
    const { ask } = await mount([moduleNamed("sysadmin", ["sys"])]);

    assert.equal(await ask("sys"), "sysadmin");
  });
});

describe("built-ins in help", () => {
  test("are listed alongside the modules", async () => {
    const { ask } = await mount([moduleNamed("weather", ["t"])]);

    const help = await ask("help");

    assert.match(help, /core: help/);
    assert.match(help, /ping/);
    assert.match(help, /sys/);
    assert.match(help, /weather: t/);
  });

  test("omit a word a module took", async () => {
    const { ask } = await mount([moduleNamed("games", ["ping"])]);

    const help = await ask("help");

    assert.ok(!/core:.*ping/.test(help), `core should not claim ping: ${help}`);
    assert.match(help, /games: ping/);
  });
});

describe("stats endpoint data", () => {
  test("exposes uptime and start time for the web server", async () => {
    const { thing, advance } = await mount();

    advance(90 * 1000);

    const stats = thing.getStats();

    assert.equal(stats.startedAt, START);
    assert.equal(stats.uptimeMs, 90 * 1000);
  });
});
