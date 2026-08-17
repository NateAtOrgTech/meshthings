import { DatabaseHandle, openDatabase } from "./db.js";

// What the node is actually used for, kept so an operator can tell whether a
// meshthing earns its keep. Off unless a deployment supplies a database: a
// usage log is not something anyone should acquire by accident.

const DEFAULT_RETENTION_DAYS = 90;
// Pruning is cheap but not free, and the data only changes by the day
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

type UsageOptions = {
  database: string | DatabaseHandle;
  // How long a day's rows are kept. Node numbers are identities on a mesh, so
  // this is the real privacy control -- hashing them would be theatre, since
  // the space is small enough to reverse in seconds.
  retentionDays?: number;
  now?: () => number;
};

type CommandUsage = {
  module: string;
  command: string;
  count: number;
};

type UsageSummary = {
  days: number;
  total: number;
  clients: number;
  commands: CommandUsage[];
};

// UTC, so a day means the same thing regardless of where the node is or where
// the person reading the numbers is
function dayOf(at: number) {
  return new Date(at).toISOString().slice(0, 10);
}

function createUsageLog(options: UsageOptions) {
  const db = openDatabase(options.database);
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const now = options.now ?? (() => Date.now());

  db.exec(`CREATE TABLE IF NOT EXISTS usage_commands (
    day TEXT NOT NULL,
    module TEXT NOT NULL,
    command TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (day, module, command)
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS usage_clients (
    day TEXT NOT NULL,
    node_num INTEGER NOT NULL,
    PRIMARY KEY (day, node_num)
  )`);

  const countCommand = db.prepare(`INSERT INTO usage_commands (day, module, command, count)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(day, module, command) DO UPDATE SET count = count + 1`);
  const countClient = db.prepare("INSERT OR IGNORE INTO usage_clients (day, node_num) VALUES (?, ?)");
  const selectCommands = db.prepare(`SELECT module, command, SUM(count) AS count
    FROM usage_commands WHERE day >= ?
    GROUP BY module, command
    ORDER BY count DESC, command`);
  const selectClients = db.prepare("SELECT COUNT(*) AS clients FROM (SELECT DISTINCT node_num FROM usage_clients WHERE day >= ?)");
  const dropOldCommands = db.prepare("DELETE FROM usage_commands WHERE day < ?");
  const dropOldClients = db.prepare("DELETE FROM usage_clients WHERE day < ?");

  let lastPrunedAt = 0;

  function cutoff(days: number) {
    return dayOf(now() - days * 24 * 60 * 60 * 1000);
  }

  function prune() {
    const oldest = cutoff(retentionDays);

    lastPrunedAt = now();

    return Number(dropOldCommands.run(oldest).changes) + Number(dropOldClients.run(oldest).changes);
  }

  function pruneIfDue() {
    if (now() - lastPrunedAt >= PRUNE_INTERVAL_MS) {
      prune();
    }
  }

  // A command somebody actually invoked
  function recordCommand(nodeNum: number, module: string, command: string) {
    const day = dayOf(now());

    pruneIfDue();
    countCommand.run(day, module, command);
    countClient.run(day, nodeNum);
  }

  // Something nobody claimed. Deliberately NOT stored with its text: an
  // unrecognised command is just whatever a person typed, which may be a
  // message they meant for a human. The count is the useful part.
  function recordUnknown(nodeNum: number) {
    recordCommand(nodeNum, "core", "(unrecognised)");
  }

  function summary(days = 30): UsageSummary {
    const since = cutoff(days);
    // Mapped rather than returned raw: node:sqlite hands back null-prototype
    // rows, which behave oddly for anything comparing or serialising them
    const commands = (selectCommands.all(since) as CommandUsage[]).map((row) => ({
      module: row.module,
      command: row.command,
      count: Number(row.count),
    }));
    const { clients } = selectClients.get(since) as { clients: number };

    return {
      days,
      total: commands.reduce((running, entry) => running + entry.count, 0),
      clients,
      commands,
    };
  }

  prune();

  return { recordCommand, recordUnknown, summary, prune, retentionDays, db };
}

type UsageLog = ReturnType<typeof createUsageLog>;

export type { CommandUsage, UsageLog, UsageOptions, UsageSummary };

export { createUsageLog, dayOf, DEFAULT_RETENTION_DAYS };
