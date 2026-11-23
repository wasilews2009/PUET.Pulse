import { io, type Socket } from 'socket.io-client';

/**
 * One Socket.io connection per tab, on the same origin (/api/ws). The session
 * cookie authenticates it; the server checks the Origin header (CSWSH) and
 * re-validates the session every minute. Events are addressed to this user only
 * and carry ids and ciphertext, never other people's plaintext of E2EE chats.
 */
let socket: Socket | null = null;

export function getSocket(): Socket {
  socket ??= io({ path: '/api/ws', transports: ['websocket'], withCredentials: true, reconnectionDelayMax: 15_000 });
  return socket;
}

export function closeSocket() {
  socket?.close();
  socket = null;
}

export async function emitAck<T>(event: string, payload: Record<string, unknown>, timeoutMs = 10_000): Promise<T> {
  const s = getSocket();
  return (await s.timeout(timeoutMs).emitWithAck(event, payload)) as T;
}
