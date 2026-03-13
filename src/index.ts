import express, { Request, Response } from "express";
import "dotenv/config";

import { configure } from "./meshthing";
import { commandMap, getWeather } from "./weather";

// Setup meshtastic device
// const device = await configure(process.env.SERIAL_DEVICE || "", commandMap);

// Start the server
const app = express();

app.get("/", (req: Request, res: Response) => {
  // Send relevant stats
  res.send(JSON.stringify(getWeather()));
});

app.listen(process.env.PORT, () => console.log("Server started"));
