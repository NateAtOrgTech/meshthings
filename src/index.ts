import "dotenv/config";

import { createConfig } from "./meshthings.config.js";
import { meshServer } from "./server/meshserver.js";

// Deliberately thin. Everything a deployment decides lives in
// meshthings.config.ts, which upstream never edits, so pulling upstream
// changes into a fork cannot conflict with local configuration.
const config = createConfig();

await meshServer
  .start(config.device, config.modules, { ...config.options, httpPort: config.httpPort, usage: config.usage, connect: config.connect })
  .catch((error) => {
    console.error("Failed to start:", error);
    process.exit(1);
  });
