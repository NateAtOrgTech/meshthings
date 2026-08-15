import express, { Request, Response } from "express";
import { CommandMap, createMeshThing, ModuleSpec } from "./meshthing";

async function start(deviceString: string, source: CommandMap | ModuleSpec[]) {
  // Configure and run the meshtastic device
  const meshThing = createMeshThing();
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
