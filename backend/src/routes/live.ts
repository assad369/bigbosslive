import express, { Router } from 'express';
import { z } from 'zod';
import { ROOM_TYPES } from '@bigboss/shared';
import type { Ctx } from '../context.js';
import { requireAuth } from '../middleware/auth.js';
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
import { startLiveInput } from '../modules/live/live.service.js';

const roomParam = z.object({ id: objectIdString });

/** Live rooms, seats, and in-room moderation. */
export function liveRoutes(ctx: Ctx): Router {
  const r = Router();
  r.use(requireAuth(ctx));
  const { live } = ctx.services;
  const rid = (req: express.Request) => toObjectId(parseParams(req, roomParam).id, 'room id');

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

  r.post('/:id/join', async (req, res) => {
    res.json(await live.join(rid(req), currentUser(req).uid));
  });

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
    const me = currentUser(req);
    await live.kick(rid(req), { uid: me.uid, isAdmin: Boolean(me.adminRole) }, userId, banMinutes);
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
    await live.requestSeat(rid(req), currentUser(req).uid);
    res.status(202).end();
  });

  r.get('/:id/seats/requests', async (req, res) => {
    res.json({ items: await live.seatRequests(rid(req), currentUser(req).uid) });
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
    res.json(await live.decideSeat(rid(req), currentUser(req).uid, userId, accept, index));
  });

  r.post('/:id/seats/invite', async (req, res) => {
    const { userId } = parseBody(req, z.object({ userId: z.string().min(1).max(128) }));
    await live.inviteToSeat(rid(req), currentUser(req).uid, userId);
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
      z.object({ action: z.enum(['remove', 'mute', 'unmute', 'lock', 'unlock']) }),
    );
    await live.manageSeat(rid(req), currentUser(req).uid, index, action);
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
