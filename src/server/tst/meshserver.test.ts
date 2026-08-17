import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { createStatsServer, meshServer, version } from "../meshserver.js";
import { createMeshThing, createUsageLog, MeshThingModule, openDatabase } from "../../core/index.js";
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

describe("the health endpoint", () => {
  async function serve(modules: MeshThingModule[] = []) {
    const mock = createMockDevice();
    const thing = createMeshThing({ minSendIntervalMs: 0 });

    await thing.listen(mock.device, modules);

    const server = await createStatsServer(thing, 0);
    const { port } = server.address() as { port: number };

    return {
      close: () => server.close(),
      get: async (path: string) => {
        const response = await fetch(`http://127.0.0.1:${port}${path}`);

        return { status: response.status, body: await response.json() };
      },
    };
  }

  const reporting = (name: string, ok: boolean, detail: string): MeshThingModule => ({
    name,
    description: name,
    create: () => ({ commands: [], health: () => ({ ok, detail }) }),
  });

  test("answers 200 when nothing is complaining", async () => {
    const { get, close } = await serve([reporting("alerts", true, "last weekly test 2d ago")]);

    try {
      const { status, body } = await get("/health");

      assert.equal(status, 200);
      assert.equal(body.ok, true);
    } finally {
      close();
    }
  });

  test("answers 503 when a module reports itself broken", async () => {
    const { get, close } = await serve([reporting("alerts", false, "no weekly test in 12d")]);

    try {
      const { status, body } = await get("/health");

      // A monitor reads the status code; the body says which and why
      assert.equal(status, 503);
      assert.equal(body.ok, false);
      assert.equal(body.modules[0].name, "alerts");
      assert.match(body.modules[0].detail, /no weekly test in 12d/);
    } finally {
      close();
    }
  });

  test("answers 200 on a node where nothing reports health", async () => {
    const { get, close } = await serve([]);

    try {
      const { status, body } = await get("/health");

      assert.equal(status, 200);
      assert.deepEqual(body, { ok: true, modules: [] });
    } finally {
      close();
    }
  });

  test("keeps the stats page answering 200 while unhealthy", async () => {
    const { get, close } = await serve([reporting("alerts", false, "broken")]);

    try {
      // / is the dashboard, not the probe -- a monitor pointed at it should not
      // be the thing that decides the node is down
      assert.equal((await get("/")).status, 200);
      assert.equal((await get("/health")).status, 503);
    } finally {
      close();
    }
  });
});

// start() was previously unreachable from a test: it created a serial transport
// itself, so nothing below it could run without a radio plugged in. The failure
// path it grew during the review -- stop the meshthing when the stats page
// cannot bind -- therefore shipped with no coverage at all.
describe("starting a node", () => {
  const stoppable = (name: string, stopped: string[]): MeshThingModule => ({
    name,
    description: name,
    create: () => ({
      commands: [{ commandStrings: "t", commandFunction: () => "18.5°C" }],
      stop: () => void stopped.push(name),
    }),
  });

  function radio() {
    const mock = createMockDevice();

    return { mock, connect: async () => mock.device };
  }

  test("brings the radio online and mounts the modules", async () => {
    const { mock, connect } = radio();
    const stopped: string[] = [];

    const thing = await meshServer.start("/dev/imaginary", [stoppable("weather", stopped)], { connect });

    try {
      assert.equal(mock.configured, true, "the device was never configured");
      assert.ok(mock.heartbeatInterval! > 0, "serial times out without a heartbeat");
      assert.deepEqual(thing.getModules(), ["weather"]);

      mock.receive("t");
      assert.equal((await mock.waitForSends(1))[0].text, "18.5°C");
    } finally {
      await thing.stop();
    }
  });

  test("reports the package version, so `sys` says what is deployed", async () => {
    const { mock, connect } = radio();

    const thing = await meshServer.start("/dev/imaginary", [], { connect });

    try {
      mock.receive("sys");

      assert.match((await mock.waitForSends(1))[0].text, new RegExp(`meshthings ${version.replace(/\./g, "\\.")}`));
    } finally {
      await thing.stop();
    }
  });

  test("serves the stats page when a port is given", async () => {
    const { connect } = radio();

    const thing = await meshServer.start("/dev/imaginary", [], { connect, httpPort: 0 });

    try {
      // Port 0 binds an arbitrary free port, so the node started and did not throw
      assert.equal(thing.getHealth().ok, true);
    } finally {
      await thing.stop();
    }
  });

  test("runs happily with no stats page at all", async () => {
    const { mock, connect } = radio();

    const thing = await meshServer.start("/dev/imaginary", [], { connect });

    try {
      assert.equal(mock.configured, true);
    } finally {
      await thing.stop();
    }
  });

  test("fails startup, and stops what it started, when the port is taken", async () => {
    const { connect } = radio();
    const stopped: string[] = [];

    const holder = createMeshThing({ minSendIntervalMs: 0 });
    const holderDevice = createMockDevice();

    await holder.listen(holderDevice.device, []);

    const held = await createStatsServer(holder, 0);
    const { port } = held.address() as { port: number };

    try {
      await assert.rejects(
        () => meshServer.start("/dev/imaginary", [stoppable("alerts", stopped)], { connect, httpPort: port }),
        /Could not start the stats page/,
      );

      // The radio was already up by then. Leaving the module running with no
      // handle to stop it would orphan its socket and its child process.
      assert.deepEqual(stopped, ["alerts"], "a started module was left running after a failed start");
    } finally {
      held.close();
      await holder.stop();
    }
  });

  test("names the port it could not bind", async () => {
    const { connect } = radio();
    const holder = createMeshThing({ minSendIntervalMs: 0 });
    const holderDevice = createMockDevice();

    await holder.listen(holderDevice.device, []);

    const held = await createStatsServer(holder, 0);
    const { port } = held.address() as { port: number };

    try {
      await assert.rejects(
        () => meshServer.start("/dev/imaginary", [], { connect, httpPort: port }),
        new RegExp(String(port)),
      );
    } finally {
      held.close();
      await holder.stop();
    }
  });

  test("lets a connect failure surface rather than starting half a node", async () => {
    await assert.rejects(
      () =>
        meshServer.start("/dev/imaginary", [], {
          connect: async () => {
            throw new Error("no such device");
          },
        }),
      /no such device/,
    );
  });
});
