import { byteLength, CommandContext, CommandMap, DatabaseHandle, MAX_TEXT_BYTES, MeshThingModule, openDatabase, paginate, parsePage, truncateBytes } from "../../core/index.js";

const MAX_REPLY_BYTES = MAX_TEXT_BYTES;
const MAX_NAME_BYTES = 24;
const MAX_DESCRIPTION_BYTES = 96;
// Listings trade detail for density -- `whois` has the full record
const LIST_LINE_BYTES = 56;

type ServiceRow = {
  node_num: number;
  name: string;
  description: string;
  updated_at: number;
};

// Meshtastic renders node numbers as !<8 hex digits>
function formatNodeId(nodeNum: number) {
  return "!" + (nodeNum >>> 0).toString(16).padStart(8, "0");
}

function createDirectory(database: string | DatabaseHandle = "directory.db"): CommandMap {
  const db = openDatabase(database);

  db.exec(`CREATE TABLE IF NOT EXISTS services (
    node_num INTEGER PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    description TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);

  const upsert = db.prepare(`INSERT INTO services (node_num, name, description, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(node_num) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      updated_at = excluded.updated_at`);
  const remove = db.prepare("DELETE FROM services WHERE node_num = ?");
  const selectAll = db.prepare("SELECT * FROM services ORDER BY name");
  const selectByName = db.prepare("SELECT * FROM services WHERE name = ?");
  const selectOwnerOfName = db.prepare("SELECT node_num FROM services WHERE name = ?");
  const search = db.prepare(`SELECT * FROM services
    WHERE name LIKE ? OR description LIKE ?
    ORDER BY name`);

  function listLine(row: ServiceRow) {
    return truncateBytes(`${row.name} - ${row.description}`, LIST_LINE_BYTES);
  }

  function register(args: string[], context: CommandContext) {
    const name = args[0];
    const description = args.slice(1).join(" ").trim();

    if (!name || !description) {
      return "Usage: register <name> <what it does>";
    }

    if (byteLength(name) > MAX_NAME_BYTES) {
      return `Name too long (max ${MAX_NAME_BYTES} chars)`;
    }

    const owner = selectOwnerOfName.get(name) as { node_num: number } | undefined;

    if (owner && owner.node_num !== context.from) {
      return `"${name}" is already registered by ${formatNodeId(owner.node_num)}`;
    }

    upsert.run(context.from, name, truncateBytes(description, MAX_DESCRIPTION_BYTES), Date.now());

    return `Registered "${name}" to ${formatNodeId(context.from)}. Send "services" to see the directory.`;
  }

  function unregister(args: string[], context: CommandContext) {
    const result = remove.run(context.from);

    return result.changes > 0 ? "Removed your listing." : "You have no listing to remove.";
  }

  function services(args: string[]) {
    const rows = selectAll.all() as ServiceRow[];

    if (rows.length === 0) {
      return "No services registered yet. Send: register <name> <what it does>";
    }

    return paginate(rows.map(listLine), parsePage(args), "services", MAX_REPLY_BYTES);
  }

  function find(args: string[]) {
    const term = args.join(" ").trim();

    if (!term) {
      return "Usage: find <term>";
    }

    const rows = search.all(`%${term}%`, `%${term}%`) as ServiceRow[];

    if (rows.length === 0) {
      return `Nothing matches "${truncateBytes(term, 32)}"`;
    }

    return paginate(rows.map(listLine), 1, "find", MAX_REPLY_BYTES);
  }

  function whois(args: string[]) {
    const name = args[0];

    if (!name) {
      return "Usage: whois <name>";
    }

    const row = selectByName.get(name) as ServiceRow | undefined;

    if (!row) {
      return `No service named "${truncateBytes(name, 32)}"`;
    }

    const days = Math.floor((Date.now() - row.updated_at) / (24 * 60 * 60 * 1000));

    return truncateBytes(`${row.name} ${formatNodeId(row.node_num)}\n${row.description}\nupdated ${days}d ago`, MAX_REPLY_BYTES);
  }

  function help() {
    return "Directory: services | find <term> | whois <name> | register <name> <desc> | unregister";
  }

  return {
    commands: [
      { commandStrings: ["services", "dir", "ls"], commandFunction: services },
      { commandStrings: ["find", "search"], commandFunction: find },
      { commandStrings: ["whois", "who"], commandFunction: whois },
      { commandStrings: ["register", "reg"], commandFunction: register },
      { commandStrings: ["unregister", "unreg"], commandFunction: unregister },
    ],
    default: help,
  };
}

type DirectoryConfig = {
  database?: string | DatabaseHandle;
};

const directoryModule: MeshThingModule<DirectoryConfig> = {
  name: "directory",
  description: "Registry of the services running on this mesh",

  create({ config }) {
    // The help default is dropped -- with several modules mounted, the core
    // aggregates help across all of them
    return { commands: createDirectory(config?.database ?? "directory.db").commands };
  },
};

export type { DirectoryConfig };

export { createDirectory, directoryModule };
