import "dotenv/config";

import { commandMap } from "./weather";
import { meshServer } from "./meshserver";

await meshServer.start(process.env.SERIAL_DEVICE || "", commandMap);
