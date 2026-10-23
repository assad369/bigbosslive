import { Router } from 'express';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { requireAuth, requireToken } from '../middleware/auth.js';
import { currentUser, cursorQuery, pageQuery, parseBody, parseParams, parseQuery, uidParam } from '../lib/http.js';
import { unauthorized } from '../lib/errors.js';
import { profileInput } from '../modules/users/users.service.js';
import { toMeUser } from '../modules/users/users.presenter.js';
import { pushTokenInput } from '../modules/notifications/notifications.service.js';
import { reportInput } from '../modules/moderation/moderation.service.js';

/** Session bootstrap, the caller's own profile, other users' profiles, follows and blocks. */
export function accountRoutes(ctx: Ctx): Router {
  const r = Router();
  const auth = requireAuth(ctx);
  const { users, follows, levels, notifications, moderation, gifts } = ctx.services;

  const me = async (uid: string) => {
    const user = await users.get(uid);
    return toMeUser(user, await levels.progress(user), ctx.clock.now());
  };

  /** Call after every Firebase sign-in and app launch. Creates the profile on first call. */
  r.post('/auth/session', requireToken(ctx), async (req, res) => {
    if (!req.token) throw unauthorized();
    const input = parseBody(req, profileInput.partial().default({}));
    const { user, created } = await users.ensureProfile(req.token, input);
    res.status(created ? 201 : 200).json({ user: await me(user._id), created });
  });

  r.get('/me', auth, async (req, res) => {
    res.json({ user: await me(currentUser(req).uid) });
  });

  r.patch('/me', auth, async (req, res) => {
    const patch = parseBody(req, profileInput.partial());
    await users.updateProfile(currentUser(req).uid, patch);
    res.json({ user: await me(currentUser(req).uid) });
  });

  r.delete('/me', auth, async (req, res) => {
    await users.deleteAccount(currentUser(req).uid);
    res.status(204).end();
  });

  r.get('/me/blocked', auth, async (req, res) => {
    res.json({ items: await users.blockedList(currentUser(req).uid) });
  });

  r.post('/me/push-tokens', auth, async (req, res) => {
    const { token, platform } = parseBody(req, pushTokenInput);
    await notifications.registerToken(currentUser(req).uid, token, platform);
    res.status(204).end();
  });

  r.delete('/me/push-tokens', auth, async (req, res) => {
    const { token } = parseBody(req, z.object({ token: z.string().min(1) }));
    await notifications.removeToken(currentUser(req).uid, token);
    res.status(204).end();
  });

  r.get('/users/search', auth, async (req, res) => {
    const { q, limit } = parseQuery(req, z.object({ q: z.string().trim().min(1).max(40), limit: z.coerce.number().int().min(1).max(50).default(20) }));
    res.json({ items: await users.search(q, limit) });
  });

  r.get('/users/:uid', auth, async (req, res) => {
    const { uid } = parseParams(req, uidParam);
    res.json({ user: await users.publicProfile(uid, currentUser(req).uid) });
  });

  r.post('/users/:uid/follow', auth, async (req, res) => {
    const { uid } = parseParams(req, uidParam);
    res.json(await follows.follow(currentUser(req).uid, uid));
  });

  r.delete('/users/:uid/follow', auth, async (req, res) => {
    const { uid } = parseParams(req, uidParam);
    res.json(await follows.unfollow(currentUser(req).uid, uid));
  });

  r.get('/users/:uid/followers', auth, async (req, res) => {
    const { uid } = parseParams(req, uidParam);
    const { cursor, limit } = parseQuery(req, cursorQuery);
    res.json(await follows.list(uid, 'followers', cursor, limit));
  });

  r.get('/users/:uid/following', auth, async (req, res) => {
    const { uid } = parseParams(req, uidParam);
    const { cursor, limit } = parseQuery(req, cursorQuery);
    res.json(await follows.list(uid, 'following', cursor, limit));
  });

  r.post('/users/:uid/block', auth, async (req, res) => {
    const { uid } = parseParams(req, uidParam);
    await users.block(currentUser(req).uid, uid);
    res.status(204).end();
  });

  r.delete('/users/:uid/block', auth, async (req, res) => {
    const { uid } = parseParams(req, uidParam);
    await users.unblock(currentUser(req).uid, uid);
    res.status(204).end();
  });

  r.get('/users/:uid/contributors', auth, async (req, res) => {
    const { uid } = parseParams(req, uidParam);
    const { period } = parseQuery(req, z.object({ period: z.enum(['day', 'week', 'month', 'all']).default('week') }));
    const days = { day: 1, week: 7, month: 30, all: null }[period];
    const since = days ? new Date(ctx.clock.now().getTime() - days * 86_400_000) : null;
    res.json({ items: await gifts.topContributors(uid, since) });
  });

  r.get('/users/:uid/live-history', auth, async (req, res) => {
    const { uid } = parseParams(req, uidParam);
    if (uid !== currentUser(req).uid && !currentUser(req).adminRole) throw unauthorized('You can only view your own history');
    const { page, pageSize } = parseQuery(req, pageQuery);
    res.json(await ctx.services.live.history(uid, page, pageSize));
  });

  r.post('/reports', auth, async (req, res) => {
    const input = parseBody(req, reportInput);
    const report = await moderation.report(currentUser(req).uid, input);
    res.status(201).json({ id: String(report._id) });
  });

  return r;
}
