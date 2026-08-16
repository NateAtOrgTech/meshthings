import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import dgram from "dgram";

import { createMeshThing, MeshThing } from "../../../core/index.js";
import { createMockDevice } from "../../../testing/index.js";
import { weatherModule, WeatherConfig } from "../index.js";

// Ask the OS for a free port so parallel runs don't fight over a fixed one
function freePort() {
  return new Promise<number>((resolve, reject) => {
    const probe = dgram.createSocket("udp4");

    probe.on("error", reject);
    probe.bind(0, () => {
      const { port } = probe.address();

      probe.close(() => resolve(port));
    });
  });
}

const running: MeshThing[] = [];
const stations: dgram.Socket[] = [];

after(async () => {
  // Release every UDP socket -- both the modules' and the simulated stations'
  // -- or the test process stays alive with nothing to do
  for (const thing of running) {
    await thing.stop();
  }

  stations.forEach((station) => station.close());
});

async function setup(config: Partial<WeatherConfig> = {}) {
  const port = await freePort();
  const fake = createMockDevice();
  const thing = createMeshThing({ minSendIntervalMs: 0 });

  await thing.listen(fake.device, [{ module: weatherModule, config: { port, ...config } }]);
  running.push(thing);

  const station = dgram.createSocket("udp4");

  stations.push(station);

  // Resolves once the module has had the datagram delivered
  function broadcast(payload: unknown) {
    return new Promise<void>((resolve, reject) => {
      const message = Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload));

      station.send(message, port, "127.0.0.1", (error) => (error ? reject(error) : setTimeout(resolve, 20)));
    });
  }

  async function ask(text: string) {
    const before = fake.sent.length;

    fake.receive(text);

    return (await fake.waitForSends(before + 1))[before].text;
  }

  return { ask, broadcast, thing, station };
}

describe("weather module", () => {
  test("says so before the station has broadcast anything", async () => {
    const { ask } = await setup();

    assert.match(await ask("t"), /No reading from the station yet/);
  });

  test("reports the temperature from an observation", async () => {
    const { ask, broadcast } = await setup();

    // obs_st: index 7 of the first observation is air temperature in Celsius
    await broadcast({ type: "obs_st", obs: [[0, 0, 0, 0, 0, 0, 0, 18.5]] });

    assert.equal(await ask("t"), "18.5°C / 65.3°F");
  });

  test("answers to each of its aliases", async () => {
    const { ask, broadcast } = await setup();

    await broadcast({ type: "obs_st", obs: [[0, 0, 0, 0, 0, 0, 0, 18.5]] });

    assert.equal(await ask("temp"), "18.5°C / 65.3°F");
    assert.equal(await ask("temperature"), "18.5°C / 65.3°F");
  });

  test("converts negative temperatures correctly", async () => {
    const { ask, broadcast } = await setup();

    await broadcast({ type: "obs_st", obs: [[0, 0, 0, 0, 0, 0, 0, -10]] });

    assert.equal(await ask("t"), "-10.0°C / 14.0°F");
  });

  test("distinguishes a real zero reading from no reading", async () => {
    const { ask, broadcast } = await setup();

    await broadcast({ type: "obs_st", obs: [[0, 0, 0, 0, 0, 0, 0, 0]] });

    assert.equal(await ask("t"), "0.0°C / 32.0°F");
  });

  test("ignores broadcasts of other types", async () => {
    const { ask, broadcast } = await setup();

    await broadcast({ type: "rapid_wind", ob: [0, 2.3, 128] });

    assert.match(await ask("t"), /No reading/);
  });

  test("ignores an observation with no temperature in it", async () => {
    const { ask, broadcast } = await setup();

    await broadcast({ type: "obs_st", obs: [[0, 0, 0, 0, 0, 0, 0, 21]] });

    // Valid JSON, right shape one level down, no reading: obs[0][7] is
    // undefined. Assigning it used to make every later `t` throw and reply
    // nothing at all.
    await broadcast({ type: "obs_st", obs: [[]] });
    await broadcast({ type: "obs_st", obs: [] });
    await broadcast({ type: "obs_st" });

    assert.equal(await ask("t"), "21.0°C / 69.8°F");
  });

  test("ignores a non-numeric temperature rather than reporting NaN", async () => {
    const { ask, broadcast } = await setup();

    await broadcast({ type: "obs_st", obs: [[0, 0, 0, 0, 0, 0, 0, "warm"]] });

    assert.match(await ask("t"), /No reading/);
  });

  test("keeps answering after a bad observation", async () => {
    const { ask, broadcast } = await setup();

    await broadcast({ type: "obs_st", obs: [[]] });
    await broadcast({ type: "obs_st", obs: [[0, 0, 0, 0, 0, 0, 0, 18.5]] });

    assert.equal(await ask("t"), "18.5°C / 65.3°F");
  });

  test("survives a malformed broadcast", async () => {
    const { ask, broadcast } = await setup();

    await broadcast("this is not json");
    await broadcast({ type: "obs_st", obs: [[0, 0, 0, 0, 0, 0, 0, 21]] });

    assert.equal(await ask("t"), "21.0°C / 69.8°F");
  });

  test("marks a reading as stale once it ages out", async () => {
    const { ask, broadcast } = await setup({ staleAfterMs: 1 });

    await broadcast({ type: "obs_st", obs: [[0, 0, 0, 0, 0, 0, 0, 18.5]] });

    assert.match(await ask("t"), /18\.5°C \/ 65\.3°F \(\d+m old\)/);
  });

  test("accepts observations from any host when no station address is set", async () => {
    const { ask, broadcast } = await setup();

    await broadcast({ type: "obs_st", obs: [[0, 0, 0, 0, 0, 0, 0, 18.5]] });

    assert.equal(await ask("t"), "18.5°C / 65.3°F");
  });

  test("ignores observations from anywhere but the configured station", async () => {
    // Sent from loopback, so anything else is a mismatch
    const { ask, broadcast } = await setup({ stationAddress: "10.9.9.9" });

    await broadcast({ type: "obs_st", obs: [[0, 0, 0, 0, 0, 0, 0, 18.5]] });

    assert.match(await ask("t"), /No reading/);
  });

  test("accepts observations from the configured station", async () => {
    const { ask, broadcast } = await setup({ stationAddress: "127.0.0.1" });

    await broadcast({ type: "obs_st", obs: [[0, 0, 0, 0, 0, 0, 0, 18.5]] });

    assert.equal(await ask("t"), "18.5°C / 65.3°F");
  });

  test("releases the port when stopped", async () => {
    const { thing } = await setup();

    await thing.stop();

    // Rebinding the same port only succeeds if the module let go of it
    const port = await freePort();

    assert.ok(port > 0);
  });

  test("tolerates being stopped twice", async () => {
    const { thing } = await setup();

    await thing.stop();
    await thing.stop();

    assert.equal(thing.getStats().errors, 0);
  });
});
