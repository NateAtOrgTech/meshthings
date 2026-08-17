import { MeshDevice, Protobuf, Types } from "@meshtastic/core";
import { TransportNodeSerial } from "@meshtastic/transport-node-serial";

import { MAX_TEXT_BYTES, paginate, parsePage, truncateBytes } from "./text.js";
import { UsageLog } from "./usage.js";

const HEARTBEAT_INTERVAL_S = 5 * 60 * 1000; // 5 minutes

// Airtime is shared by everyone on the channel. Spacing transmissions keeps a
// fan-out to many subscribers from jamming the mesh at the worst moment.
const MIN_SEND_INTERVAL_MS = 4000;
// If the radio stalls, stop growing the queue rather than the heap
const MAX_QUEUE_LENGTH = 100;
// How long before the same node gets the unknown-command reply again. Two nodes
// running this would otherwise answer each other's help text forever: neither
// recognises the other's reply as a command, so each politely explains itself,
// at one message per pacing interval, permanently.
const UNKNOWN_REPLY_COOLDOWN_MS = 5 * 60 * 1000;
// Bound the memory that cooldown tracking costs on a busy mesh
const MAX_TRACKED_PEERS = 500;

// Context about the message that triggered a command. Handlers need this to
// answer differently per node, per channel, or to ignore a request entirely.
type CommandContext = {
  // The command word as the sender typed it, before case normalization
  command: string;
  // The full message text
  text: string;
  // Node number of the sender
  from: number;
  channel: Types.ChannelNumber;
  packet: Types.PacketMetadata<string>;
};

// Handlers receive the arguments *after* the command word. Returning an empty
// string (or nothing) means "say nothing" -- no packet goes out.
type CommandHandler = (args: string[], context: CommandContext) => string | void | Promise<string | void>;

type Command = {
  commandStrings: string | string[];
  commandFunction: CommandHandler;
};

// What a module is handed when it starts. It gets the outbound API so it can
// push on its own schedule, not only in reply to a command.
type ModuleContext<Config = unknown> = {
  send: (text: string, options?: SendOptions) => boolean;
  sendMany: (text: string, destinations: Types.Destination[], options?: SendOptions) => number;
  config: Config;
  log: (message: string) => void;
};

type MountedModule = {
  commands: Command[];
  // Release sockets, child processes, database handles
  stop?: () => void | Promise<void>;
};

// A deployable meshthing. Several mount onto one device, so a module owns its
// commands but not the reply to an unknown one -- help is aggregated.
type MeshThingModule<Config = any> = {
  name: string;
  // One line, shown in the aggregated help
  description: string;
  create: (context: ModuleContext<Config>) => MountedModule | Promise<MountedModule>;
};

// How a deployment mounts a module: bare, or wrapped with per-deployment config
// and the levers for resolving command collisions.
type ModuleSpec<Config = any> =
  | MeshThingModule<Config>
  | {
      module: MeshThingModule<Config>;
      config?: Config;
      // Prepended to every command word this module claims
      prefix?: string;
      // Individual command words to rewrite, keyed by the module's own word
      rename?: Record<string, string>;
      // Command words to leave unregistered
      disable?: string[];
    };

type SendOptions = {
  // Defaults to broadcast
  to?: Types.Destination;
  channel?: Types.ChannelNumber;
  wantAck?: boolean;
  // "high" jumps the queue -- for alerts, not for chat
  priority?: "high" | "normal";
};

type MeshThingOptions = {
  minSendIntervalMs?: number;
  maxQueueLength?: number;
  maxTextBytes?: number;
  // Reply to a command nobody claims. Defaults to the aggregated help.
  onUnknown?: CommandHandler;
  // How long before the same node gets that reply again. Zero answers every
  // time, which will loop against another node running this.
  unknownReplyCooldownMs?: number;
  // Reported by the `sys` command
  version?: string;
  // Records what the node is used for, if a deployment wants that kept. Absent
  // means nothing is written down.
  usage?: UsageLog;
  // Drives the reported clock -- uptime and the last-seen timestamps -- and
  // nothing else. Transmit pacing deliberately stays on real time: airtime is
  // a physical constraint, and a fake clock cannot make a radio send faster,
  // so letting a test speed it up would only prove something untrue.
  statsClock?: () => number;
};

type Stats = {
  startedAt: number;
  uptimeMs: number;
  // Timestamps rather than content. "Nothing for six hours" is the operational
  // signal; what the message actually said answers no question worth the
  // privacy cost of keeping other people's words in a stats endpoint.
  lastSentAt: number;
  lastCommandAt: number;
  handled: number;
  errors: number;
  queued: number;
  sent: number;
  dropped: number;
  truncated: number;
};

type QueueItem = {
  text: string;
  options: SendOptions;
};

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function formatDuration(milliseconds: number) {
  const seconds = Math.floor(milliseconds / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) {
    return `${days}d ${hours}h`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  return minutes > 0 ? `${minutes}m` : `${seconds}s`;
}

// A meshthing that is only a list of commands -- nothing to configure, nothing
// to open, nothing to clean up. Anything that needs config or a lifecycle wants
// the full module form, because create() is where those belong.
function commandsModule(name: string, description: string, commands: Command[]): MeshThingModule {
  return { name, description, create: () => ({ commands }) };
}

function normalizeSpec<Config>(spec: ModuleSpec<Config>) {
  return "module" in spec ? spec : { module: spec, config: undefined as Config | undefined };
}

function createMeshThing(options: MeshThingOptions = {}) {
  const minSendIntervalMs = options.minSendIntervalMs ?? MIN_SEND_INTERVAL_MS;
  const maxQueueLength = options.maxQueueLength ?? MAX_QUEUE_LENGTH;
  const maxTextBytes = options.maxTextBytes ?? MAX_TEXT_BYTES;
  const unknownReplyCooldownMs = options.unknownReplyCooldownMs ?? UNKNOWN_REPLY_COOLDOWN_MS;

  let meshDevice: MeshDevice | undefined;
  let myNodeInfo: Protobuf.Mesh.MyNodeInfo | undefined;
  const handlers = new Map<string, CommandHandler>();
  const commandOwners = new Map<string, string>();
  const helpSummaries: { name: string; words: string[] }[] = [];
  const mountedModules: { name: string; description: string; mounted: MountedModule }[] = [];
  let defaultHandler: CommandHandler | undefined;
  const lastUnknownReplyAt = new Map<number, number>();
  let queue: QueueItem[] = [];
  let pumping = false;
  let stopped = false;
  let lastSentAt = 0;
  const version = options.version ?? "dev";
  const usage = options.usage;
  const statsNow = options.statsClock ?? (() => Date.now());
  const startedAt = statsNow();
  let stats: Stats = {
    startedAt,
    uptimeMs: 0,
    lastSentAt: 0,
    lastCommandAt: 0,
    handled: 0,
    errors: 0,
    queued: 0,
    sent: 0,
    dropped: 0,
    truncated: 0,
  };

  // Attach to an already-constructed device. Kept separate from the serial
  // helper below so any transport (TCP, BLE, a fake in tests) can be used.
  // Must run before device.configure(), or the node info event is missed.
  async function listen(device: MeshDevice, modules: ModuleSpec[]) {
    device.events.onMyNodeInfo.subscribe((nodeInfo: Protobuf.Mesh.MyNodeInfo) => {
      myNodeInfo = nodeInfo;
    });

    meshDevice = device;

    try {
      await mountModules(modules);
    } catch (error) {
      // A failed mount must not leave half a node running. The caller cannot
      // do this itself -- listen() threw, so it has nothing to stop.
      await stop();

      throw error;
    }

    registerBuiltins();

    device.events.onMessagePacket.subscribe(messageHandler);
    console.log("Event registration complete");

    // Drain anything queued while we were still connecting
    void pump();
  }

  async function mountModules(specs: ModuleSpec[]) {
    for (const raw of specs) {
      const spec = normalizeSpec(raw);
      const name = spec.module.name;

      const mounted = await spec.module.create({
        send,
        sendMany,
        config: spec.config,
        log: (message: string) => console.log(`[${name}] ${message}`),
      });

      // Recorded before its commands are claimed. registerCommands throws on a
      // collision, and by then this module has already opened whatever it
      // opens -- it has to stay reachable by stop() or its socket and its
      // child process are simply abandoned.
      mountedModules.push({ name, description: spec.module.description, mounted });
      registerCommands(name, spec, mounted.commands);
    }
  }

  // Applies a mount's disable/rename/prefix, then claims the resulting words.
  // Collisions throw at startup: it is a deployment mistake, and failing here
  // beats discovering it when someone sends the command at 3am.
  function registerCommands(name: string, spec: { prefix?: string; rename?: Record<string, string>; disable?: string[] }, commands: Command[]) {
    const primaries: string[] = [];
    // Keyed case-insensitively, like disable and collision detection. Keyed by
    // the declared spelling, a rename written in the wrong case did nothing at
    // all -- and said nothing about it.
    const renames = new Map(
      Object.entries(spec.rename ?? {}).map(([from, to]) => [from.toLocaleLowerCase(), to] as const),
    );

    commands.forEach((command) => {
      const declared = typeof command.commandStrings === "string" ? [command.commandStrings] : command.commandStrings;

      const resolved = declared
        .filter((word) => !(spec.disable ?? []).some((entry) => entry.toLocaleLowerCase() === word.toLocaleLowerCase()))
        .map((word) => `${spec.prefix ?? ""}${renames.get(word.toLocaleLowerCase()) ?? word}`);

      resolved.forEach((word) => {
        const key = word.toLocaleLowerCase();
        const owner = commandOwners.get(key);

        if (owner) {
          throw new Error(
            owner === name
              ? `Duplicate command registration for "${word}"`
              : `Command "${word}" is claimed by both "${owner}" and "${name}" -- rename, prefix, or disable one of them`,
          );
        }

        commandOwners.set(key, name);
        handlers.set(key, command.commandFunction);
      });

      if (resolved.length > 0) {
        primaries.push(resolved[0]);
      }
    });

    if (primaries.length > 0) {
      helpSummaries.push({ name, words: primaries });
    }
  }

  // One module cannot own the reply to an unknown command once several are
  // mounted, so the core answers with what is actually available.
  function helpHandler(args: string[]) {
    if (helpSummaries.length === 0) {
      return "No commands available";
    }

    const lines = helpSummaries.map((summary) => `${summary.name}: ${summary.words.join(", ")}`);

    return paginate(lines, parsePage(args), "help", maxTextBytes);
  }

  // Is the node up, and is it healthy? One reserved word with subcommands
  // rather than several, to keep the collision surface as small as possible.
  function systemHandler(args: string[]) {
    const subcommand = (args[0] ?? "").toLocaleLowerCase();
    const current = getStats();

    if (subcommand === "modules") {
      if (mountedModules.length === 0) {
        return "No modules mounted";
      }

      const lines = mountedModules.map(({ name, description }) => truncateBytes(`${name}: ${description}`, 56));

      return paginate(lines, parsePage(args.slice(1)), "sys modules", maxTextBytes);
    }

    if (subcommand === "stats") {
      return (
        `cmds ${current.handled}, err ${current.errors} | ` +
        `sent ${current.sent}, drop ${current.dropped}, cut ${current.truncated} | ` +
        `queue ${current.queued}`
      );
    }

    return (
      `meshthings ${version} | up ${formatDuration(current.uptimeMs)} | ` +
      `${mountedModules.length} modules | ${current.handled} cmds | ${current.sent} sent`
    );
  }

  // Registered only if no module claimed the word. A built-in is a convenience;
  // it must never stop a deployment from starting.
  function claimIfFree(words: string[], handler: CommandHandler) {
    const claimed: string[] = [];

    words.forEach((word) => {
      const key = word.toLocaleLowerCase();
      const owner = commandOwners.get(key);

      if (owner) {
        console.warn(`Built-in "${word}" not registered: already claimed by "${owner}"`);

        return;
      }

      commandOwners.set(key, "core");
      handlers.set(key, handler);
      claimed.push(word);
    });

    return claimed;
  }

  function registerBuiltins() {
    if (!defaultHandler) {
      defaultHandler = options.onUnknown ?? helpHandler;
    }

    const claimed = [
      ...claimIfFree(["help", "?"], helpHandler),
      ...claimIfFree(["ping"], () => "pong"),
      ...claimIfFree(["sys"], systemHandler),
    ];

    if (claimed.length > 0) {
      // First, not last: with several things mounted the help paginates, and
      // the built-ins are what you need when something is wrong. They should
      // not be on page two.
      helpSummaries.unshift({ name: "core", words: claimed });
    }
  }

  // Every outbound packet -- replies included -- goes through here, so nothing
  // can bypass the pacing and step on a fan-out already in flight.
  function send(text: string, sendOptions: SendOptions = {}) {
    if (stopped || !text) {
      return false;
    }

    const clamped = truncateBytes(text, maxTextBytes);

    if (clamped !== text) {
      stats.truncated++;
      console.warn(`Message truncated to ${maxTextBytes} bytes: ${text.slice(0, 40)}...`);
    }

    if (queue.length >= maxQueueLength) {
      // Drop the oldest normal-priority message rather than the newest, since
      // stale traffic is worth less than what just happened
      const stale = queue.findIndex((item) => item.options.priority !== "high");

      if (stale === -1) {
        stats.dropped++;
        return false;
      }

      queue.splice(stale, 1);
      stats.dropped++;
    }

    const item: QueueItem = { text: clamped, options: sendOptions };

    if (sendOptions.priority === "high") {
      // Behind other high-priority items, ahead of everything else
      const insertAt = queue.findIndex((queued) => queued.options.priority !== "high");
      queue.splice(insertAt === -1 ? queue.length : insertAt, 0, item);
    } else {
      queue.push(item);
    }

    void pump();

    return true;
  }

  // Same message to many nodes, paced by the queue
  function sendMany(text: string, destinations: Types.Destination[], sendOptions: SendOptions = {}) {
    return destinations.filter((to) => send(text, { ...sendOptions, to })).length;
  }

  async function pump() {
    // Messages queued before the radio is up simply wait for it
    if (pumping || !meshDevice) {
      return;
    }

    pumping = true;

    while (queue.length > 0 && !stopped) {
      const wait = lastSentAt + minSendIntervalMs - Date.now();

      if (wait > 0) {
        await delay(wait);
        continue; // re-check: a high-priority item may have arrived while waiting
      }

      const item = queue.shift()!;

      try {
        await meshDevice!.sendText(item.text, item.options.to ?? "broadcast", item.options.wantAck ?? true, item.options.channel);
        stats.sent++;
        stats.lastSentAt = statsNow();
      } catch (error) {
        stats.errors++;
        console.error(error);
      }

      lastSentAt = Date.now();
    }

    pumping = false;
  }

  async function messageHandler(messagePacket: Types.PacketMetadata<string>) {
    // Modules have released their sockets, processes and database handles by
    // now, so dispatching into them means running handlers against closed
    // resources -- and the reply would be swallowed anyway
    if (stopped) {
      return;
    }

    // Filter messages we don't respond to. Until we know our own node number we
    // can't tell those apart, so stay quiet.
    if (!myNodeInfo || myNodeInfo.myNodeNum === messagePacket.from || myNodeInfo.myNodeNum !== messagePacket.to) {
      return;
    }

    const tokens: string[] = messagePacket.data.split(" ").filter((token: string) => token.length > 0);
    const command = tokens[0] ?? "";
    const claimed = handlers.get(command.toLocaleLowerCase());
    const handler = claimed ?? defaultHandler;

    if (!handler) {
      return;
    }

    // Recorded before the cooldown check: someone asking is usage whether or
    // not we answer them this time
    if (usage) {
      const owner = commandOwners.get(command.toLocaleLowerCase());

      if (claimed && owner) {
        usage.recordCommand(messagePacket.from, owner, command.toLocaleLowerCase());
      } else {
        usage.recordUnknown(messagePacket.from);
      }
    }

    // Only the unknown-command reply is rate limited, and only per node. It is
    // the one handler that answers anything, which is what makes it loop; real
    // commands stay as responsive as they were.
    if (!claimed && !mayAnswerUnknown(messagePacket.from)) {
      return;
    }

    const context: CommandContext = {
      command,
      text: messagePacket.data,
      from: messagePacket.from,
      channel: messagePacket.channel,
      packet: messagePacket,
    };

    let result: string | void;

    // Counted on dispatch rather than on success, so `sys` includes the
    // command asking the question and a failure still shows as traffic
    stats.handled++;
    stats.lastCommandAt = statsNow();

    try {
      result = await handler(tokens.slice(1), context);
    } catch (error) {
      stats.errors++;
      console.error(`Command "${command}" failed:`, error);
      return;
    }

    // A handler that returns nothing has chosen not to reply
    if (!result) {
      return;
    }

    send(result, { to: messagePacket.from, channel: messagePacket.channel });
  }

  // True at most once per cooldown per node, and records the answer as it goes
  function mayAnswerUnknown(nodeNum: number) {
    const at = Date.now();

    if (unknownReplyCooldownMs > 0) {
      const last = lastUnknownReplyAt.get(nodeNum);

      if (last !== undefined && at - last < unknownReplyCooldownMs) {
        return false;
      }
    }

    // Re-inserted rather than updated so the map stays in least-recent order
    lastUnknownReplyAt.delete(nodeNum);
    lastUnknownReplyAt.set(nodeNum, at);

    while (lastUnknownReplyAt.size > MAX_TRACKED_PEERS) {
      const oldest = lastUnknownReplyAt.keys().next().value;

      if (oldest === undefined) {
        break;
      }

      lastUnknownReplyAt.delete(oldest);
    }

    return true;
  }

  async function configureAndListen(deviceString: string, modules: ModuleSpec[]) {
    const transport = await TransportNodeSerial.create(deviceString);
    const device = new MeshDevice(transport);

    await listen(device, modules);

    await device.configure();

    // If we don't set a heartbeat, serial times out after 15 minutes
    device.setHeartbeatInterval(HEARTBEAT_INTERVAL_S);

    console.log("Config complete");
  }

  function getStats(): Stats {
    return { ...stats, queued: queue.length, uptimeMs: statsNow() - startedAt };
  }

  // Stop accepting and draining outbound traffic, and let modules release
  // whatever they are holding -- sockets, child processes, database handles
  async function stop() {
    if (stopped) {
      return;
    }

    stopped = true;
    queue = [];

    for (const { name, mounted } of mountedModules) {
      try {
        await mounted.stop?.();
      } catch (error) {
        stats.errors++;
        console.error(`Module "${name}" failed to stop:`, error);
      }
    }
  }

  function getModules() {
    return mountedModules.map(({ name }) => name);
  }

  return { configureAndListen, listen, send, sendMany, getStats, getModules, stop };
}

type MeshThing = ReturnType<typeof createMeshThing>;

export type {
  Command,
  CommandContext,
  CommandHandler,
  MeshThing,
  MeshThingModule,
  MeshThingOptions,
  ModuleContext,
  ModuleSpec,
  MountedModule,
  SendOptions,
  Stats,
};

export { createMeshThing, commandsModule };
