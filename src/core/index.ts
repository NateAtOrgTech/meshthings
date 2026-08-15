// The public surface of the core. Everything a meshthing is meant to use is
// re-exported here, and nothing else is: a thing importing a deep path is
// reaching for something that was not offered, and adding to this file is the
// deliberate act of widening the API.
//
// Files inside core/ import each other directly rather than through here, to
// keep the module graph acyclic.

export type {
  Command,
  CommandContext,
  CommandHandler,
  CommandMap,
  MeshThing,
  MeshThingModule,
  MeshThingOptions,
  ModuleContext,
  ModuleSpec,
  MountedModule,
  SendOptions,
  Stats,
} from "./meshthing.js";

export { createMeshThing } from "./meshthing.js";

export { byteLength, paginate, parsePage, truncateBytes, MAX_TEXT_BYTES } from "./text.js";

export type { DatabaseHandle } from "./db.js";

export { closeDatabase, openDatabase } from "./db.js";

export type { SubscribeOptions, Subscribers, Subscription, SubscriptionCommandOptions } from "./subscribers.js";

export { createSubscribers, subscriptionCommands, DEFAULT_TOPIC, MAX_FILTER_BYTES } from "./subscribers.js";

export type { MeshthingsConfig } from "./config.js";
