import express, { Request, Response } from "express";
import { CommandMap, meshThing } from "./meshthing";

async function start(deviceString: string, commands: CommandMap) {
  // Configure and run the meshtastic device
  await meshThing.configureAndListen(deviceString || "", commands);

  // Setup and start the web server
  const app = express();

  app.get("/", (req: Request, res: Response) => {
    // Send relevant stats
    res.send(meshThing.getStats());
  });

  app.listen(process.env.PORT, () => console.log("Server started"));
}

const meshServer = {
  start,
};

export { meshServer };
