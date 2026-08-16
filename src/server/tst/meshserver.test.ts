import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { createStatsServer, meshServer, version } from "../meshserver.js";
import { createMeshThing } from "../../core/index.js";
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
