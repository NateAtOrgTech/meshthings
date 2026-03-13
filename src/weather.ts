import { CommandMap } from "./meshthing";
import dgram, { BindOptions } from "dgram";

const server = dgram.createSocket("udp4");

server.on("error", (error: Error) => {
  console.error(`server error:\n${error.stack}`);
  server.close();
});

server.on("message", (message, udpInfo) => {
  const parsedMessage = JSON.parse(message.toString());

  if (parsedMessage.type === "obs_st") {
    data.temperatureC = parsedMessage.obs[0][7];
    data.temperatureF = data.temperatureC * (9.0 / 5) + 32;
    data.lastUpdated = Date.now();
  }
});

server.on("listening", () => {
  const address = server.address();
  console.log(`Listening for weather broadcast on ${address.address}:${address.port}`);
});

server.bind(process.env.WEATHER_STATION_PORT as BindOptions); // Listen on port 41234

let data = {
  temperatureC: 0.0,
  temperatureF: 0.0,
  lastUpdated: Date.now(),
};

function temperature() {
  return data.temperatureF;
}

function getWeather() {
  return data;
}

// Start periodically getting the weather and storing it
// TODO
// cron.schedule(process.env.WEATHER_UPDATE_CRON || "", () => {
//   // Get relevant weather
//   // https://gist.github.com/PierBover/34ab4222a49bfd121b6ab21d60572de6
//   // Store in memory for later sending
// data.lastUpdated = Date.now();
// });

const commandMap: CommandMap = [{ commandStrings: ["temperature", "temp"], commandFunction: temperature }];

export { commandMap, getWeather };
