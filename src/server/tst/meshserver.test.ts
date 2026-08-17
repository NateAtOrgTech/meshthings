import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { createStatsServer, meshServer, version } from "../meshserver.js";
import { createMeshThing, createUsageLog, openDatabase } from "../../core/index.js";
import { createMockDevice } from "../../testing/index.js";

// The version is read with a path relative to this file, so moving meshserver
// breaks it -- silently, since nothing else imports it and the failure only
// appears when the built output is run.
describe("version reporting", () => {
  test("resolves the project's package.json", () => {
    const expected = createRequire(import.meta.url)("../../../package.json").version;

    assert.equal(version, expected);
  });

  test("reports a real version rather than undefined", () => {
    assert.match(version, /^\d+\.\d+\.\d+/);
  });

  test("exposes start", () => {
    assert.equal(typeof meshServer.start, "function");
  });
});

describe("the stats server", () => {
  async function mountedThing() {
    const mock = createMockDevice();
    const thing = createMeshThing({ minSendIntervalMs: 0 });

    await thing.listen(mock.device, []);

    return thing;
  }

  test("serves the stats a monitor would poll", async () => {
    const thing = await mountedThing();
    const server = await createStatsServer(thing, 0);
    const { port } = server.address() as { port: number };

    try {
      const body = await (await fetch(`http://127.0.0.1:${port}/`)).json();

      assert.equal(typeof body.uptimeMs, "number");
      assert.deepEqual(body.modules, []);
    } finally {
      server.close();
    }
  });

  test("rejects rather than throwing when the port is taken", async () => {
    const thing = await mountedThing();
    const held = await createStatsServer(thing, 0);
    const { port } = held.address() as { port: number };

    try {
      // Previously an unhandled 'error' event, which is an uncaught exception
      await assert.rejects(() => createStatsServer(thing, port), /EADDRINUSE/);
    } finally {
      held.close();
    }
  });
});

describe("the usage endpoint", () => {
  async function serve(recording = true) {
    const mock = createMockDevice();
    const usage = recording ? createUsageLog({ database: openDatabase(":memory:") }) : undefined;
    const thing = createMeshThing({ minSendIntervalMs: 0, usage });

    await thing.listen(mock.device, []);

    const server = await createStatsServer(thing, 0, usage);
    const { port } = server.address() as { port: number };

    return {
      usage,
      close: () => server.close(),
      get: async (path: string) => {
        const response = await fetch(`http://127.0.0.1:${port}${path}`);

        return { status: response.status, body: await response.json() };
      },
    };
  }

  test("serves the breakdown an operator would look at", async () => {
    const { usage, get, close } = await serve();

    usage!.recordCommand(111, "weather", "t");
    usage!.recordCommand(222, "weather", "t");
    usage!.recordCommand(333, "directory", "services");

    try {
      const { status, body } = await get("/usage");

      assert.equal(status, 200);
      assert.equal(body.total, 3);
      assert.equal(body.clients, 3);
      assert.deepEqual(body.commands[0], { module: "weather", command: "t", count: 2 });
      assert.equal(body.retentionDays, 90);
    } finally {
      close();
    }
  });

  test("takes a window in days", async () => {
    const { get, close } = await serve();

    try {
      assert.equal((await get("/usage?days=7")).body.days, 7);
    } finally {
      close();
    }
  });

  test("clamps a window beyond what is retained", async () => {
    const { get, close } = await serve();

    try {
      assert.equal((await get("/usage?days=100000")).body.days, 90);
      assert.equal((await get("/usage?days=nonsense")).body.days, 30);
    } finally {
      close();
    }
  });

  test("says nothing is recorded rather than reporting zeroes", async () => {
    const { get, close } = await serve(false);

    try {
      const { status, body } = await get("/usage");

      // Zeroes would read as "nobody used it", which is a different claim
      assert.equal(status, 404);
      assert.match(body.error, /not being recorded/);
    } finally {
      close();
    }
  });

  test("never carries the text of an unrecognised command", async () => {
    const { usage, get, close } = await serve();

    usage!.recordUnknown(111);

    try {
      const { body } = await get("/usage");

      assert.deepEqual(body.commands, [{ module: "core", command: "(unrecognised)", count: 1 }]);
    } finally {
      close();
    }
  });
});
