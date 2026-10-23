import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import { SOCKET } from '@bigboss/shared';
import { createApp } from '../src/app.js';
import { attachSocketServer } from '../src/realtime/socket.js';
import { createHarness, tokenFor, type Harness } from './helpers/harness.js';

let h: Harness;
let server: Server;
let url: string;
const sockets: Socket[] = [];

beforeAll(async () => {
  h = await createHarness();
  await h.user('ana');
  await h.user('bo');
  server = createServer(createApp(h.ctx));
  attachSocketServer(h.ctx, server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  sockets.forEach((s) => s.close());
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await h.close();
});

function open(uid: string | null, namespace = ''): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = connect(`${url}${namespace}`, {
      auth: uid ? { token: tokenFor(uid) } : {},
      transports: ['websocket'],
      reconnection: false,
    });
    sockets.push(s);
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}

describe('socket.io', () => {
  it('rejects unauthenticated handshakes', async () => {
    await expect(open(null)).rejects.toThrow(/unauthorized/);
  });

  it('delivers chat messages to the recipient in real time', async () => {
    const bo = await open('bo');
    const received = new Promise<{ text: string; senderId: string }>((resolve) =>
      bo.on(SOCKET.app.chatMessage, resolve),
    );
    await h.api
      .post('/v1/chat/messages')
      .set(h.as('ana'))
      .send({ toUserId: 'bo', type: 'text', text: 'Live now?' })
      .expect(201);
    expect(await received).toMatchObject({ text: 'Live now?', senderId: 'ana' });
  });

  it('relays typing indicators only between participants', async () => {
    const ana = await open('ana');
    const bo = await open('bo');
    const conv = await h.api.post('/v1/chat/conversations').set(h.as('ana')).send({ userId: 'bo' });
    const typing = new Promise((resolve) => bo.on(SOCKET.app.chatTyping, resolve));
    ana.emit(SOCKET.app.chatTyping, { conversationId: conv.body.id });
    expect(await typing).toEqual({ conversationId: conv.body.id, uid: 'ana' });
  });

  it('pushes live-directory updates to subscribers', async () => {
    const ana = await open('ana');
    ana.emit(SOCKET.app.subscribeRooms);
    await new Promise((r) => setTimeout(r, 50));
    const upserted = new Promise<{ id: string }>((resolve) =>
      ana.on(SOCKET.app.roomUpserted, resolve),
    );
    const res = await h.api.post('/v1/live').set(h.as('bo')).send({ title: 'Going live' });
    expect((await upserted).id).toBe(res.body.room.id);
  });

  it('serves game state on subscribe in the games namespace', async () => {
    await h.ctx.services.games.ensureRegistry();
    await h.ctx.services.games.updateMeta('teen_patti', { enabled: true });
    await h.ctx.services.games.tick();
    const g = await open('ana', SOCKET.namespaces.games);
    const state = await new Promise<{ round: { status: string } }>((resolve) =>
      g.emit(SOCKET.games.subscribe, 'teen_patti', resolve),
    );
    expect(state.round.status).toBe('betting');
  });
});
