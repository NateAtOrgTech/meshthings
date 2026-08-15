import Database from "better-sqlite3";

type DatabaseHandle = Database.Database;

// Accepting a handle as well as a path lets one process share a single file
// across modules -- the alert app wants its subscribers and its own state
// together, not in two databases.
function openDatabase(target: string | DatabaseHandle): DatabaseHandle {
  if (typeof target !== "string") {
    return target;
  }

  const db = new Database(target);

  db.pragma("journal_mode = WAL");

  return db;
}

export type { DatabaseHandle };

export { openDatabase };
