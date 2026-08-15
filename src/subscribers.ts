import { DatabaseHandle, openDatabase } from "./db.js";
import { byteLength, Command, CommandContext, truncateBytes } from "./meshthing.js";

// Nodes that asked to be sent something unprompted. The directory's listings and
// an alert app's recipient list are the same shape, so they share this.

const DEFAULT_TOPIC = "default";
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

type SubscribeOptions = {
  topic?: string;
  filter?: string;
};

function toSubscription(row: SubscriptionRow): Subscription {
  return { nodeNum: row.node_num, topic: row.topic, filter: row.filter, createdAt: row.created_at };
}

function createSubscribers(database: string | DatabaseHandle, defaultTopic = DEFAULT_TOPIC) {
  const db = openDatabase(database);

  db.exec(`CREATE TABLE IF NOT EXISTS subscriptions (
    node_num INTEGER NOT NULL,
    topic TEXT NOT NULL COLLATE NOCASE,
    filter TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (node_num, topic)
  )`);

  const upsert = db.prepare(`INSERT INTO subscriptions (node_num, topic, filter, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(node_num, topic) DO UPDATE SET filter = excluded.filter`);
  const remove = db.prepare("DELETE FROM subscriptions WHERE node_num = ? AND topic = ?");
  const removeAllForNode = db.prepare("DELETE FROM subscriptions WHERE node_num = ?");
  const selectOne = db.prepare("SELECT * FROM subscriptions WHERE node_num = ? AND topic = ?");
  const selectByTopic = db.prepare("SELECT * FROM subscriptions WHERE topic = ? ORDER BY created_at");
  const selectAll = db.prepare("SELECT * FROM subscriptions ORDER BY topic, created_at");
  const selectTopics = db.prepare("SELECT DISTINCT topic FROM subscriptions ORDER BY topic");
  const clearTopic = db.prepare("DELETE FROM subscriptions WHERE topic = ?");

  function subscribe(nodeNum: number, options: SubscribeOptions = {}): Subscription {
    const topic = options.topic ?? defaultTopic;
    const trimmed = options.filter?.trim();
    const filter = trimmed ? truncateBytes(trimmed, MAX_FILTER_BYTES) : null;

    upsert.run(nodeNum, topic, filter, Date.now());

    return get(nodeNum, topic)!;
  }

  function unsubscribe(nodeNum: number, topic = defaultTopic) {
    return remove.run(nodeNum, topic).changes > 0;
  }

  // For a node that wants out of everything at once
  function unsubscribeAll(nodeNum: number) {
    return removeAllForNode.run(nodeNum).changes;
  }

  function get(nodeNum: number, topic = defaultTopic): Subscription | undefined {
    const row = selectOne.get(nodeNum, topic) as SubscriptionRow | undefined;

    return row ? toSubscription(row) : undefined;
  }

  function isSubscribed(nodeNum: number, topic = defaultTopic) {
    return get(nodeNum, topic) !== undefined;
  }

  function list(topic?: string): Subscription[] {
    const rows = (topic === undefined ? selectAll.all() : selectByTopic.all(topic)) as SubscriptionRow[];

    return rows.map(toSubscription);
  }

  // Shaped for handing straight to meshThing.sendMany()
  function nodes(topic = defaultTopic) {
    return list(topic).map((subscription) => subscription.nodeNum);
  }

  // Same, but only nodes whose filter accepts this event
  function matching(topic: string, predicate: (filter: string | null, subscription: Subscription) => boolean) {
    return list(topic)
      .filter((subscription) => predicate(subscription.filter, subscription))
      .map((subscription) => subscription.nodeNum);
  }

  function count(topic = defaultTopic) {
    return list(topic).length;
  }

  function topics(): string[] {
    return (selectTopics.all() as { topic: string }[]).map((row) => row.topic);
  }

  function clear(topic?: string) {
    return topic === undefined ? db.prepare("DELETE FROM subscriptions").run().changes : clearTopic.run(topic).changes;
  }

  return {
    subscribe,
    unsubscribe,
    unsubscribeAll,
    get,
    isSubscribed,
    list,
    nodes,
    matching,
    count,
    topics,
    clear,
    db,
  };
}

type Subscribers = ReturnType<typeof createSubscribers>;

type SubscriptionCommandOptions = {
  topic?: string;
  // What the node is signing up for, used in confirmations. Keep it short --
  // it shares a 180 byte packet with the rest of the reply.
  label?: string;
  subscribeWords?: string[];
  unsubscribeWords?: string[];
  statusWords?: string[];
  // Validate the filter text a node supplies; return an error string to reject
  validateFilter?: (filter: string) => string | undefined;
};

// Ready-made on-mesh commands, so an app doesn't rewrite subscribe/unsubscribe
function subscriptionCommands(subscribers: Subscribers, options: SubscriptionCommandOptions = {}): Command[] {
  const topic = options.topic ?? DEFAULT_TOPIC;
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

    const subscription = subscribers.subscribe(context.from, { topic, filter });

    return subscription.filter
      ? `Subscribed to ${label} (${subscription.filter}). Send "unsubscribe" to stop.`
      : `Subscribed to ${label}. Send "unsubscribe" to stop.`;
  }

  function unsubscribe(args: string[], context: CommandContext) {
    return subscribers.unsubscribe(context.from, topic)
      ? `Unsubscribed from ${label}.`
      : `You are not subscribed to ${label}.`;
  }

  function status(args: string[], context: CommandContext) {
    const subscription = subscribers.get(context.from, topic);

    if (!subscription) {
      return `Not subscribed. Send "subscribe" to get ${label}.`;
    }

    const filter = subscription.filter ? ` (${subscription.filter})` : "";

    return `Subscribed to ${label}${filter}. ${subscribers.count(topic)} nodes total.`;
  }

  return [
    { commandStrings: options.subscribeWords ?? ["subscribe", "sub"], commandFunction: subscribe },
    { commandStrings: options.unsubscribeWords ?? ["unsubscribe", "unsub"], commandFunction: unsubscribe },
    { commandStrings: options.statusWords ?? ["status"], commandFunction: status },
  ];
}

export type { Subscribers, Subscription, SubscribeOptions, SubscriptionCommandOptions };

export { createSubscribers, subscriptionCommands, DEFAULT_TOPIC, MAX_FILTER_BYTES };
