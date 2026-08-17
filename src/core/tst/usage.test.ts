import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { commandsModule, createMeshThing } from "../meshthing.js";
import { createUsageLog, dayOf } from "../usage.js";
import { openDatabase } from "../db.js";
import { createMockDevice } from "../../testing/index.js";

const DAY = 24 * 60 * 60 * 1000;
const START = Date.UTC(2026, 0, 15, 12, 0);

function log(retentionDays = 90, clock = { at: START }) {
  return createUsageLog({ database: ":memory:", retentionDays, now: () => clock.at });
}

describe("counting what the node is used for", () => {
  test("counts a command against its module", () => {
    const usage = log();

    usage.recordCommand(111, "weather", "t");
    usage.recordCommand(222, "weather", "t");
    usage.recordCommand(333, "directory", "services");

    const report = usage.summary();

    assert.equal(report.total, 3);
    assert.deepEqual(report.commands[0], { module: "weather", command: "t", count: 3 - 1 });
    assert.ok(report.commands.some((entry) => entry.module === "directory" && entry.count === 1));
  });

  test("orders by how much each command is actually used", () => {
    const usage = log();

    for (let call = 0; call < 5; call++) {
      usage.recordCommand(111, "weather", "t");
    }

    usage.recordCommand(111, "directory", "services");

    assert.equal(usage.summary().commands[0].command, "t");
  });

  test("counts a node once a day however often it asks", () => {
    const usage = log();

    for (let call = 0; call < 10; call++) {
      usage.recordCommand(111, "weather", "t");
    }

    const report = usage.summary();

    assert.equal(report.clients, 1);
    assert.equal(report.total, 10);
  });

  test("counts distinct nodes as reach", () => {
    const usage = log();

    [111, 222, 333, 111].forEach((node) => usage.recordCommand(node, "weather", "t"));

    assert.equal(usage.summary().clients, 3);
  });
});

describe("what is deliberately not stored", () => {
  test("an unrecognised command is counted without its text", () => {
    const usage = log();

    usage.recordUnknown(111);
    usage.recordUnknown(222);

    const report = usage.summary();

    // The text of an unrecognised command is just whatever somebody typed, and
    // may be a message meant for a person. Only the count is useful.
    assert.deepEqual(report.commands, [{ module: "core", command: "(unrecognised)", count: 2 }]);
  });

  test("nothing a user typed can reach the database", () => {
    const usage = log();

    usage.recordUnknown(111);

    const rows = usage.db.prepare("SELECT command FROM usage_commands").all() as { command: string }[];

    rows.forEach((row) => assert.equal(row.command, "(unrecognised)"));
  });
});

describe("retention", () => {
  test("keeps days inside the window and drops the rest", () => {
    const clock = { at: START };
    const usage = log(30, clock);

    usage.recordCommand(111, "weather", "t");

    clock.at = START + 40 * DAY;

    assert.ok(usage.prune() > 0, "expected the old rows to be removed");
    assert.equal(usage.summary(30).total, 0);
  });

  test("forgets who was asking, not just what they asked", () => {
    const clock = { at: START };
    const usage = log(30, clock);

    usage.recordCommand(111, "weather", "t");

    clock.at = START + 40 * DAY;
    usage.prune();

    const rows = usage.db.prepare("SELECT node_num FROM usage_clients").all();

    assert.deepEqual(rows, [], "node numbers outlived the retention window");
  });

  test("a summary cannot look further back than retention allows", () => {
    const clock = { at: START };
    const usage = log(30, clock);

    usage.recordCommand(111, "weather", "t");

    clock.at = START + 10 * DAY;

    assert.equal(usage.summary(7).total, 0, "a 7 day window should not see a 10 day old command");
    assert.equal(usage.summary(30).total, 1);
  });

  test("buckets by UTC day", () => {
    assert.equal(dayOf(Date.UTC(2026, 0, 15, 23, 59)), "2026-01-15");
    assert.equal(dayOf(Date.UTC(2026, 0, 16, 0, 1)), "2026-01-16");
  });
});

describe("recording through a running node", () => {
  async function node(recording = true) {
    const mock = createMockDevice();
    const usage = recording ? createUsageLog({ database: openDatabase(":memory:") }) : undefined;
    const thing = createMeshThing({ minSendIntervalMs: 0, usage });

    await thing.listen(mock.device, [
      commandsModule("weather", "weather", [{ commandStrings: ["t", "temp"], commandFunction: () => "18.5°C" }]),
    ]);

    async function ask(text: string, from = 0x1000) {
      const before = mock.sent.length;

      mock.receive(text, { from });
      await mock.settle(15);

      return mock.sent.slice(before).map((message) => message.text);
    }

    return { usage, ask };
  }

  test("records real commands against the module that answered", async () => {
    const { usage, ask } = await node();

    await ask("t", 111);
    await ask("temp", 222);

    const report = usage!.summary();

    assert.equal(report.total, 2);
    assert.equal(report.clients, 2);
    assert.ok(report.commands.every((entry) => entry.module === "weather"));
  });

  test("keeps aliases apart, since which one people reach for is the point", async () => {
    const { usage, ask } = await node();

    await ask("t");
    await ask("temp");

    assert.deepEqual(
      usage!.summary().commands.map((entry) => entry.command).sort(),
      ["t", "temp"],
    );
  });

  test("counts a rate-limited unknown command, because someone still asked", async () => {
    const { usage, ask } = await node();

    await ask("what is this", 111);
    // Second one gets no reply thanks to the loop guard -- it is still usage
    await ask("still confused", 111);

    const unrecognised = usage!.summary().commands.find((entry) => entry.command === "(unrecognised)");

    assert.equal(unrecognised?.count, 2);
  });

  test("records nothing at all when no log is configured", async () => {
    const { usage, ask } = await node(false);

    await ask("t");

    assert.equal(usage, undefined);
  });

  test("does not answer usage questions over the mesh", async () => {
    const { ask } = await node();

    // Usage is operator business and lives on the web page. Answering it here
    // would publish reach and command counts to anyone who asked.
    const reply = (await ask("sys usage"))[0] ?? "";

    // The in-memory counters sys already reports are fine -- they are about the
    // process. What must not appear is reach, or a per-command breakdown.
    assert.ok(!/\d+d: \d+ cmds, \d+ nodes/.test(reply), `sys answered a usage question: ${reply}`);
    assert.ok(!/nodes/.test(reply), `sys leaked reach: ${reply}`);
    assert.match(reply, /meshthings/, "sys itself should still work");
  });
});
