import { DatabaseHandle, openDatabase } from "./db.js";
import { Command, CommandContext } from "./meshthing.js";
import { byteLength, truncateBytes } from "./text.js";

// Nodes that asked to be sent something unprompted. The directory's listings and
// an alert app's recipient list are the same shape, so they share this.
//
// A store is scoped to one topic and cannot be talked out of it. The topic used
// to be a defaulted parameter on both the store and its commands, which meant
// the two could disagree -- subscriptions written to one topic while every read
// looked at another, so nobody was ever sent anything and nothing said so. One
// database serves several topics by opening a store per topic over the same
// handle; that is cheap, and it reads better than passing the topic everywhere.

// Room for a FIPS list or an event-code filter, not an essay
const MAX_FILTER_BYTES = 96;

type Subscription = {
  nodeNum: number;
  topic: string;
  // App-specific matching data -- NOAA alerts put county FIPS codes here
  filter: string | null;
  createdAt: number;
};

type SubscriptionRow = {
  node_num: number;
  topic: string;
  filter: string | null;
  created_at: number;
};

function toSubscription(row: SubscriptionRow): Subscription {
  return { nodeNum: row.node_num, topic: row.topic, filter: row.filter, createdAt: row.created_at };
}

function createSubscriptionsTable(db: DatabaseHandle) {
  db.exec(`CREATE TABLE IF NOT EXISTS subscriptions (
    node_num INTEGER NOT NULL,
    topic TEXT NOT NULL COLLATE NOCASE,
    filter TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (node_num, topic)
  )`);
}

function createSubscribers(database: string | DatabaseHandle, topic: string) {
  const db = openDatabase(database);

  createSubscriptionsTable(db);

  const upsert = db.prepare(`INSERT INTO subscriptions (node_num, topic, filter, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(node_num, topic) DO UPDATE SET filter = excluded.filter`);
  const remove = db.prepare("DELETE FROM subscriptions WHERE node_num = ? AND topic = ?");
  const selectOne = db.prepare("SELECT * FROM subscriptions WHERE node_num = ? AND topic = ?");
  const selectAll = db.prepare("SELECT * FROM subscriptions WHERE topic = ? ORDER BY created_at");
  const clearAll = db.prepare("DELETE FROM subscriptions WHERE topic = ?");

  function subscribe(nodeNum: number, filter?: string): Subscription {
    const trimmed = filter?.trim();

    upsert.run(nodeNum, topic, trimmed ? truncateBytes(trimmed, MAX_FILTER_BYTES) : null, Date.now());

    return get(nodeNum)!;
  }

  function unsubscribe(nodeNum: number) {
    return remove.run(nodeNum, topic).changes > 0;
  }

  function get(nodeNum: number): Subscription | undefined {
    const row = selectOne.get(nodeNum, topic) as SubscriptionRow | undefined;

    return row ? toSubscription(row) : undefined;
  }

  function isSubscribed(nodeNum: number) {
    return get(nodeNum) !== undefined;
  }

  function list(): Subscription[] {
    return (selectAll.all(topic) as SubscriptionRow[]).map(toSubscription);
  }

  // Shaped for handing straight to meshThing.sendMany()
  function nodes() {
    return list().map((subscription) => subscription.nodeNum);
  }

  // Same, but only nodes whose filter accepts this event
  function matching(predicate: (filter: string | null, subscription: Subscription) => boolean) {
    return list()
      .filter((subscription) => predicate(subscription.filter, subscription))
      .map((subscription) => subscription.nodeNum);
  }

  function count() {
    return list().length;
  }

  function clear() {
    return clearAll.run(topic).changes;
  }

  return { topic, subscribe, unsubscribe, get, isSubscribed, list, nodes, matching, count, clear, db };
}

// Genuinely cross-topic, so it takes the database rather than a store -- for a
// node that wants out of everything at once
function unsubscribeEverywhere(database: string | DatabaseHandle, nodeNum: number) {
  const db = openDatabase(database);

  createSubscriptionsTable(db);

  return db.prepare("DELETE FROM subscriptions WHERE node_num = ?").run(nodeNum).changes;
}

type Subscribers = ReturnType<typeof createSubscribers>;

type SubscriptionCommandOptions = {
  // What the node is signing up for, used in confirmations. Keep it short --
  // it shares a 180 byte packet with the rest of the reply.
  label?: string;
  subscribeWords?: string[];
  unsubscribeWords?: string[];
  statusWords?: string[];
  // Validate the filter text a node supplies; return an error string to reject
  validateFilter?: (filter: string) => string | undefined;
};

// Ready-made on-mesh commands, so an app doesn't rewrite subscribe/unsubscribe.
// The topic comes from the store: there is no way to point these at a different
// one, because doing so by accident was silent and total.
function subscriptionCommands(subscribers: Subscribers, options: SubscriptionCommandOptions = {}): Command[] {
  const label = options.label ?? "alerts";

  function subscribe(args: string[], context: CommandContext) {
    const filter = args.join(" ").trim();

    if (filter && options.validateFilter) {
      const problem = options.validateFilter(filter);

      if (problem) {
        return problem;
      }
    }

    if (byteLength(filter) > MAX_FILTER_BYTES) {
      return `Filter too long (max ${MAX_FILTER_BYTES} chars)`;
    }

    const subscription = subscribers.subscribe(context.from, filter);

    return subscription.filter
      ? `Subscribed to ${label} (${subscription.filter}). Send "unsubscribe" to stop.`
      : `Subscribed to ${label}. Send "unsubscribe" to stop.`;
  }

  function unsubscribe(args: string[], context: CommandContext) {
    return subscribers.unsubscribe(context.from)
      ? `Unsubscribed from ${label}.`
      : `You are not subscribed to ${label}.`;
  }

  function status(args: string[], context: CommandContext) {
    const subscription = subscribers.get(context.from);

    if (!subscription) {
      return `Not subscribed. Send "subscribe" to get ${label}.`;
    }

    const filter = subscription.filter ? ` (${subscription.filter})` : "";

    return `Subscribed to ${label}${filter}. ${subscribers.count()} nodes total.`;
  }

  return [
    { commandStrings: options.subscribeWords ?? ["subscribe", "sub"], commandFunction: subscribe },
    { commandStrings: options.unsubscribeWords ?? ["unsubscribe", "unsub"], commandFunction: unsubscribe },
    { commandStrings: options.statusWords ?? ["status"], commandFunction: status },
  ];
}

export type { Subscribers, Subscription, SubscriptionCommandOptions };

export { createSubscribers, subscriptionCommands, unsubscribeEverywhere, MAX_FILTER_BYTES };
