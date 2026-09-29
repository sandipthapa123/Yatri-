import type { ServerRealtimeMessage } from '@yatri/types';

/**
 * What a controller needs from a realtime connection. ONE definition, shared by chat, calls and
 * offers: the trip socket (LiveTripController.socket) and the driver's presence socket both satisfy it,
 * so no controller opens or owns a connection of its own.
 */
export interface ServerMessageBus {
  onMessage(listener: (m: ServerRealtimeMessage) => void): () => void;
  onConnectionChange(listener: (c: string) => void): () => void;
}

/** A bus that can also send (calls carry signalling back to the server). */
export interface RideSocket extends ServerMessageBus {
  send(message: object): void;
}
