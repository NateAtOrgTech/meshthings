import { MeshThingOptions, ModuleSpec } from "./meshthing.js";
import { UsageLog } from "./usage.js";

// What a deployment declares. This type is upstream's; the file that fills it
// in belongs to whoever is running the node -- see meshthings.config.ts.
type MeshthingsConfig = {
  // Serial path of the meshtastic node, e.g. /dev/ttyUSB0
  device: string;
  // Port for the local HTTP stats page. Omit to disable it.
  httpPort?: number;
  // Which meshthings run, in mount order
  modules: ModuleSpec[];
  // Pacing, queue limits, reply to an unknown command
  options?: MeshThingOptions;
  // Records what the node is used for. Omit to record nothing.
  usage?: UsageLog;
};

export type { MeshthingsConfig };
