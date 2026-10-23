import type { Server } from 'socket.io';

/**
 * Fan-out to Socket.IO clients from anywhere in the service layer. Backed by the Redis adapter
 * in production, so an emit on one replica reaches sockets connected to every replica.
 * Before `bind()` (and in tests) emits are dropped.
 */
export class RealtimeBus {
  private io: Server | null = null;

  bind(io: Server): void {
    this.io = io;
  }

  /** Every socket of a user, in a namespace. Sockets join `user:<uid>` on connect. */
  toUser(namespace: string, uid: string, event: string, payload: unknown): void {
    this.io?.of(namespace).to(`user:${uid}`).emit(event, payload);
  }

  toRoom(namespace: string, room: string, event: string, payload: unknown): void {
    this.io?.of(namespace).to(room).emit(event, payload);
  }

  broadcast(namespace: string, event: string, payload: unknown): void {
    this.io?.of(namespace).emit(event, payload);
  }
}
