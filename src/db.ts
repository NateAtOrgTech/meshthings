import { DatabaseSync } from "node:sqlite";

// SQLite comes with Node, so nothing here compiles a native module. That
// matters most on the hardware this actually runs on -- a Pi should not need a
// toolchain to install a meshthing.
type DatabaseHandle = DatabaseSync;

// node:sqlite finalizes a database's prepared statements when the database
// handle itself is garbage collected, and a StatementSync does not keep its
// database alive. A module that prepares its statements at startup and then
// only refers to those statements -- the obvious way to write one -- loses its
// handle to the collector and every query afterwards throws "statement has
// been finalized", at whatever random moment GC happens to run.
//
// Holding the handles here makes that impossible. It is the wrong thing to
// leave to each meshthing to remember, because forgetting it produces a fault
// that appears only under memory pressure and never in a quick test.
const openHandles = new Set<DatabaseHandle>();

// Accepting a handle as well as a path lets one process share a single file
// across modules -- the alert app wants its subscribers and its own state
// together, not in two databases.
function openDatabase(target: string | DatabaseHandle): DatabaseHandle {
  if (typeof target !== "string") {
    return target;
  }

  const db = new DatabaseSync(target);

  db.exec("PRAGMA journal_mode = WAL");
  openHandles.add(db);

  return db;
}

// Release a handle deliberately. Only for a database this process opened and
// is finished with -- closing one another module is still using will break it.
function closeDatabase(db: DatabaseHandle) {
  openHandles.delete(db);
  db.close();
}

export type { DatabaseHandle };

export { openDatabase, closeDatabase };
