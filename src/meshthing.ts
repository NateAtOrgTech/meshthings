import { MeshDevice, Protobuf, Types } from "@meshtastic/core";
import { TransportNodeSerial } from "@meshtastic/transport-node-serial";

type Command = {
  commandStrings: string | string[];
  commandFunction: Function;
};

type CommandMap = Command[];

type InternalCommand = {
  commandStrings: string[];
  commandFunction: Function;
};

type InternalCommandMap = InternalCommand[];

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
    console.log("Config complete");
  } else {
    throw Error("Unable to configure device");
  }
}

async function configureCommands(commandMap: CommandMap) {
  //commands = commandMap;

  commandMap.forEach((command) => {
    if (typeof command.commandStrings === "string") {
      internalCommands.concat({ commandStrings: [command.commandStrings], commandFunction: command.commandFunction });
    } else {
      internalCommands.concat(command as InternalCommand);
    }
  });

  meshDevice.events.onMessagePacket.subscribe(async (messagePacket: Types.PacketMetadata<string>) => {
    // Filter messages we don't respond to
    if (myNodeInfo.myNodeNum === messagePacket.from || myNodeInfo.myNodeNum !== messagePacket.to) {
      return;
    }

    const tokens = messagePacket.split();
    let result = undefined;

    internalCommands.forEach(async (command) => {
      command.commandStrings.forEach(async (commandString) => {
        if (commandString === tokens[0]) {
          result = command.commandFunction(tokens);

          // Parse the command and get the destination
          // Send to the right command in the command map to collect the response
          await meshDevice.sendText(result, messagePacket.from, true, messagePacket.channel).catch((error) => {
            console.error(error);
          });
        }
      });
    });
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
