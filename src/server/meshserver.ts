import express, { Request, Response } from "express";
import { createRequire } from "node:module";

import { CommandMap, createMeshThing, MeshThingOptions, ModuleSpec } from "../core/index.js";

// Reported by the `sys` command, so an operator can tell what is deployed
// ../../ from src/server and from dist/server alike -- both land on the
// project root, so this resolves the same in development and in a build
const { version } = createRequire(import.meta.url)("../../package.json");

type StartOptions = MeshThingOptions & {
  // Omit to leave the stats page off
  httpPort?: number;
};

async function start(deviceString: string, source: CommandMap | ModuleSpec[], options: StartOptions = {}) {
  const { httpPort, ...meshThingOptions } = options;

  // Configure and run the meshtastic device
  const meshThing = createMeshThing({ version, ...meshThingOptions });
  await meshThing.configureAndListen(deviceString, source);

  // Setup and start the web server
  const app = express();

  app.get("/", (req: Request, res: Response) => {
    // Send relevant stats, and which meshthings are mounted
    res.json({ modules: meshThing.getModules(), ...meshThing.getStats() });
  });

  if (httpPort) {
    app.listen(httpPort, () => console.log(`Stats page on port ${httpPort}`));
  }

  return meshThing;
}

const meshServer = {
  start,
};

export type { StartOptions };

export { meshServer, version };
