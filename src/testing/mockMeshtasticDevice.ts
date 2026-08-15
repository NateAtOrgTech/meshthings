import { MeshDevice, Types } from "@meshtastic/core";

// A stand-in for a real radio. Deliberately a *device*-level mock rather than a
// Transport-level one: mocking Transport means hand-building protobuf frames,
// which tests meshtastic's plumbing instead of your commands.

const DEFAULT_NODE_NUM = 0x11111111;
const DEFAULT_SENDER = 0x22222222;

type SentMessage = {
  text: string;
  to: Types.Destination;
  wantAck: boolean;
  channel: Types.ChannelNumber | undefined;
  // Milliseconds since the mock was created, for asserting on pacing
  at: number;
};

type ReceiveOptions = {
  from?: number;
  to?: number;
  channel?: Types.ChannelNumber;
};

type MockDeviceOptions = {
  nodeNum?: number;
  // Hold back the node-identity event, to test packets arriving before the
  // radio has told us who we are
  deferIdentify?: boolean;
};

function createEmitter<T>() {
  const subscribers: ((value: T) => void)[] = [];

  return {
    subscribe(callback: (value: T) => void) {
      subscribers.push(callback);
    },
    emit(value: T) {
      subscribers.forEach((callback) => callback(value));
    },
    get count() {
      return subscribers.length;
    },
  };
}

function createMockDevice(options: MockDeviceOptions = {}) {
  const nodeNum = options.nodeNum ?? DEFAULT_NODE_NUM;
  const start = Date.now();
  const sent: SentMessage[] = [];
  const messages = createEmitter<Types.PacketMetadata<string>>();
  const nodeInfo = createEmitter<{ myNodeNum: number }>();

  let identified = false;
  let failNext: Error | undefined;

  const device = {
    events: {
      onMessagePacket: messages,
      onMyNodeInfo: {
        subscribe(callback: (value: { myNodeNum: number }) => void) {
          nodeInfo.subscribe(callback);

          // A configured radio already knows its own number, so report it
          // straight away unless a test wants the pre-identity window
          if (!options.deferIdentify && !identified) {
            identified = true;
            callback({ myNodeNum: nodeNum });
          }
        },
      },
    },
    setHeartbeatInterval() {},
    async configure() {},
    async sendText(
      text: string,
      to: Types.Destination = "broadcast",
      wantAck = true,
      channel?: Types.ChannelNumber,
    ) {
      if (failNext) {
        const error = failNext;
        failNext = undefined;
        throw error;
      }

      sent.push({ text, to, wantAck, channel, at: Date.now() - start });

      return sent.length;
    },
  } as unknown as MeshDevice;

  return {
    device,
    sent,

    // Fire the node-identity event by hand (pairs with deferIdentify)
    identify() {
      identified = true;
      nodeInfo.emit({ myNodeNum: nodeNum });
    },

    // Simulate an inbound text. Defaults to a direct message from another node,
    // which is the case command handlers actually run for.
    receive(text: string, receiveOptions: ReceiveOptions = {}) {
      messages.emit({
        data: text,
        from: receiveOptions.from ?? DEFAULT_SENDER,
        to: receiveOptions.to ?? nodeNum,
        channel: receiveOptions.channel ?? (0 as Types.ChannelNumber),
      } as Types.PacketMetadata<string>);
    },

    // Make the next transmit throw, to exercise send-failure handling
    failNextSend(error = new Error("radio failure")) {
      failNext = error;
    },

    texts() {
      return sent.map((message) => message.text);
    },

    // Resolve once `count` messages have gone out, so tests don't guess at sleeps.
    // Sits just under the runner's own --test-timeout: low enough to still
    // report which sends were seen, high enough that a machine busy running
    // several test files never turns starvation into a spurious failure.
    async waitForSends(count: number, timeoutMs = 25000) {
      const deadline = Date.now() + timeoutMs;

      while (sent.length < count) {
        if (Date.now() > deadline) {
          throw new Error(`Timed out waiting for ${count} sends (saw ${sent.length}: ${JSON.stringify(this.texts())})`);
        }

        await new Promise((resolve) => setTimeout(resolve, 2));
      }

      return sent;
    },

    // Give the queue a moment to *not* send something
    async settle(milliseconds = 30) {
      await new Promise((resolve) => setTimeout(resolve, milliseconds));
    },

    clear() {
      sent.length = 0;
    },

    nodeNum,
  };
}

type MockDevice = ReturnType<typeof createMockDevice>;

export type { MockDevice, MockDeviceOptions, SentMessage };

export { createMockDevice, DEFAULT_NODE_NUM, DEFAULT_SENDER };
