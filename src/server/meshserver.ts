import express, { Request, Response } from "express";
import { createRequire } from "node:module";

import { Connect, createMeshThing, MeshThing, MeshThingOptions, ModuleSpec, UsageLog } from "../core/index.js";

// Reported by the `sys` command, so an operator can tell what is deployed
// ../../ from src/server and from dist/server alike -- both land on the
// project root, so this resolves the same in development and in a build
const { version } = createRequire(import.meta.url)("../../package.json");

type StartOptions = MeshThingOptions & {
  // Omit to leave the stats page off
  httpPort?: number;
  // How to reach the radio. Defaults to serial; supply another for a device
  // over wifi, or a fake one in a test.
  connect?: Connect;
};

// Resolves once the port is bound, rejects if it cannot be. Separated from
// start() so it can be tested without a radio attached.
function createStatsServer(meshThing: MeshThing, httpPort: number, usage?: UsageLog) {
  const app = express();

  app.get("/", (req: Request, res: Response) => {
    // Send relevant stats, and which meshthings are mounted
    res.json({ modules: meshThing.getModules(), ...meshThing.getStats() });
  });

  // Whether the node is working, as opposed to merely running. A monitor reads
  // the status code: connection refused means the process is gone, 200 means
  // nothing is complaining, 503 means it is up but something is wrong.
  app.get("/health", (req: Request, res: Response) => {
    const health = meshThing.getHealth();

    res.status(health.ok ? 200 : 503).json(health);
  });

  // Whether the node is worth running, as opposed to whether it is running.
  // Absent entirely when nothing is being recorded, rather than reporting zeroes
  // that read like "nobody used it".
  app.get("/usage", (req: Request, res: Response) => {
    if (!usage) {
      res.status(404).json({ error: "usage is not being recorded on this node" });

      return;
    }

    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), usage.retentionDays);

    res.json({ retentionDays: usage.retentionDays, ...usage.summary(days) });
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
  const { httpPort, connect, ...meshThingOptions } = options;

  // Configure and run the meshtastic device
  const meshThing = createMeshThing({ version, ...meshThingOptions });
  await meshThing.configureAndListen(deviceString, modules, connect);

  // Started after the radio, so a reachable port means the node is genuinely
  // up rather than merely running. That is what makes it worth monitoring --
  // and why a port it cannot bind is a startup failure rather than a warning:
  // an ambiguous health check is barely better than none.
  if (httpPort) {
    try {
      await createStatsServer(meshThing, httpPort, options.usage);
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
