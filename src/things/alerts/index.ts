import { spawn } from "child_process";

import { Command, createSubscribers, DatabaseHandle, MAX_TEXT_BYTES, MeshThingModule, openDatabase, paginate, parsePage, subscriptionCommands, truncateBytes } from "../../core/index.js";
import { areaMatches, parseSame, SameMessage } from "./same.js";

const DEFAULT_TOPIC = "alerts";
// NOAA transmits a required weekly test. Missing several in a row means the
// receive chain is broken -- and silence is otherwise indistinguishable from
// "no emergencies", which is the dangerous failure for an alert system.
const DEFAULT_TEST_INTERVAL_DAYS = 8;
const RECENT_ALERTS_KEPT = 10;
// Leave headroom for the area list before the expiry clause
const MAX_AREA_BYTES = 60;

// Where decoded SAME lines come from. Injectable so the module can be driven by
// a real decoder, a log replay, or a test.
type AlertSource = {
  start: (onLine: (line: string) => void) => void;
  stop?: () => void | Promise<void>;
};

type SpawnSource = {
  command: string;
  args?: string[];
};

type AlertsConfig = {
  database?: string | DatabaseHandle;
  // A decoder process to spawn, or a source object to drive directly
  source?: AlertSource | SpawnSource;
  // FIPS (SSCCC or PSSCCC) to human names, for the counties this mesh covers.
  // Anything unlisted falls back to its raw code.
  areaNames?: Record<string, string>;
  // IANA zone for rendering expiry times
  timeZone?: string;
  topic?: string;
  testIntervalDays?: number;
  now?: () => number;
};

function isSpawnSource(source: AlertSource | SpawnSource): source is SpawnSource {
  return "command" in source;
}

// Runs a decoder and hands over whole lines of its stdout
function createSpawnSource({ command, args = [] }: SpawnSource, log: (message: string) => void): AlertSource {
  let child: ReturnType<typeof spawn> | undefined;

  return {
    start(onLine) {
      child = spawn(command, args);

      let buffer = "";

      child.stdout?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();

        const lines = buffer.split("\n");

        // Keep the trailing partial line for the next chunk
        buffer = lines.pop() ?? "";
        lines.forEach((line) => onLine(line));
      });

      child.stderr?.on("data", (chunk: Buffer) => log(`decoder: ${chunk.toString().trim()}`));
      child.on("error", (error) => log(`decoder failed to start: ${error.message}`));
      child.on("exit", (code) => log(`decoder exited with code ${code}`));
    },
    stop() {
      child?.kill();
    },
  };
}

function formatExpiry(at: number, timeZone: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(at));
}

// The header gives codes, not prose, so the mesh message is assembled rather
// than summarised -- which is why it fits a packet comfortably.
function formatAlert(alert: SameMessage, areaNames: Record<string, string>, timeZone: string) {
  const names = alert.areas.map((area) => areaNames[area] ?? areaNames[area.slice(-5)] ?? area);
  const areas = truncateBytes(names.join(", "), MAX_AREA_BYTES);

  return truncateBytes(
    `${alert.eventName}: ${areas} until ${formatExpiry(alert.expiresAt, timeZone)}`,
    MAX_TEXT_BYTES,
  );
}

const alertsModule: MeshThingModule<AlertsConfig> = {
  name: "alerts",
  description: "NOAA weather radio emergency alerts, pushed to subscribers",

  create({ config, sendMany, log }) {
    const topic = config?.topic ?? DEFAULT_TOPIC;
    const timeZone = config?.timeZone ?? "UTC";
    const areaNames = config?.areaNames ?? {};
    const now = config?.now ?? (() => Date.now());
    const testIntervalDays = config?.testIntervalDays ?? DEFAULT_TEST_INTERVAL_DAYS;

    const db = openDatabase(config?.database ?? "alerts.db");
    const subscribers = createSubscribers(db, topic);

    // Dedup is persisted so a crash loop cannot re-broadcast a live tornado
    // warning to everyone on every restart
    db.exec(`CREATE TABLE IF NOT EXISTS seen_alerts (
      key TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    )`);

    const markSeen = db.prepare("INSERT OR IGNORE INTO seen_alerts (key, expires_at) VALUES (?, ?)");
    const findSeen = db.prepare("SELECT key FROM seen_alerts WHERE key = ? AND expires_at > ?");
    const pruneSeen = db.prepare("DELETE FROM seen_alerts WHERE expires_at <= ?");

    const recent: SameMessage[] = [];
    const health = { lastLineAt: 0, lastTestAt: 0, lastAlertAt: 0, decoded: 0, broadcast: 0, suppressed: 0 };

    function handleLine(line: string) {
      health.lastLineAt = now();

      const alert = parseSame(line, now());

      if (!alert) {
        return;
      }

      health.decoded++;

      // Tests prove the chain works but must never reach the mesh
      if (alert.isTest) {
        health.lastTestAt = alert.issuedAt;
        log(`receiver alive: ${alert.event} from ${alert.station}`);

        return;
      }

      // Each alert is transmitted three times for error correction
      if (findSeen.get(alert.key, now())) {
        health.suppressed++;

        return;
      }

      pruneSeen.run(now());
      markSeen.run(alert.key, alert.expiresAt);

      health.lastAlertAt = alert.issuedAt;
      recent.unshift(alert);
      recent.splice(RECENT_ALERTS_KEPT);

      // A subscriber with no filter wants everything
      const recipients = subscribers.matching(topic, (filter) =>
        filter === null ? true : areaMatches(alert.areas, filter.split(/\s+/)),
      );

      if (recipients.length === 0) {
        log(`${alert.event} for ${alert.areas.join(",")} matched no subscribers`);

        return;
      }

      const sent = sendMany(formatAlert(alert, areaNames, timeZone), recipients, {
        priority: alert.isImmediate ? "high" : "normal",
      });

      health.broadcast += sent;
      log(`${alert.event} sent to ${sent} of ${recipients.length} subscribers`);
    }

    let source: AlertSource | undefined;

    if (config?.source) {
      source = isSpawnSource(config.source) ? createSpawnSource(config.source, log) : config.source;
      source.start(handleLine);
    } else {
      // Say so loudly. Subscriptions still work, but nothing will ever arrive.
      log("WARNING: no decoder source configured -- no alerts will be received");
    }

    function alerts(args: string[]) {
      if (recent.length === 0) {
        return "No alerts received.";
      }

      const lines = recent.map(
        (alert) => `${alert.eventName} ${formatExpiry(alert.issuedAt, timeZone)}`,
      );

      return paginate(lines, parsePage(args), "alerts");
    }

    function receiver() {
      if (!source) {
        return "Receiver not configured -- alerts are NOT being monitored.";
      }

      if (!health.lastTestAt) {
        return `No weekly test seen yet. ${subscribers.count(topic)} subscribers.`;
      }

      const days = Math.floor((now() - health.lastTestAt) / (24 * 60 * 60 * 1000));
      const state = days > testIntervalDays ? "STALE" : "ok";

      return `Receiver ${state}: last test ${days}d ago. ${subscribers.count(topic)} subscribers.`;
    }

    const commands: Command[] = [
      ...subscriptionCommands(subscribers, {
        topic,
        label: "weather alerts",
        validateFilter: (filter) =>
          /^\d{5,6}( \d{5,6})*$/.test(filter) ? undefined : "Filter must be FIPS county codes, e.g. 023005",
      }),
      { commandStrings: ["alerts", "recent"], commandFunction: alerts },
      { commandStrings: ["receiver"], commandFunction: receiver },
    ];

    return {
      commands,
      stop: async () => {
        await source?.stop?.();
      },
    };
  },
};

export type { AlertsConfig, AlertSource, SpawnSource };

export { alertsModule, formatAlert, createSpawnSource };
