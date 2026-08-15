import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { createDirectory } from "../../things/directory/index.js";
import { openDatabase } from "../db.js";
import { createSubscribers } from "../subscribers.js";

// node:sqlite finalizes a database's prepared statements when the handle is
// collected. These force the collection that otherwise happens at an
// unpredictable moment -- which is exactly how this surfaced: as an
// intermittent "statement has been finalized" under parallel test load.
function collectGarbage() {
  assert.equal(typeof global.gc, "function", "run the suite with --expose-gc");

  for (let pass = 0; pass < 3; pass++) {
    global.gc!();
  }
}

describe("surviving garbage collection", () => {
  test("keeps a directory's statements usable after a collection", async () => {
    const directory = createDirectory(":memory:");
    const register = directory.find((command) => command.commandStrings.includes("register"))!;
    const whois = directory.find((command) => command.commandStrings.includes("whois"))!;
    const context = { from: 111 } as never;

    await register.commandFunction(["tides", "Tide", "times"], context);

    collectGarbage();

    assert.match(String(await whois.commandFunction(["tides"], context)), /Tide times/);
  });

  test("keeps a subscriber store usable after a collection", () => {
    const subscribers = createSubscribers(":memory:");

    subscribers.subscribe(111, { filter: "023005" });

    collectGarbage();

    assert.equal(subscribers.get(111)?.filter, "023005");
    assert.deepEqual(subscribers.nodes(), [111]);
  });

  test("keeps a bare handle's statements usable after a collection", () => {
    const db = openDatabase(":memory:");

    db.exec("CREATE TABLE t (a INTEGER)");

    const insert = db.prepare("INSERT INTO t VALUES (?)");
    const count = db.prepare("SELECT count(*) AS n FROM t");

    insert.run(1);

    collectGarbage();

    insert.run(2);

    assert.equal((count.get() as { n: number }).n, 2);
  });
});
