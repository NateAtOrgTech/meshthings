import express, { Request, Response } from "express";
import { createRequire } from "node:module";

import { CommandMap, createMeshThing, MeshThingOptions, ModuleSpec } from "./meshthing.js";

// Reported by the `sys` command, so an operator can tell what is deployed
const { version } = createRequire(import.meta.url)("../package.json");

async function start(deviceString: string, source: CommandMap | ModuleSpec[], options: MeshThingOptions = {}) {
  // Configure and run the meshtastic device
  const meshThing = createMeshThing({ version, ...options });
  await meshThing.configureAndListen(deviceString, source);

  // Setup and start the web server
  const app = express();

  app.get("/", (req: Request, res: Response) => {
    // Send relevant stats, and which meshthings are mounted
    res.json({ modules: meshThing.getModules(), ...meshThing.getStats() });
  });

  app.listen(process.env.PORT, () => console.log("Server started"));

  return meshThing;
}

const meshServer = {
  start,
};

export { meshServer };
