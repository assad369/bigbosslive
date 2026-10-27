import express, { Router } from 'express';
import { z } from 'zod';
import { ROOM_TYPES } from '@bigboss/shared';
import type { Ctx } from '../context.js';
import { requireAuth } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/http.js';
import {
  currentUser,
  objectIdString,
  pageQuery,
  parseBody,
  parseParams,
  parseQuery,
  toObjectId,
} from '../lib/http.js';
import { unauthorized } from '../lib/errors.js';
import { liveChatInput, roomPassword, startLiveInput } from '../modules/live/live.service.js';

const roomParam = z.object({ id: objectIdString });

/** Live rooms, seats, and in-room moderation. */
export function liveRoutes(ctx: Ctx): Router {
  const r = Router();
  r.use(requireAuth(ctx));
  const { live } = ctx.services;
  const chatLimit = createRateLimiter(ctx.redis, {
    windowMs: 10_000,
    limit: 15,
    prefix: 'live-chat',
    byUser: true,
  });
  const reactionLimit = createRateLimiter(ctx.redis, {
    windowMs: 10_000,
    limit: 10,
    prefix: 'live-react',
    byUser: true,
  });
  // Room passwords are short, so guesses are capped per user.
  const passwordLimit = createRateLimiter(ctx.redis, {
    windowMs: 10 * 60_000,
    limit: 10,
    prefix: 'live-password',
    byUser: true,
  });
  const rid = (req: express.Request) => toObjectId(parseParams(req, roomParam).id, 'room id');
  const actor = (req: express.Request) => {
    const me = currentUser(req);
    return { uid: me.uid, isAdmin: Boolean(me.adminRole) };
  };

  r.post('/', async (req, res) => {
    const input = parseBody(req, startLiveInput);
    const result = await live.start(currentUser(req).uid, input);
    res.status(result.resumed ? 200 : 201).json(result);
  });

  r.get('/', async (req, res) => {
    const q = parseQuery(
      req,
      pageQuery.extend({
        type: z.enum(ROOM_TYPES).optional(),
        tab: z.enum(['popular', 'new', 'following', 'nearby']).default('popular'),
      }),
    );
    const me = currentUser(req);
    res.json(await live.list({ ...q, viewerUid: me.uid, country: me.user.country }));
  });

  r.get('/bans', async (req, res) => {
    res.json({ items: await live.roomBans(currentUser(req).uid) });
  });

  r.delete('/bans/:uid', async (req, res) => {
    const { uid } = z.object({ uid: z.string().min(1).max(128) }).parse(req.params);
    await live.unbanFromRoom(currentUser(req).uid, uid);
    res.status(204).end();
  });

  r.get('/:id', async (req, res) => {
    res.json({ room: await live.detail(rid(req)) });
  });

  r.post(
    '/:id/join',
    (req, res, next) => {
      if ((req.body as { password?: unknown } | undefined)?.password) passwordLimit(req, res, next);
      else next();
    },
    async (req, res) => {
      const password = parseBody(
        req,
        z.object({ password: roomPassword.optional() }).optional(),
      )?.password;
      const me = currentUser(req);
      res.json(
        await live.join(rid(req), me.uid, {
          ...(password ? { password } : {}),
          isStaff: Boolean(me.adminRole),
        }),
      );
    },
  );

  r.post('/:id/heartbeat', async (req, res) => {
    await live.heartbeat(rid(req), currentUser(req).uid);
    res.status(204).end();
  });

  r.patch('/:id', async (req, res) => {
    const patch = parseBody(
      req,
      z.object({
        title: z.string().trim().min(1).max(60).optional(),
        backgroundUrl: z.url().nullable().optional(),
        coverUrl: z.url().nullable().optional(),
      }),
    );
    res.json({ room: await live.update(rid(req), currentUser(req).uid, patch) });
  });

  r.post('/:id/lock', async (req, res) => {
    const { locked, password } = parseBody(
      req,
      z.object({ locked: z.boolean(), password: roomPassword.nullable().default(null) }),
    );
    res.json({ room: await live.setLock(rid(req), currentUser(req).uid, locked, password) });
  });

  r.post('/:id/chat', chatLimit, async (req, res) => {
    // Older builds send `{ text }` only.
    const body = req.body as Record<string, unknown> | undefined;
    if (body && body.type === undefined) body.type = 'text';
    const input = parseBody(req, liveChatInput);
    res.status(201).json({ message: await live.chat(rid(req), currentUser(req).uid, input) });
  });

  r.delete('/:id/chat/:messageId', async (req, res) => {
    const { messageId } = z.object({ messageId: objectIdString }).parse(req.params);
    await live.deleteChat(rid(req), actor(req), toObjectId(messageId, 'message id'));
    res.status(204).end();
  });

  r.post('/:id/reactions', reactionLimit, async (req, res) => {
    const { count } = parseBody(req, z.object({ count: z.number().int().min(1).max(20) }));
    await live.react(rid(req), currentUser(req).uid, count);
    res.status(204).end();
  });

  r.post('/:id/end', async (req, res) => {
    res.json({ summary: await live.endByHost(rid(req), currentUser(req).uid) });
  });

  r.get('/:id/viewers', async (req, res) => {
    res.json({ items: await live.viewers(rid(req)) });
  });

  r.post('/:id/kick', async (req, res) => {
    const { userId, banMinutes } = parseBody(
      req,
      z.object({
        userId: z.string().min(1).max(128),
        banMinutes: z.number().int().min(1).max(525_600).nullable().default(60),
      }),
    );
    await live.kick(rid(req), actor(req), userId, banMinutes);
    res.status(204).end();
  });

  r.post('/:id/moderators', async (req, res) => {
    const { userId, enabled } = parseBody(
      req,
      z.object({ userId: z.string().min(1).max(128), enabled: z.boolean() }),
    );
    await live.setModerator(rid(req), currentUser(req).uid, userId, enabled);
    res.status(204).end();
  });

  // Seats
  r.post('/:id/seats/request', async (req, res) => {
    res.status(202).json(await live.requestSeat(rid(req), currentUser(req).uid));
  });

  r.delete('/:id/seats/request', async (req, res) => {
    await live.cancelSeatRequest(rid(req), currentUser(req).uid);
    res.status(204).end();
  });

  r.get('/:id/seats/requests', async (req, res) => {
    const me = actor(req);
    res.json({ items: await live.seatRequests(rid(req), me.uid, me.isAdmin) });
  });

  r.post('/:id/seats/requests/:userId', async (req, res) => {
    const { userId } = z.object({ userId: z.string().min(1).max(128) }).parse(req.params);
    const { accept, index } = parseBody(
      req,
      z.object({
        accept: z.boolean(),
        index: z.number().int().min(1).max(15).nullable().default(null),
      }),
    );
    res.json(await live.decideSeat(rid(req), actor(req), userId, accept, index));
  });

  r.post('/:id/seats/invite', async (req, res) => {
    const { userId } = parseBody(req, z.object({ userId: z.string().min(1).max(128) }));
    await live.inviteToSeat(rid(req), actor(req), userId);
    res.status(202).end();
  });

  r.post('/:id/seats/invite/respond', async (req, res) => {
    const { accept } = parseBody(req, z.object({ accept: z.boolean() }));
    res.json(await live.respondToInvite(rid(req), currentUser(req).uid, accept));
  });

  r.post('/:id/seats/leave', async (req, res) => {
    await live.leaveSeat(rid(req), currentUser(req).uid);
    res.status(204).end();
  });

  r.post('/:id/seats/:index', async (req, res) => {
    const { index } = z.object({ index: z.coerce.number().int().min(0).max(15) }).parse(req.params);
    const { action } = parseBody(
      req,
      z.object({
        action: z.enum(['remove', 'mute', 'unmute', 'camera_off', 'camera_on', 'lock', 'unlock']),
      }),
    );
    await live.manageSeat(rid(req), actor(req), index, action);
    res.status(204).end();
  });

  r.get('/:id/pk', async (req, res) => {
    res.json(await ctx.services.pk.forRoom(rid(req)));
  });

  return r;
}

/**
 * LiveKit webhooks. Mounted before the JSON body parser: the signature covers the exact raw
 * body, so it must be verified against the bytes as received.
 */
export function livekitWebhookRoute(ctx: Ctx): Router {
  const r = Router();
  r.post('/livekit', express.raw({ type: '*/*', limit: '256kb' }), async (req, res) => {
    let event;
    try {
      event = await ctx.livekit.receiveWebhook(
        req.body.toString('utf8'),
        req.header('authorization'),
      );
    } catch {
      throw unauthorized('Invalid webhook signature');
    }
    const room = event.room?.name;
    const identity = event.participant?.identity;
    switch (event.event) {
      case 'participant_joined':
        if (room && identity) await ctx.services.live.onParticipantJoined(room, identity);
        break;
      case 'participant_left':
        if (room && identity) await ctx.services.live.onParticipantLeft(room, identity);
        break;
      case 'room_finished':
        if (room) await ctx.services.live.onRoomFinished(room);
        break;
      default:
        break;
    }
    res.status(200).json({ ok: true });
  });
  return r;
}
