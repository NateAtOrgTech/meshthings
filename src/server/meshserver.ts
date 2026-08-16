import express, { Request, Response } from "express";
import { createRequire } from "node:module";

import { createMeshThing, MeshThing, MeshThingOptions, ModuleSpec } from "../core/index.js";

// Reported by the `sys` command, so an operator can tell what is deployed
// ../../ from src/server and from dist/server alike -- both land on the
// project root, so this resolves the same in development and in a build
const { version } = createRequire(import.meta.url)("../../package.json");

type StartOptions = MeshThingOptions & {
  // Omit to leave the stats page off
  httpPort?: number;
};

// Resolves once the port is bound, rejects if it cannot be. Separated from
// start() so it can be tested without a radio attached.
function createStatsServer(meshThing: MeshThing, httpPort: number) {
  const app = express();

  app.get("/", (req: Request, res: Response) => {
    // Send relevant stats, and which meshthings are mounted
    res.json({ modules: meshThing.getModules(), ...meshThing.getStats() });
  });

  return new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
    const server = app.listen(httpPort);

    // Without this an EADDRINUSE is an unhandled 'error' event, which is an
    // uncaught exception -- the node would die for want of a stats page
    server.once("error", reject);
    server.once("listening", () => {
      server.removeListener("error", reject);

      // Once it is up, a later socket error must not become an uncaught
      // exception either -- the radio outlives the stats page
      server.on("error", (error) => console.error("Stats page error:", error));

      resolve(server);
    });
  });
}

async function start(deviceString: string, modules: ModuleSpec[], options: StartOptions = {}) {
  const { httpPort, ...meshThingOptions } = options;

  // Configure and run the meshtastic device
  const meshThing = createMeshThing({ version, ...meshThingOptions });
  await meshThing.configureAndListen(deviceString, modules);

  // Started after the radio, so a reachable port means the node is genuinely
  // up rather than merely running. That is what makes it worth monitoring --
  // and why a port it cannot bind is a startup failure rather than a warning:
  // an ambiguous health check is barely better than none.
  if (httpPort) {
    try {
      await createStatsServer(meshThing, httpPort);
      console.log(`Stats page on port ${httpPort}`);
    } catch (error) {
      await meshThing.stop();

      throw new Error(`Could not start the stats page on port ${httpPort}: ${(error as Error).message}`);
    }
  }

  return meshThing;
}

const meshServer = {
  start,
};

export type { StartOptions };

export { meshServer, createStatsServer, version };
