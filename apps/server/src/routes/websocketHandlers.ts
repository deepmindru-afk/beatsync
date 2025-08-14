import {
  ClientActionEnum,
  epochNow,
  WSBroadcastType,
  WSRequestSchema,
} from "@beatsync/shared";
import { Server, ServerWebSocket } from "bun";
import { globalManager } from "../managers";
import { sendBroadcast, sendUnicast } from "../utils/responses";
import { WSData } from "../utils/websocket";
import { dispatchMessage } from "../websocket/dispatch";

const createClientUpdate = (roomId: string) => {
  const room = globalManager.getRoom(roomId);
  const message: WSBroadcastType = {
    type: "ROOM_EVENT",
    event: {
      type: "CLIENT_CHANGE",
      clients: room ? room.getClients() : [],
    },
  };
  return message;
};

export const handleOpen = (ws: ServerWebSocket<WSData>, server: Server) => {
  console.log(
    `WebSocket connection opened for user ${ws.data.username} in room ${ws.data.roomId}`
  );
  // Client already knows its ID from PostHog, no need to send SET_CLIENT_ID

  const { roomId } = ws.data;
  ws.subscribe(roomId);

  const room = globalManager.getOrCreateRoom(roomId);
  room.addClient(ws);

  // Send audio sources to the newly joined client if any exist
  const { audioSources } = room.getState();
  if (audioSources.length > 0) {
    console.log(
      `Sending ${audioSources.length} audio source(s) to newly joined client ${ws.data.username}`
    );

    // TODO: this is not ideal:
    // - we need to send one message per event, what we are really trying to do is sync this client
    // We should actually just create a single unicast message catching the client up with all of this bundled into one message (even broadcast is fine but it should be one message)
    // just the issue is that we do diff instead of full state sync
    sendBroadcast({
      server,
      roomId,
      message: {
        type: "ROOM_EVENT",
        event: {
          type: "SET_AUDIO_SOURCES",
          sources: audioSources,
          currentAudioSource: room.getPlaybackState().audioSource || undefined,
        },
      },
      // Optionally, you could add a filter to only send to this ws if needed,
      // but by default this will broadcast to all in the room.
    });
  }

  // Always send the current playback controls
  sendBroadcast({
    server,
    roomId,
    message: {
      type: "ROOM_EVENT",
      event: {
        type: "SET_PLAYBACK_CONTROLS",
        permissions: room.getPlaybackControlsPermissions(),
      },
    },
  });

  // Send current global volume state to the newly joined client only
  sendUnicast({
    ws,
    message: {
      type: "SCHEDULED_ACTION",
      serverTimeToExecute: epochNow(),
      scheduledAction: {
        type: "GLOBAL_VOLUME_CONFIG",
        volume: room.getState().globalVolume,
        rampTime: 0.1,
      },
    },
  });

  const message = createClientUpdate(roomId);
  sendBroadcast({ server, roomId, message });
};

export const handleMessage = async (
  ws: ServerWebSocket<WSData>,
  message: string | Buffer,
  server: Server
) => {
  const t1 = epochNow(); // Always calculate this immediately
  const { roomId, username } = ws.data;

  try {
    const parsedData = JSON.parse(message.toString());
    const parsedMessage = WSRequestSchema.parse(parsedData);

    if (parsedMessage.type !== ClientActionEnum.enum.NTP_REQUEST) {
      console.log(
        `[Room: ${roomId}] | User: ${username} | Message: ${JSON.stringify(
          parsedMessage
        )}`
      );
    }

    if (parsedMessage.type === ClientActionEnum.enum.NTP_REQUEST) {
      // Manually mutate the message to include the t1 timestamp
      parsedMessage.t1 = t1;
    }

    // Delegate to type-safe dispatcher
    await dispatchMessage({ ws, message: parsedMessage, server });
  } catch (error) {
    console.error("Invalid message format:", error);
    ws.send(
      JSON.stringify({ type: "ERROR", message: "Invalid message format" })
    );
  }
};

export const handleClose = async (
  ws: ServerWebSocket<WSData>,
  server: Server
) => {
  try {
    console.log(
      `WebSocket connection closed for user ${ws.data.username} in room ${ws.data.roomId}`
    );

    const { roomId, clientId } = ws.data;
    const room = globalManager.getRoom(roomId);

    if (room) {
      room.removeClient(clientId);

      // Schedule cleanup for rooms with no active connections
      if (!room.hasActiveConnections()) {
        room.stopSpatialAudio();
        globalManager.scheduleRoomCleanup(roomId);
      }
    }

    const message = createClientUpdate(roomId);
    ws.unsubscribe(roomId);
    server.publish(roomId, JSON.stringify(message));
  } catch (error) {
    console.error(
      `Error handling WebSocket close for ${ws.data?.username}:`,
      error
    );
  }
};
