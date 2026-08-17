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
// Directed sends are paced, so recipients cost channel time: at the default 4s
// spacing, 40 is a little under three minutes of transmitting. Uncapped, a
// large subscriber list jams the channel for everyone -- during the emergency
// the alert is warning them about.
const DEFAULT_MAX_RECIPIENTS = 40;

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
  // Most subscribers one alert will be sent to before the rest are dropped
  maxRecipients?: number;
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

// Built once and validated at startup. Intl throws RangeError on an unknown
// zone, and the only place that would surface is inside the decoder's stdout
// callback, where a throw is an uncaught exception -- so an unnoticed typo in
// TIME_ZONE would kill the node at the moment the first real alert arrived.
function createTimeFormatter(timeZone: string) {
  let formatter: Intl.DateTimeFormat;

  try {
    formatter = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false });
  } catch (error) {
    throw new Error(
      `alerts: "${timeZone}" is not a valid IANA time zone (${(error as Error).message}). ` +
        "Expected something like America/New_York.",
    );
  }

  return (at: number) => formatter.format(new Date(at));
}

// The header gives codes, not prose, so the mesh message is assembled rather
// than summarised -- which is why it fits a packet comfortably.
function formatAlert(alert: SameMessage, areaNames: Record<string, string>, formatTime: (at: number) => string) {
  const names = alert.areas.map((area) => areaNames[area] ?? areaNames[area.slice(-5)] ?? area);
  const areas = truncateBytes(names.join(", "), MAX_AREA_BYTES);

  return truncateBytes(`${alert.eventName}: ${areas} until ${formatTime(alert.expiresAt)}`, MAX_TEXT_BYTES);
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
    const maxRecipients = config?.maxRecipients ?? DEFAULT_MAX_RECIPIENTS;
    const formatTime = createTimeFormatter(timeZone);

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

    const startedAt = now();
    const recent: SameMessage[] = [];
    // Every counter here is reported by `receiver`. A counter nothing reads is
    // bookkeeping that makes a module look observable when it is not.
    const health = { lastTestAt: 0, decoded: 0, suppressed: 0, errors: 0 };

    function decodeAndRelay(line: string) {
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

      recent.unshift(alert);
      recent.splice(RECENT_ALERTS_KEPT);

      // A subscriber with no filter wants everything
      const recipients = subscribers.matching((filter) =>
        filter === null ? true : areaMatches(alert.areas, filter.split(/\s+/)),
      );

      if (recipients.length === 0) {
        log(`${alert.event} for ${alert.areas.join(",")} matched no subscribers`);

        return;
      }

      // Dropping recipients is a bad outcome; jamming the channel so nobody can
      // communicate at all is a worse one. The log line is the signal that this
      // subscriber list has outgrown directed sends.
      const addressed = recipients.slice(0, maxRecipients);

      if (recipients.length > addressed.length) {
        log(
          `WARNING: ${alert.event} matched ${recipients.length} subscribers but the cap is ` +
            `${maxRecipients} -- ${recipients.length - addressed.length} were NOT sent. ` +
            "Directed fan-out has outgrown this channel.",
        );
      }

      const sent = sendMany(formatAlert(alert, areaNames, formatTime), addressed, {
        priority: alert.isImmediate ? "high" : "normal",
      });

      log(`${alert.event} sent to ${sent} of ${recipients.length} subscribers`);
    }

    // The decoder feeds us from a child-process callback, where an exception is
    // uncaught and fatal. One malformed line, or one unforeseen fault in the
    // relay path, must cost one alert rather than every alert after it.
    function handleLine(line: string) {
      try {
        decodeAndRelay(line);
      } catch (error) {
        health.errors++;
        log(`failed to relay a decoded line: ${error}`);
      }
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
        (alert) => `${alert.eventName} ${formatTime(alert.issuedAt)}`,
      );

      return paginate(lines, parsePage(args), "alerts");
    }

    function receiver() {
      if (!source) {
        return "Receiver not configured -- alerts are NOT being monitored.";
      }

      // decoded says the chain is producing output at all, suppressed confirms
      // the triple-burst dedup is working, errors surfaces the boundary
      // catching faults rather than hiding them
      const counts = `${health.decoded} decoded, ${health.suppressed} suppressed, ${health.errors} errors`;

      if (!health.lastTestAt) {
        return `No weekly test seen yet. ${subscribers.count()} subscribers. ${counts}.`;
      }

      const days = Math.floor((now() - health.lastTestAt) / (24 * 60 * 60 * 1000));
      const state = days > testIntervalDays ? "STALE" : "ok";

      return `Receiver ${state}: last test ${days}d ago. ${subscribers.count()} subscribers. ${counts}.`;
    }

    const commands: Command[] = [
      ...subscriptionCommands(subscribers, {
        label: "weather alerts",
        validateFilter: (filter) =>
          /^\d{5,6}( \d{5,6})*$/.test(filter) ? undefined : "Filter must be FIPS county codes, e.g. 023005",
      }),
      { commandStrings: ["alerts", "recent"], commandFunction: alerts },
      { commandStrings: ["receiver"], commandFunction: receiver },
    ];

    // Days since the weekly test, or since we started if none has arrived. A
    // node that has been up a fortnight without hearing one is broken whether
    // or not it ever heard one.
    function daysWithoutTest() {
      return Math.floor((now() - (health.lastTestAt || startedAt)) / (24 * 60 * 60 * 1000));
    }

    return {
      commands,

      health: () => {
        // Unconfigured is not unhealthy. An operator who deliberately runs
        // without an SDR must not get a permanent red light, or they learn to
        // ignore it -- the same reasoning that keeps the weekly test off the
        // mesh.
        if (!source) {
          return { ok: true, detail: "not monitoring: no decoder configured" };
        }

        const days = daysWithoutTest();

        if (days > testIntervalDays) {
          return {
            ok: false,
            detail: health.lastTestAt
              ? `no weekly test in ${days}d: the receive chain is broken`
              : `no weekly test since starting ${days}d ago: the receive chain has never worked`,
          };
        }

        return {
          ok: true,
          detail: health.lastTestAt ? `last weekly test ${days}d ago` : `started ${days}d ago, awaiting the weekly test`,
        };
      },

      stop: async () => {
        await source?.stop?.();
      },
    };
  },
};

export type { AlertsConfig, AlertSource, SpawnSource };

export { alertsModule, formatAlert, createSpawnSource };
