import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { requireAuth } from '../middleware/auth.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import {
  currentUser,
  idempotencyKey,
  objectIdString,
  parseBody,
  parseParams,
  parseQuery,
  toObjectId,
  uidParam,
} from '../lib/http.js';
import { canModerateLive, canModerateUsers } from '../modules/moderation/authority.js';
import {
  moderatorBanInput,
  moderatorSearchQuery,
  type ModeratorActor,
} from '../modules/moderation/platform-moderators.service.js';

/** Platform moderators, or staff with `users.moderate`. Mount after `requireAuth`. */
export function requirePlatformModerator() {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) throw unauthorized();
    if (!canModerateUsers(req.auth.user, req.auth.adminRole))
      throw forbidden('Platform moderators only');
    next();
  };
}

/**
 * The app's Moderation panel (`/v1/moderator/*`). Every write is audited with the actor's
 * role (`platform_moderator` for app users), and every ban counts against the actor's hourly
 * allowance.
 */
export function moderatorRoutes(ctx: Ctx): Router {
  const r = Router();
  r.use(requireAuth(ctx), requirePlatformModerator());
  const svc = ctx.services.platformModerators;
  const audit = (
    req: Request,
    action: string,
    type: string,
    id: string | null,
    payload?: unknown,
  ) => ctx.services.audit.record(req, action, { type, id }, payload);
  const actor = (req: Request): ModeratorActor => {
    const me = currentUser(req);
    return { uid: me.uid, adminRole: me.adminRole, deviceId: me.deviceId };
  };

  r.get('/users', async (req, res) => {
    res.json(await svc.search(parseQuery(req, moderatorSearchQuery)));
  });

  r.get('/users/:uid', async (req, res) => {
    res.json({ user: await svc.get(parseParams(req, uidParam).uid) });
  });

  r.post('/users/:uid/ban', async (req, res) => {
    const { uid } = parseParams(req, uidParam);
    const input = parseBody(req, moderatorBanInput);
    const key = idempotencyKey(req);
    const me = actor(req);
    await svc.assertBanAllowance(me);
    const { result, replayed } = await svc.ban(me, uid, input, key);
    if (!replayed) {
      await audit(req, 'moderator.user_ban', 'user', uid, {
        reason: input.reason,
        days: input.days,
        banDevices: input.banDevices,
      });
      if (result.devices) await audit(req, 'moderator.device_ban', 'user', uid, result.devices);
    }
    res.json({ ...result, replayed, user: await svc.get(uid) });
  });

  r.post('/users/:uid/unban', async (req, res) => {
    const { uid } = parseParams(req, uidParam);
    await svc.unban(actor(req), uid);
    await audit(req, 'moderator.user_unban', 'user', uid);
    res.json({ user: await svc.get(uid) });
  });

  r.get('/users/:uid/devices', async (req, res) => {
    res.json({ items: await svc.devices(actor(req), parseParams(req, uidParam).uid) });
  });

  r.get('/users/:uid/device-ban-preview', async (req, res) => {
    res.json(await svc.previewUserDevices(actor(req), parseParams(req, uidParam).uid));
  });

  r.post('/devices/:deviceId/ban', async (req, res) => {
    const { deviceId } = z
      .object({ deviceId: z.string().trim().toLowerCase().min(6).max(128) })
      .parse(req.params);
    const { reason } = parseBody(req, z.object({ reason: z.string().trim().min(3).max(200) }));
    const key = idempotencyKey(req);
    const me = actor(req);
    await svc.assertBanAllowance(me);
    const { result, replayed } = await svc.banDevice(me, deviceId, reason, key);
    if (!replayed)
      await audit(req, 'moderator.device_ban', 'device', deviceId, { reason, ...result });
    res.json({ ...result, replayed });
  });

  r.get('/users/:uid/room-bans', async (req, res) => {
    res.json({ items: await svc.roomBans(parseParams(req, uidParam).uid) });
  });

  r.delete('/room-bans/:hostId/:uid', async (req, res) => {
    const { hostId, uid } = z
      .object({ hostId: z.string().min(1).max(128), uid: z.string().min(1).max(128) })
      .parse(req.params);
    await svc.liftRoomBan(hostId, uid);
    await audit(req, 'moderator.room_unban', 'user', uid, { hostId });
    res.status(204).end();
  });

  // End anyone's live (home card long-press, or "End for everyone" inside the room).
  r.post('/live/:id/end', async (req: Request, res) => {
    const me = currentUser(req);
    if (!canModerateLive(me.user, me.adminRole)) throw forbidden('Platform moderators only');
    const { id } = parseParams(req, z.object({ id: objectIdString }));
    const room = await ctx.services.live.endByModerator(toObjectId(id, 'room id'), me.uid);
    await audit(req, 'live.end', 'live_room', id, { hostId: room.hostId, by: 'moderator' });
    res.status(204).end();
  });

  return r;
}
