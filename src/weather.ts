import { CommandMap } from "./meshthing";
import cron from "node-cron";

// const knex = require("knex")({
//   client: "better-sqlite3",
//   connection: {
//     filename: "./db.sqlite",
//   },
// });

let data = {
  temperature: 0.0,
  lastUpdated: Date.now(),
};

function temperature() {
  return data.temperature;
}

function getWeather() {
  return data;
}

// Start periodically getting the weather and storing it
// TODO
cron.schedule(process.env.WEATHER_UPDATE_CRON || "", () => {
  //   // Get relevant weather
  //   // https://gist.github.com/PierBover/34ab4222a49bfd121b6ab21d60572de6
  //   // Store in memory for later sending
  data.lastUpdated = Date.now();
});

const commandMap: CommandMap = [{ commandStrings: ["temperature", "temp"], commandFunction: temperature }];

export { commandMap, getWeather };
