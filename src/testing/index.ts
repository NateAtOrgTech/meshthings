// Test support for meshthings, published separately from the core because a
// deployed node has no use for it and a contributor developing a thing without
// a radio has nothing but.

export type { MockDevice, MockDeviceOptions, SentMessage } from "./mockMeshtasticDevice.js";

export { createMockDevice, DEFAULT_NODE_NUM, DEFAULT_SENDER } from "./mockMeshtasticDevice.js";
