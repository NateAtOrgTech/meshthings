import { MeshDevice, Protobuf, Types } from "@meshtastic/core";
import { TransportNodeSerial } from "@meshtastic/transport-node-serial";

const HEARTBEAT_INTERVAL_S = 5 * 60 * 1000; // 5 minutes

// A meshtastic text payload tops out around 200 bytes. Stay under it with room
// for the radio's own overhead.
const MAX_TEXT_BYTES = 180;
// Airtime is shared by everyone on the channel. Spacing transmissions keeps a
// fan-out to many subscribers from jamming the mesh at the worst moment.
const MIN_SEND_INTERVAL_MS = 4000;
// If the radio stalls, stop growing the queue rather than the heap
const MAX_QUEUE_LENGTH = 100;

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

type CommandMap = {
  commands: Command[];
  default?: CommandHandler;
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
  // Reported by the `sys` command
  version?: string;
  now?: () => number;
};

type Stats = {
  startedAt: number;
  uptimeMs: number;
  lastSent: string;
  lastCommand: string;
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

function byteLength(text: string) {
  return Buffer.byteLength(text, "utf8");
}

const ELLIPSIS = "…";

// Clamp on a character boundary so we never emit a split codepoint. The budget
// covers the ellipsis too -- it is three bytes in UTF-8, not one.
function truncateBytes(text: string, budget: number) {
  if (byteLength(text) <= budget) {
    return text;
  }

  const allowance = budget - byteLength(ELLIPSIS);
  let result = "";

  for (const character of text) {
    if (byteLength(result + character) > allowance) {
      break;
    }
    result += character;
  }

  return result + ELLIPSIS;
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// Pack lines into whichever page was asked for. Any listing longer than a
// couple of entries outgrows a single packet, so this is shared rather than
// reimplemented per module.
function paginate(lines: string[], page: number, moreCommand: string, budget = MAX_TEXT_BYTES) {
  if (lines.length === 0) {
    return "";
  }

  const perPage = budget - 28; // reserve room for the "(1/3) more" footer
  const pages: string[][] = [];
  let current: string[] = [];
  let size = 0;

  lines.forEach((line) => {
    const cost = byteLength(line) + 1; // newline

    if (current.length > 0 && size + cost > perPage) {
      pages.push(current);
      current = [];
      size = 0;
    }

    current.push(line);
    size += cost;
  });

  if (current.length > 0) {
    pages.push(current);
  }

  const index = Math.min(Math.max(page, 1), pages.length) - 1;
  const body = pages[index].join("\n");

  if (pages.length === 1) {
    return body;
  }

  const next = index + 2 <= pages.length ? ` ${moreCommand} ${index + 2}` : "";

  return `${body}\n(${index + 1}/${pages.length})${next}`;
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

function parsePage(args: string[]) {
  const page = Number.parseInt(args[0] ?? "1", 10);

  return Number.isFinite(page) ? page : 1;
}

function normalizeSpec<Config>(spec: ModuleSpec<Config>) {
  return "module" in spec ? spec : { module: spec, config: undefined as Config | undefined };
}

function createMeshThing(options: MeshThingOptions = {}) {
  const minSendIntervalMs = options.minSendIntervalMs ?? MIN_SEND_INTERVAL_MS;
  const maxQueueLength = options.maxQueueLength ?? MAX_QUEUE_LENGTH;
  const maxTextBytes = options.maxTextBytes ?? MAX_TEXT_BYTES;

  let meshDevice: MeshDevice | undefined;
  let myNodeInfo: Protobuf.Mesh.MyNodeInfo | undefined;
  const handlers = new Map<string, CommandHandler>();
  const commandOwners = new Map<string, string>();
  const helpSummaries: { name: string; words: string[] }[] = [];
  const mountedModules: { name: string; description: string; mounted: MountedModule }[] = [];
  let defaultHandler: CommandHandler | undefined;
  let queue: QueueItem[] = [];
  let pumping = false;
  let stopped = false;
  let lastSentAt = 0;
  const version = options.version ?? "dev";
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  let stats: Stats = {
    startedAt,
    uptimeMs: 0,
    lastSent: "",
    lastCommand: "",
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
  async function listen(device: MeshDevice, source: CommandMap | ModuleSpec[]) {
    device.events.onMyNodeInfo.subscribe((nodeInfo: Protobuf.Mesh.MyNodeInfo) => {
      myNodeInfo = nodeInfo;
    });

    meshDevice = device;

    if (Array.isArray(source)) {
      await mountModules(source);
    } else {
      mountCommandMap(source);
    }

    registerBuiltins();

    device.events.onMessagePacket.subscribe(messageHandler);
    console.log("Event registration complete");

    // Drain anything queued while we were still connecting
    void pump();
  }

  // A bare CommandMap is a single anonymous module -- the simple case stays simple
  function mountCommandMap(commandMap: CommandMap) {
    registerCommands("app", {}, commandMap.commands);

    if (commandMap.default) {
      defaultHandler = commandMap.default;
    }
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

      registerCommands(name, spec, mounted.commands);
      mountedModules.push({ name, description: spec.module.description, mounted });
    }
  }

  // Applies a mount's disable/rename/prefix, then claims the resulting words.
  // Collisions throw at startup: it is a deployment mistake, and failing here
  // beats discovering it when someone sends the command at 3am.
  function registerCommands(name: string, spec: { prefix?: string; rename?: Record<string, string>; disable?: string[] }, commands: Command[]) {
    const primaries: string[] = [];

    commands.forEach((command) => {
      const declared = typeof command.commandStrings === "string" ? [command.commandStrings] : command.commandStrings;

      const resolved = declared
        .filter((word) => !(spec.disable ?? []).some((entry) => entry.toLocaleLowerCase() === word.toLocaleLowerCase()))
        .map((word) => `${spec.prefix ?? ""}${spec.rename?.[word] ?? word}`);

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

    const lines = helpSummaries.map((summary) =>
      summary.name === "app" ? summary.words.join(", ") : `${summary.name}: ${summary.words.join(", ")}`,
    );

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
        stats.lastSent = item.text;
      } catch (error) {
        stats.errors++;
        console.error(error);
      }

      lastSentAt = Date.now();
    }

    pumping = false;
  }

  async function messageHandler(messagePacket: Types.PacketMetadata<string>) {
    // Filter messages we don't respond to. Until we know our own node number we
    // can't tell those apart, so stay quiet.
    if (!myNodeInfo || myNodeInfo.myNodeNum === messagePacket.from || myNodeInfo.myNodeNum !== messagePacket.to) {
      return;
    }

    const tokens: string[] = messagePacket.data.split(" ").filter((token: string) => token.length > 0);
    const command = tokens[0] ?? "";
    const handler = handlers.get(command.toLocaleLowerCase()) ?? defaultHandler;

    if (!handler) {
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
    stats.lastCommand = command;

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

  async function configureAndListen(deviceString: string, source: CommandMap | ModuleSpec[]) {
    const transport = await TransportNodeSerial.create(deviceString);
    const device = new MeshDevice(transport);

    await listen(device, source);

    await device.configure();

    // If we don't set a heartbeat, serial times out after 15 minutes
    device.setHeartbeatInterval(HEARTBEAT_INTERVAL_S);

    console.log("Config complete");
  }

  function getStats(): Stats {
    return { ...stats, queued: queue.length, uptimeMs: now() - startedAt };
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
  CommandMap,
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

export { createMeshThing, byteLength, truncateBytes, paginate, parsePage, MAX_TEXT_BYTES };
