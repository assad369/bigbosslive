import { Router } from 'express';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { requireAuth } from '../middleware/auth.js';
import {
  currentUser,
  cursorQuery,
  objectIdString,
  parseBody,
  parseParams,
  parseQuery,
  toObjectId,
} from '../lib/http.js';
import { sendMessageInput } from '../modules/chat/chat.service.js';
import { commentInput, createPostInput } from '../modules/feed/feed.service.js';

const idParams = z.object({ id: objectIdString });

/** Direct messages, the news feed, notifications and PK battles. */
export function socialRoutes(ctx: Ctx): Router {
  const r = Router();
  // Scope auth to this router's own prefixes so unknown /v1 paths still fall through to 404.
  r.use(['/chat', '/feed', '/notifications', '/pk'], requireAuth(ctx));
  const { chat, feed, notifications, pk } = ctx.services;
  const id = (req: Parameters<typeof parseParams>[0]) => toObjectId(parseParams(req, idParams).id);

  // ── Chat ────────────────────────────────────────────────────────────────
  r.get('/chat/conversations', async (req, res) => {
    const { cursor, limit } = parseQuery(req, cursorQuery);
    res.json(await chat.conversations(currentUser(req).uid, cursor, limit));
  });

  r.post('/chat/conversations', async (req, res) => {
    const { userId } = parseBody(req, z.object({ userId: z.string().min(1).max(128) }));
    const conv = await chat.conversationWith(currentUser(req).uid, userId);
    res.json({ id: String(conv._id) });
  });

  r.get('/chat/conversations/:id/messages', async (req, res) => {
    const { cursor, limit } = parseQuery(req, cursorQuery);
    res.json(await chat.messages(currentUser(req).uid, id(req), cursor, limit));
  });

  r.post('/chat/conversations/:id/read', async (req, res) => {
    await chat.markRead(currentUser(req).uid, id(req));
    res.status(204).end();
  });

  r.post('/chat/messages', async (req, res) => {
    res
      .status(201)
      .json({ message: await chat.send(currentUser(req).uid, parseBody(req, sendMessageInput)) });
  });

  r.delete('/chat/messages/:id', async (req, res) => {
    await chat.deleteMessage(currentUser(req).uid, id(req));
    res.status(204).end();
  });

  r.get('/chat/unread', async (req, res) => {
    res.json({ count: await chat.unreadTotal(currentUser(req).uid) });
  });

  // ── Feed ────────────────────────────────────────────────────────────────
  r.get('/feed', async (req, res) => {
    const q = parseQuery(
      req,
      cursorQuery.extend({
        tab: z.enum(['latest', 'trending', 'following', 'user']).default('latest'),
        authorId: z.string().max(128).optional(),
      }),
    );
    res.json(await feed.list(currentUser(req).uid, q));
  });

  r.post('/feed', async (req, res) => {
    res
      .status(201)
      .json({ post: await feed.create(currentUser(req).uid, parseBody(req, createPostInput)) });
  });

  r.get('/feed/:id', async (req, res) => {
    res.json({ post: await feed.get(currentUser(req).uid, id(req)) });
  });

  r.delete('/feed/:id', async (req, res) => {
    await feed.remove(currentUser(req).uid, id(req), false);
    res.status(204).end();
  });

  r.post('/feed/:id/like', async (req, res) => {
    res.json(await feed.like(currentUser(req).uid, id(req), true));
  });

  r.delete('/feed/:id/like', async (req, res) => {
    res.json(await feed.like(currentUser(req).uid, id(req), false));
  });

  r.get('/feed/:id/comments', async (req, res) => {
    const { cursor, limit } = parseQuery(req, cursorQuery);
    res.json(await feed.comments(id(req), cursor, limit));
  });

  r.post('/feed/:id/comments', async (req, res) => {
    const { text } = parseBody(req, commentInput);
    res.status(201).json({ comment: await feed.comment(currentUser(req).uid, id(req), text) });
  });

  r.delete('/feed/comments/:id', async (req, res) => {
    await feed.removeComment(currentUser(req).uid, id(req), false);
    res.status(204).end();
  });

  // ── Notifications ───────────────────────────────────────────────────────────
  r.get('/notifications', async (req, res) => {
    const { cursor, limit } = parseQuery(req, cursorQuery);
    res.json(await notifications.list(currentUser(req).uid, cursor, limit));
  });

  r.get('/notifications/unread-count', async (req, res) => {
    const uid = currentUser(req).uid;
    const [notificationsCount, chatCount] = await Promise.all([
      notifications.unreadCount(uid),
      chat.unreadTotal(uid),
    ]);
    res.json({ notifications: notificationsCount, chat: chatCount });
  });

  r.post('/notifications/read', async (req, res) => {
    const { ids } = parseBody(
      req,
      z.object({ ids: z.union([z.literal('all'), z.array(objectIdString).max(200)]) }),
    );
    await notifications.markRead(
      currentUser(req).uid,
      ids === 'all' ? 'all' : ids.map((i) => toObjectId(i)),
    );
    res.status(204).end();
  });

  // ── PK battles ───────────────────────────────────────────────────────────
  const duration = z.number().int().min(60).max(1800);

  r.post('/pk/invite', async (req, res) => {
    const { opponentId, durationSec } = parseBody(
      req,
      z.object({ opponentId: z.string().min(1).max(128), durationSec: duration }),
    );
    res
      .status(201)
      .json({ battle: await pk.invite(currentUser(req).uid, opponentId, durationSec) });
  });

  r.post('/pk/random', async (req, res) => {
    const { durationSec } = parseBody(req, z.object({ durationSec: duration }));
    res.status(201).json({ battle: await pk.randomMatch(currentUser(req).uid, durationSec) });
  });

  r.post('/pk/:id/respond', async (req, res) => {
    const { accept } = parseBody(req, z.object({ accept: z.boolean() }));
    res.json({ battle: await pk.respond(id(req), currentUser(req).uid, accept) });
  });

  r.post('/pk/:id/cancel', async (req, res) => {
    await pk.cancel(id(req), currentUser(req).uid);
    res.status(204).end();
  });

  r.post('/pk/:id/end', async (req, res) => {
    await pk.endByHost(id(req), currentUser(req).uid);
    res.status(204).end();
  });

  r.get('/pk/:id', async (req, res) => {
    res.json(await pk.get(id(req)));
  });

  return r;
}
