import { DatabaseSync } from "node:sqlite";

// SQLite comes with Node, so nothing here compiles a native module. That
// matters most on the hardware this actually runs on -- a Pi should not need a
// toolchain to install a meshthing.
type DatabaseHandle = DatabaseSync;

// Accepting a handle as well as a path lets one process share a single file
// across modules -- the alert app wants its subscribers and its own state
// together, not in two databases.
function openDatabase(target: string | DatabaseHandle): DatabaseHandle {
  if (typeof target !== "string") {
    return target;
  }

  const db = new DatabaseSync(target);

  db.exec("PRAGMA journal_mode = WAL");

  return db;
}

export type { DatabaseHandle };

export { openDatabase };
