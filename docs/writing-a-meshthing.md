# Writing a meshthing

A meshthing is a service that runs on a mesh node: it registers some commands, optionally pushes messages of its own, and cleans up after itself. This is the contract and the constraints that come with talking over a LoRa radio.

## Two shapes

If your thing is **only a list of commands** — nothing to configure, nothing to open, nothing to clean up — `commandsModule` is the whole of it:

```ts
import { commandsModule } from "../../core/index.js";

commandsModule("local", "About this node", [
  { commandStrings: ["owner", "who"], commandFunction: () => "Nate, Freeport ME" },
]);
```

That is genuinely rare for something worth packaging, and common for commands a single deployment wants on its own node. If your thing takes config, opens a socket or a database, pushes messages of its own, or needs tearing down, use the full form below — `create()` is where all of those belong, and reaching for `commandsModule` would push that work to import time.

## The shape

```ts
import { MeshThingModule } from "../../core/index.js";

type TidesConfig = {
  station?: string;
};

const tidesModule: MeshThingModule<TidesConfig> = {
  name: "tides",
  description: "Tide times for Casco Bay",

  create({ config, send, sendMany, log }) {
    const station = config?.station ?? "8418150";

    return {
      commands: [
        // Not "t" -- the weather thing has that, and both may be mounted
        { commandStrings: ["tides", "tide"], commandFunction: next },
      ],
      stop: () => {},
    };
  },
};

export { tidesModule };
```

`name` and `description` appear in `help` and `sys modules`. Keep the description under about fifty characters — it shares a packet.

### create()

Called once at startup, before the radio is configured. It may be async. Everything the thing owns — sockets, database handles, child processes, timers — should be created here rather than at import time. A module that opens a socket when it is imported forces every entry point to import it lazily, and makes it impossible to run one thing without starting another's side effects.

It receives:

| | |
| --- | --- |
| `config` | Whatever the deployment passed for this module |
| `send(text, options?)` | Queue one message. `{ to, channel, priority, wantAck }` |
| `sendMany(text, destinations, options?)` | Same message to many nodes, paced |
| `log(message)` | Prefixed with the module name |

### Commands

```ts
{ commandStrings: ["tides", "tide"], commandFunction: (args, context) => "High 14:05" }
```

`commandStrings` may be a single string or a list of aliases; matching is case-insensitive. Give short aliases — people type these on a phone keypad, sometimes in the dark.

Handlers get the arguments **after** the command word, so `tides tomorrow` yields `["tomorrow"]`. The command word itself is in `context`.

```ts
type CommandContext = {
  command: string;   // as typed, before case normalisation
  text: string;      // the whole message
  from: number;      // sender's node number
  channel: Types.ChannelNumber;
  packet: Types.PacketMetadata<string>;
};
```

`context.from` is what makes per-node behaviour possible — it is how `register` knows whose listing it is and how `subscribe` knows who to send alerts to.

Handlers may be async. **Returning nothing means say nothing** — no packet goes out. Use that for commands that should stay silent, and for rate limiting.

A handler that throws is caught, logged, and counted; it does not take the process down and it sends no reply.

### stop()

Release anything `create()` acquired. It may be async, and **it must be safe to call twice** — a supervisor may stop twice, and an error handler may already have closed the thing.

```ts
stop: () => {
  if (!closed) {
    closed = true;
    server.close();
  }
},
```

## Constraints that bite

### The byte budget

A Meshtastic text payload is around 200 bytes; the core truncates at 180 and logs a warning. That is a backstop, not a plan — a truncated reply is a bad reply.

For anything list-shaped, paginate:

```ts
import { paginate, parsePage, truncateBytes } from "../../core/index.js";

function services(args: string[]) {
  const lines = rows.map((row) => truncateBytes(`${row.name} - ${row.description}`, 56));

  return paginate(lines, parsePage(args), "services");
}
```

That yields `(1/3) services 2` at the end of each page. Use `truncateBytes` rather than `String.slice` — it clamps on a character boundary and accounts for multi-byte characters, including the ellipsis it appends.

### Airtime

Every transmission is queued and spaced, including replies. You do not need to rate limit your own sends for the mesh's sake — but you should still think about volume, because a thing that queues fifty messages delays everything behind it.

`priority: "high"` jumps ahead of queued traffic. It is for life-safety information, not for making your thing feel responsive.

```ts
sendMany(warningText, recipients, { priority: "high" });
```

### Command collisions

Two things cannot claim the same word. If they do, startup throws and names both. That is deliberate: it is a deployment mistake, and discovering it when somebody sends the command is worse.

Pick specific words. `status`, `info`, `list`, and `test` are the ones everyone reaches for and will collide. A deployment can resolve conflicts with `prefix`, `rename`, or `disable`, but it is better not to make them.

`help`, `?`, `ping`, and `sys` are registered by the core only if nothing else claimed them. You *can* take those words, and the core will step aside — think hard before you do.

## Storing things

Use `openDatabase`, which accepts a path or an existing handle, so several things can share one file:

```ts
import { openDatabase } from "../../core/index.js";

const db = openDatabase(config?.database ?? "mesh.db");

db.exec(`CREATE TABLE IF NOT EXISTS tides (station TEXT PRIMARY KEY, fetched_at INTEGER)`);
```

Do not construct `DatabaseSync` yourself. `node:sqlite` finalizes a database's prepared statements when the *handle* is garbage collected, and a statement holds no reference back to keep its database alive — so a thing that prepares statements at startup and then refers only to those statements will start throwing `statement has been finalized` at an unpredictable later moment. `openDatabase` retains handles so this cannot happen.

## Sending to subscribers

If your thing pushes to people who asked for it, use the shared registry rather than building your own:

```ts
import { createSubscribers, subscriptionCommands } from "../../core/index.js";

const subscribers = createSubscribers(db, "tides");

const commands = [
  ...subscriptionCommands(subscribers, { label: "tide times" }),
];

// later
sendMany("High 14:05", subscribers.nodes());
```

A store is scoped to the topic you create it with, and nothing takes a topic after that — not the commands, not `nodes()`, not `count()`. That is deliberate: when both the store and its commands defaulted their own topic, the two could disagree, and subscriptions went somewhere nothing read. Users got a cheerful confirmation and were never sent anything. Serving two topics means two stores over the same database handle.

`subscriptionCommands` gives you `subscribe`, `unsubscribe`, and `status` for free, with configurable words and a `validateFilter` hook. `matching()` selects only subscribers whose stored filter accepts an event.

## Running it on your node

Add it to `src/meshthings.config.ts`, which is your file — upstream never edits it, so this survives every upstream merge:

```ts
import { tidesModule } from "./things/tides/index.js";

modules: [
  { module: weatherModule, config: { port: 41234 } },
  { module: tidesModule, config: { station: "8418150" } },
],
```

## Testing without a radio

Tests go in your thing's own `tst/` folder — `src/things/tides/tst/tides.test.ts`. `createMockDevice()` stands in for hardware. It records what was transmitted, injects inbound messages, and lets you assert on ordering and timing.

```ts
import { createMeshThing } from "../../../core/index.js";
import { createMockDevice } from "../../../testing/index.js";
import { tidesModule } from "../index.js";

const mock = createMockDevice();
const thing = createMeshThing({ minSendIntervalMs: 0 });

await thing.listen(mock.device, [{ module: tidesModule, config: {} }]);

mock.receive("tides", { from: 4242 });

const [message] = await mock.waitForSends(1);

assert.match(message.text, /High/);
assert.equal(message.to, 4242);
```

Useful pieces:

| | |
| --- | --- |
| `receive(text, { from, to, channel })` | Inject an inbound message |
| `waitForSends(n)` | Resolve once `n` messages have gone out |
| `settle()` | Wait a moment to assert something *didn't* send |
| `texts()` / `sent` | What went out, with timestamps for pacing assertions |
| `failNextSend()` | Make the next transmission throw |
| `identify()` / `deferIdentify` | Control when the node learns its own number |

Set `minSendIntervalMs: 0` for routing tests so pacing does not slow them down, and a small non-zero value when you are testing ordering or priority.

**Assert that every reply fits a packet.** It is one line in a test helper and it catches the failure that only shows up once real data accumulates:

```ts
assert.ok(Buffer.byteLength(reply, "utf8") <= MAX_TEXT_BYTES, `too long: ${reply}`);
```

If your thing has a parser or a formatter, test it directly as a pure function — that is where the edge cases are, and it needs neither a radio nor a database. `src/things/alerts/same.ts` is written that way for exactly this reason.

## Checklist

- [ ] `commandsModule` if it is only commands; the full form if it has config or a lifecycle
- [ ] Everything acquired in `create()`, nothing at import time
- [ ] `stop()` releases it, and is safe to call twice
- [ ] Replies fit 180 bytes; lists paginate
- [ ] Command words are specific enough not to collide
- [ ] Tests live in the thing's `tst/` folder and cover it against the mock device, including the byte limit
- [ ] Anything that can be a pure function is one, and is tested as one
