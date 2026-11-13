import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { SOCKET } from '@bigboss/shared';
import type { Ctx } from '../context.js';

interface SocketData {
  uid: string;
}

/**
 * Socket.IO server. Clients authenticate in the handshake with their Firebase ID token
 * (`auth: { token }`) and every socket joins `user:<uid>`, which is how services address a
 * user on any replica through the Redis adapter.
 */
export function attachSocketServer(ctx: Ctx, http: HttpServer): Server {
  const io = new Server(http, {
    path: '/socket.io',
    cors: { origin: ctx.env.NODE_ENV === 'production' ? ctx.env.CORS_ORIGINS : true },
    pingInterval: 25_000,
    pingTimeout: 20_000,
    maxHttpBufferSize: 64 * 1024,
    connectionStateRecovery: { maxDisconnectionDuration: 2 * 60_000 },
  });

  if (ctx.redis) {
    const pub = ctx.redis.duplicate();
    const sub = ctx.redis.duplicate();
    io.adapter(createAdapter(pub, sub));
  }

  const authenticate = async (socket: Socket, next: (err?: Error) => void) => {
    const token = (socket.handshake.auth as { token?: unknown }).token;
    if (typeof token !== 'string' || !token) return next(new Error('unauthorized'));
    try {
      const verified = await ctx.auth.verifyIdToken(token);
      const user = await ctx.col.users.findOne(
        { _id: verified.uid },
        { projection: { status: 1 } },
      );
      if (!user || user.status !== 'active') return next(new Error('forbidden'));
      if (await ctx.services.maintenance.blocks(verified.uid)) {
        return next(new Error('maintenance'));
      }
      (socket.data as SocketData).uid = verified.uid;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  };

  // ── App namespace: personal events + live directory ────────────────────────────
  const app = io.of(SOCKET.namespaces.app);
  app.use(authenticate);
  app.on('connection', (socket) => {
    const { uid } = socket.data as SocketData;
    void socket.join(`user:${uid}`);
    socket.on(SOCKET.app.subscribeRooms, () => void socket.join('rooms'));
    socket.on(SOCKET.app.unsubscribeRooms, () => void socket.leave('rooms'));
    socket.on(SOCKET.app.chatTyping, async (payload: unknown) => {
      const conversationId = (payload as { conversationId?: unknown })?.conversationId;
      if (typeof conversationId !== 'string') return;
      const peer = await ctx.services.chat.isParticipant(uid, conversationId).catch(() => null);
      if (peer)
        ctx.realtime.toUser(SOCKET.namespaces.app, peer, SOCKET.app.chatTyping, {
          conversationId,
          uid,
        });
    });
  });

  ctx.realtime.bind(io);
  return io;
}
