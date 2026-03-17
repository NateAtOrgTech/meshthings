import { MeshDevice, Protobuf, Types } from "@meshtastic/core";
import { TransportNodeSerial } from "@meshtastic/transport-node-serial";

const HEARTBEAT_INTERVAL_S = 5 * 60 * 1000; // 5 minutes

type Command = {
  commandStrings: string | string[];
  commandFunction: Function;
};

type CommandMap = { commands: Command[]; default: Function };

type InternalCommand = {
  commandStrings: string[];
  commandFunction: Function;
};

type InternalCommandMap = { commands: InternalCommand[]; default: Function };

let meshDevice: MeshDevice;
let myNodeInfo: Protobuf.Mesh.MyNodeInfo = undefined;
let internalCommands: InternalCommandMap = {} as InternalCommandMap;

async function configureDevice(deviceString: string) {
  const transport = await TransportNodeSerial.create(deviceString).catch((error) => {
    console.error(error);
  });

  if (transport) {
    meshDevice = new MeshDevice(transport);

    meshDevice.events.onMyNodeInfo.subscribe((nodeInfo: Protobuf.Mesh.MyNodeInfo) => {
      myNodeInfo = nodeInfo;
    });

    await meshDevice.configure().catch((error) => {
      console.error(error);
    });

    // If we don't set a heartbeat, serial times out after 15 minutes
    meshDevice.setHeartbeatInterval(HEARTBEAT_INTERVAL_S);

    console.log("Config complete");
  } else {
    throw Error("Unable to configure device");
  }
}

async function configureCommands(commandMap: CommandMap) {
  internalCommands.commands = [];

  commandMap.commands.forEach((command) => {
    if (typeof command.commandStrings === "string") {
      internalCommands.commands.push({ commandStrings: [command.commandStrings], commandFunction: command.commandFunction });
    } else {
      internalCommands.commands.push(command as InternalCommand);
    }

    if (commandMap.default) {
      internalCommands.default = commandMap.default;
    }
  });

  meshDevice.events.onMessagePacket.subscribe(async (messagePacket: Types.PacketMetadata<string>) => {
    // Filter messages we don't respond to
    if (myNodeInfo.myNodeNum === messagePacket.from || myNodeInfo.myNodeNum !== messagePacket.to) {
      return;
    }

    const tokens = messagePacket.data.split(" ");
    let result: string = "";
    let handled = false;

    // Collect the result from the correct command OR
    // use default if it exists
    internalCommands.commands.forEach((command) => {
      command.commandStrings.forEach(async (commandString) => {
        // case insensitive
        if (commandString.toLocaleLowerCase() === tokens[0].toLocaleLowerCase()) {
          result = command.commandFunction(tokens);

          handled = true;
        }
      });
    });
    if (!handled && internalCommands.default) {
      result = internalCommands.default(tokens);
      handled = true;
    }

    if ((handled = true)) {
      await meshDevice.sendText(result, messagePacket.from, true, messagePacket.channel).catch((error) => {
        console.error(error);
      });
    }
  });
  console.log("Event registration complete");
}

async function configure(deviceString: string, commandMap: CommandMap) {
  await configureDevice(deviceString).catch((error) => {
    console.error(error);
  });
  await configureCommands(commandMap).catch((error) => {
    console.error(error);
  });
}

export type { Command, CommandMap };

export { configureDevice, configureCommands, configure };
