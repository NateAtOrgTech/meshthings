import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { createMeshThing, MeshThingModule, ModuleHealth } from "../meshthing.js";
import { createMockDevice } from "../../testing/index.js";

function reporting(name: string, health: () => ModuleHealth): MeshThingModule {
  return { name, description: name, create: () => ({ commands: [], health }) };
}

function silent(name: string): MeshThingModule {
  return { name, description: name, create: () => ({ commands: [] }) };
}

async function mount(modules: MeshThingModule[]) {
  const mock = createMockDevice();
  const thing = createMeshThing({ minSendIntervalMs: 0 });

  await thing.listen(mock.device, modules);

  return thing;
}

describe("aggregating module health", () => {
  test("is healthy when every reporting module is", async () => {
    const thing = await mount([
      reporting("alerts", () => ({ ok: true, detail: "last weekly test 2d ago" })),
      reporting("tides", () => ({ ok: true, detail: "fetched 3m ago" })),
    ]);

    const health = thing.getHealth();

    assert.equal(health.ok, true);
    assert.equal(health.modules.length, 2);
  });

  test("is unhealthy when any single module is", async () => {
    const thing = await mount([
      reporting("alerts", () => ({ ok: false, detail: "no weekly test in 12d" })),
      reporting("tides", () => ({ ok: true, detail: "fetched 3m ago" })),
    ]);

    assert.equal(thing.getHealth().ok, false);
  });

  test("carries the detail, since that is what someone woken up needs", async () => {
    const thing = await mount([reporting("alerts", () => ({ ok: false, detail: "the receive chain is broken" }))]);

    assert.match(thing.getHealth().modules[0].detail, /receive chain is broken/);
  });

  test("leaves out modules with no opinion rather than calling them fine", async () => {
    const thing = await mount([silent("weather"), reporting("alerts", () => ({ ok: true, detail: "ok" }))]);

    const health = thing.getHealth();

    assert.deepEqual(
      health.modules.map((module) => module.name),
      ["alerts"],
    );
  });

  test("is healthy when nothing reports at all", async () => {
    const thing = await mount([silent("weather"), silent("directory")]);

    assert.deepEqual(thing.getHealth(), { ok: true, modules: [] });
  });

  test("treats a health check that throws as a fault, not as a crash", async () => {
    const thing = await mount([
      reporting("broken", () => {
        throw new Error("could not read the state");
      }),
      reporting("fine", () => ({ ok: true, detail: "ok" })),
    ]);

    const health = thing.getHealth();

    assert.equal(health.ok, false);
    assert.match(health.modules[0].detail, /health check failed.*could not read the state/);
    // The rest still reported
    assert.equal(health.modules[1].ok, true);
  });
});
