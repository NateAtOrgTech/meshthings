import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { createMeshThing, MAX_TEXT_BYTES } from "../meshthing.js";
import { createSubscribers, subscriptionCommands, SubscriptionCommandOptions } from "../subscribers.js";
import { createMockDevice } from "../mockMeshtasticDevice.js";

function store() {
  return createSubscribers(":memory:");
}

describe("subscription store", () => {
  test("records a subscription", () => {
    const subscribers = store();

    const subscription = subscribers.subscribe(111);

    assert.equal(subscription.nodeNum, 111);
    assert.equal(subscription.topic, "default");
    assert.equal(subscription.filter, null);
    assert.ok(subscribers.isSubscribed(111));
  });

  test("reports an unsubscribed node", () => {
    const subscribers = store();

    assert.equal(subscribers.isSubscribed(111), false);
    assert.equal(subscribers.get(111), undefined);
  });

  test("is idempotent for the same node and topic", () => {
    const subscribers = store();

    subscribers.subscribe(111);
    subscribers.subscribe(111);

    assert.equal(subscribers.count(), 1);
  });

  test("updates the filter when a node resubscribes", () => {
    const subscribers = store();

    subscribers.subscribe(111, { filter: "023005" });
    subscribers.subscribe(111, { filter: "023031" });

    assert.equal(subscribers.count(), 1);
    assert.equal(subscribers.get(111)?.filter, "023031");
  });

  test("keeps the original timestamp across a resubscribe", async () => {
    const subscribers = store();

    const first = subscribers.subscribe(111, { filter: "a" });

    // Without the wait both calls land in the same millisecond and this passes
    // whether or not created_at is preserved
    await new Promise((resolve) => setTimeout(resolve, 10));

    const second = subscribers.subscribe(111, { filter: "b" });
    // A node subscribing fresh after the wait proves the clock moved, without
    // asserting on timer precision
    const other = subscribers.subscribe(222);

    assert.equal(second.createdAt, first.createdAt);
    assert.ok(other.createdAt > first.createdAt);
  });

  test("treats an empty or whitespace filter as none", () => {
    const subscribers = store();

    subscribers.subscribe(111, { filter: "   " });

    assert.equal(subscribers.get(111)?.filter, null);
  });

  test("truncates an overlong filter", () => {
    const subscribers = store();

    subscribers.subscribe(111, { filter: "0".repeat(200) });

    assert.ok(Buffer.byteLength(subscribers.get(111)!.filter!, "utf8") <= 96);
  });

  test("removes a subscription", () => {
    const subscribers = store();

    subscribers.subscribe(111);

    assert.equal(subscribers.unsubscribe(111), true);
    assert.equal(subscribers.isSubscribed(111), false);
  });

  test("reports removing a subscription that was not there", () => {
    const subscribers = store();

    assert.equal(subscribers.unsubscribe(111), false);
  });

  test("only removes the node asked for", () => {
    const subscribers = store();

    subscribers.subscribe(111);
    subscribers.subscribe(222);
    subscribers.unsubscribe(111);

    assert.deepEqual(subscribers.nodes(), [222]);
  });
});

describe("topics", () => {
  test("keeps subscriptions on separate topics apart", () => {
    const subscribers = store();

    subscribers.subscribe(111, { topic: "alerts" });
    subscribers.subscribe(111, { topic: "tides" });

    assert.equal(subscribers.count("alerts"), 1);
    assert.equal(subscribers.count("tides"), 1);
    assert.deepEqual(subscribers.topics(), ["alerts", "tides"]);
  });

  test("unsubscribes from one topic without touching the other", () => {
    const subscribers = store();

    subscribers.subscribe(111, { topic: "alerts" });
    subscribers.subscribe(111, { topic: "tides" });
    subscribers.unsubscribe(111, "alerts");

    assert.equal(subscribers.isSubscribed(111, "alerts"), false);
    assert.equal(subscribers.isSubscribed(111, "tides"), true);
  });

  test("drops a node from every topic at once", () => {
    const subscribers = store();

    subscribers.subscribe(111, { topic: "alerts" });
    subscribers.subscribe(111, { topic: "tides" });

    assert.equal(subscribers.unsubscribeAll(111), 2);
    assert.equal(subscribers.list().length, 0);
  });

  test("matches topic names case-insensitively", () => {
    const subscribers = store();

    subscribers.subscribe(111, { topic: "Alerts" });

    assert.ok(subscribers.isSubscribed(111, "alerts"));
  });

  test("lists every subscription when no topic is given", () => {
    const subscribers = store();

    subscribers.subscribe(111, { topic: "alerts" });
    subscribers.subscribe(222, { topic: "tides" });

    assert.equal(subscribers.list().length, 2);
  });

  test("clears one topic or all of them", () => {
    const subscribers = store();

    subscribers.subscribe(111, { topic: "alerts" });
    subscribers.subscribe(222, { topic: "tides" });

    assert.equal(subscribers.clear("alerts"), 1);
    assert.equal(subscribers.list().length, 1);
    assert.equal(subscribers.clear(), 1);
    assert.equal(subscribers.list().length, 0);
  });
});

describe("recipient selection", () => {
  test("returns nodes in subscription order, ready for sendMany", () => {
    const subscribers = store();

    subscribers.subscribe(333);
    subscribers.subscribe(111);
    subscribers.subscribe(222);

    assert.deepEqual(subscribers.nodes(), [333, 111, 222]);
  });

  test("selects only nodes whose filter matches", () => {
    const subscribers = store();

    subscribers.subscribe(111, { topic: "alerts", filter: "023005" });
    subscribers.subscribe(222, { topic: "alerts", filter: "023031" });
    subscribers.subscribe(333, { topic: "alerts" });

    // An unset filter means "send me everything"
    const recipients = subscribers.matching("alerts", (filter) => filter === null || filter.includes("023005"));

    assert.deepEqual(recipients, [111, 333]);
  });

  test("fans out a real alert to matching subscribers only", async () => {
    const fake = createMockDevice();
    const thing = createMeshThing({ minSendIntervalMs: 0 });
    const subscribers = store();

    await thing.listen(fake.device, { commands: [] });

    subscribers.subscribe(111, { topic: "alerts", filter: "023005" });
    subscribers.subscribe(222, { topic: "alerts", filter: "023031" });

    const recipients = subscribers.matching("alerts", (filter) => filter!.includes("023005"));

    thing.sendMany("TOR Cumberland until 21:45", recipients, { priority: "high" });

    const sent = await fake.waitForSends(1);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 111);
  });
});

describe("shared database", () => {
  test("lives alongside another module's tables in one file", () => {
    const first = createSubscribers(":memory:");
    // Reuse the same handle rather than opening a second database
    const second = createSubscribers(first.db, "tides");

    first.subscribe(111);
    second.subscribe(222);

    assert.equal(first.count(), 1);
    assert.equal(second.count(), 1);
    assert.equal(first.list().length, 2);
  });

  test("applies its own default topic", () => {
    const subscribers = createSubscribers(":memory:", "alerts");

    subscribers.subscribe(111);

    assert.equal(subscribers.get(111)?.topic, "alerts");
    assert.ok(subscribers.isSubscribed(111, "alerts"));
  });
});

describe("on-mesh commands", () => {
  async function setup(options: SubscriptionCommandOptions = {}) {
    const fake = createMockDevice();
    const thing = createMeshThing({ minSendIntervalMs: 0 });
    const subscribers = createSubscribers(":memory:", options.topic ?? "default");

    await thing.listen(fake.device, { commands: subscriptionCommands(subscribers, options) });

    async function ask(text: string, from = 0x1000) {
      const before = fake.sent.length;

      fake.receive(text, { from });

      const reply = (await fake.waitForSends(before + 1))[before].text;

      assert.ok(Buffer.byteLength(reply, "utf8") <= MAX_TEXT_BYTES, `reply too long: ${reply}`);

      return reply;
    }

    return { subscribers, ask };
  }

  test("subscribes the calling node", async () => {
    const { subscribers, ask } = await setup();

    assert.match(await ask("subscribe", 4242), /Subscribed to alerts/);
    assert.ok(subscribers.isSubscribed(4242));
  });

  test("records a filter supplied with the command", async () => {
    const { subscribers, ask } = await setup();

    const reply = await ask("subscribe 023005 023031", 4242);

    assert.match(reply, /023005 023031/);
    assert.equal(subscribers.get(4242)?.filter, "023005 023031");
  });

  test("unsubscribes the calling node", async () => {
    const { subscribers, ask } = await setup();

    await ask("subscribe", 4242);

    assert.match(await ask("unsubscribe", 4242), /Unsubscribed/);
    assert.equal(subscribers.isSubscribed(4242), false);
  });

  test("says so when unsubscribing without a subscription", async () => {
    const { ask } = await setup();

    assert.match(await ask("unsubscribe", 4242), /not subscribed/);
  });

  test("reports status both ways", async () => {
    const { ask } = await setup();

    assert.match(await ask("status", 4242), /Not subscribed/);

    await ask("subscribe 023005", 4242);

    const reply = await ask("status", 4242);

    assert.match(reply, /Subscribed to alerts \(023005\)/);
    assert.match(reply, /1 nodes total/);
  });

  test("answers to its aliases", async () => {
    const { subscribers, ask } = await setup();

    await ask("sub", 4242);

    assert.ok(subscribers.isSubscribed(4242));

    await ask("unsub", 4242);

    assert.equal(subscribers.isSubscribed(4242), false);
  });

  test("keeps each node's subscription separate", async () => {
    const { subscribers, ask } = await setup();

    await ask("subscribe", 111);
    await ask("subscribe", 222);
    await ask("unsubscribe", 111);

    assert.deepEqual(subscribers.nodes(), [222]);
  });

  test("rejects a filter the app considers invalid", async () => {
    const { subscribers, ask } = await setup({
      validateFilter: (filter) => (/^\d{6}( \d{6})*$/.test(filter) ? undefined : "Filter must be 6-digit FIPS codes"),
    });

    assert.match(await ask("subscribe maine", 4242), /must be 6-digit FIPS/);
    assert.equal(subscribers.isSubscribed(4242), false);

    assert.match(await ask("subscribe 023005", 4242), /Subscribed/);
  });

  test("uses the label and words the app supplies", async () => {
    const { subscribers, ask } = await setup({
      topic: "wx",
      label: "weather alerts",
      subscribeWords: ["alertme"],
      unsubscribeWords: ["stop"],
    });

    assert.match(await ask("alertme", 4242), /Subscribed to weather alerts/);
    assert.ok(subscribers.isSubscribed(4242, "wx"));
    assert.match(await ask("stop", 4242), /Unsubscribed from weather alerts/);
  });
});
