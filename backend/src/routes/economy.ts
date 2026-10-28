import { Router } from 'express';
import { z } from 'zod';
import {
  AGENCY_ROLES,
  CURRENCIES,
  COSMETIC_TYPES,
  GAME_KEYS,
  SHORT_ID_PATTERN,
} from '@bigboss/shared';
import type { Ctx } from '../context.js';
import { requireAuth } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/http.js';
import {
  currentUser,
  cursorQuery,
  idempotencyKey,
  objectIdString,
  parseBody,
  parseParams,
  parseQuery,
  toObjectId,
} from '../lib/http.js';
import { forbidden, notFound } from '../lib/errors.js';
import { sendGiftInput } from '../modules/gifts/gifts.service.js';
import { iapVerifyInput } from '../modules/wallet/iap.service.js';
import { withdrawalInput } from '../modules/withdrawals/withdrawals.service.js';
import { placeBetInput } from '../modules/games/games.service.js';
import { agencyProfileInput, toAgencySummary } from '../modules/agencies/agencies.service.js';

const idParams = z.object({ id: objectIdString });
const gameParam = z.object({ key: z.enum(GAME_KEYS) });

/** Gifts, wallet, store (VIP/cosmetics), agents, agencies, withdrawals and games. */
export function economyRoutes(ctx: Ctx): Router {
  const r = Router();
  // Scope auth to this router's own prefixes so unknown /v1 paths still fall through to 404.
  r.use(
    ['/gifts', '/wallet', '/agent', '/store', '/agencies', '/withdrawals', '/games'],
    requireAuth(ctx),
  );
  const { gifts, wallet, iap, store, agencies, withdrawals, games, users } = ctx.services;
  // Money-moving endpoints get a tighter per-user budget on top of the global limiter.
  const moneyLimit = createRateLimiter(ctx.redis, {
    windowMs: 60_000,
    limit: 120,
    prefix: 'money',
    byUser: true,
  });

  // ── Gifts ─────────────────────────────────────────────────────────────────
  r.get('/gifts', async (_req, res) => {
    res.set('Cache-Control', 'private, max-age=60');
    res.json({ items: await gifts.catalog() });
  });

  r.post('/gifts/send', moneyLimit, async (req, res) => {
    const input = parseBody(req, sendGiftInput);
    res.json(await gifts.send(currentUser(req).uid, idempotencyKey(req), input));
  });

  // ── Wallet ────────────────────────────────────────────────────────────────
  r.get('/wallet', async (req, res) => {
    res.json(await wallet.balances(currentUser(req).uid));
  });

  r.get('/wallet/ledger', async (req, res) => {
    const q = parseQuery(req, cursorQuery.extend({ currency: z.enum(CURRENCIES).optional() }));
    res.json(await wallet.ledger(currentUser(req).uid, q));
  });

  r.get('/wallet/packages', async (_req, res) => {
    const items = await iap.packages();
    res.json({
      items: items.map((p) => ({
        id: String(p._id),
        sku: p.sku,
        diamonds: p.diamonds,
        bonusDiamonds: p.bonusDiamonds,
        priceUsd: p.priceUsd,
      })),
    });
  });

  r.post('/wallet/iap/verify', moneyLimit, async (req, res) => {
    res.json(await iap.verifyAndCredit(currentUser(req).uid, parseBody(req, iapVerifyInput)));
  });

  // ── Agents (resellers) ──────────────────────────────────────────────────────
  r.post('/agent/recharge', moneyLimit, async (req, res) => {
    const me = currentUser(req);
    if (!me.user.isAgent) throw forbidden('Only agents can recharge users');
    const { target, diamonds } = parseBody(
      req,
      z.object({
        target: z.string().min(1).max(128),
        diamonds: z.number().int().positive().max(100_000_000),
      }),
    );
    // Agents type the public short id; accept a uid too.
    const user = await users.resolve(target);
    const { recharge, replayed } = await wallet.recharge({
      uid: user._id,
      diamonds,
      source: 'agent',
      agentId: me.uid,
      idempotencyKey: `agent:${me.uid}:${idempotencyKey(req)}`,
    });
    const balances = await wallet.balances(me.uid);
    res.json({ rechargeId: String(recharge._id), replayed, agentStock: balances.agentStock });
  });

  r.get('/agent/lookup/:shortId', async (req, res) => {
    if (!currentUser(req).user.isAgent) throw forbidden();
    const { shortId } = parseParams(req, z.object({ shortId: z.string().regex(SHORT_ID_PATTERN) }));
    const user = await ctx.col.users.findOne(
      { shortId, status: 'active' },
      { projection: { _id: 1 } },
    );
    if (!user) throw notFound('User');
    res.json({ user: (await users.briefs([user._id])).get(user._id) });
  });

  r.get('/agent/history', async (req, res) => {
    const me = currentUser(req);
    if (!me.user.isAgent) throw forbidden();
    const q = parseQuery(
      req,
      cursorQuery.extend({ q: z.string().trim().regex(SHORT_ID_PATTERN).optional() }),
    );
    let targetUid: string | undefined;
    if (q.q) {
      const target = await ctx.col.users.findOne({ shortId: q.q }, { projection: { _id: 1 } });
      if (!target) return void res.json({ items: [], nextCursor: null });
      targetUid = target._id;
    }
    res.json(await wallet.agentHistory(me.uid, { targetUid, cursor: q.cursor, limit: q.limit }));
  });

  r.get('/agent/summary', async (req, res) => {
    const me = currentUser(req);
    if (!me.user.isAgent) throw forbidden();
    res.json(await wallet.agentSummary(me.uid));
  });

  // ── Store ─────────────────────────────────────────────────────────────────
  r.get('/store/vip', async (_req, res) => {
    res.json({ items: await store.vipPackages() });
  });

  r.post('/store/vip/:id/purchase', moneyLimit, async (req, res) => {
    const { id } = parseParams(req, idParams);
    res.json(await store.purchaseVip(currentUser(req).uid, toObjectId(id), idempotencyKey(req)));
  });

  r.get('/store/items', async (req, res) => {
    const { type } = parseQuery(req, z.object({ type: z.enum(COSMETIC_TYPES).optional() }));
    res.json({ items: await store.cosmetics(type) });
  });

  r.post('/store/items/:id/purchase', moneyLimit, async (req, res) => {
    const { id } = parseParams(req, idParams);
    res.json(
      await store.purchaseCosmetic(currentUser(req).uid, toObjectId(id), idempotencyKey(req)),
    );
  });

  r.get('/store/mine', async (req, res) => {
    res.json({ items: await store.owned(currentUser(req).uid) });
  });

  r.post('/store/equip', async (req, res) => {
    const { itemId, type } = parseBody(
      req,
      z.object({ itemId: objectIdString.nullable(), type: z.enum(['frame', 'entry_animation']) }),
    );
    await store.equip(currentUser(req).uid, itemId ? toObjectId(itemId) : null, type);
    res.status(204).end();
  });

  // ── Host agencies ────────────────────────────────────────────────────────────
  const hostParam = z.object({ uid: z.string().min(1).max(128) });
  const daysQuery = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) });

  r.get('/agencies', async (req, res) => {
    const q = parseQuery(
      req,
      z.object({
        q: z.string().trim().max(40).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(50).default(20),
      }),
    );
    const result = await agencies.list({ q: q.q, status: 'active' }, q.page, q.pageSize);
    res.json({ ...result, items: result.items.map(toAgencySummary) });
  });

  /** Home-screen "Top agencies" slider: this month's ranking. */
  r.get('/agencies/top', async (req, res) => {
    const { limit } = parseQuery(
      req,
      z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }),
    );
    res.set('Cache-Control', 'private, max-age=15');
    res.json({ items: await agencies.top(limit) });
  });

  r.get('/agencies/membership', async (req, res) => {
    res.json({ membership: await agencies.membership(currentUser(req).uid) });
  });

  r.get('/agencies/invitations', async (req, res) => {
    res.json({ items: await agencies.myInvitations(currentUser(req).uid) });
  });

  r.post('/agencies/invitations/:id', async (req, res) => {
    const { id } = parseParams(req, idParams);
    const { accept } = parseBody(req, z.object({ accept: z.boolean() }));
    await agencies.respondInvitation(currentUser(req).uid, toObjectId(id), accept);
    res.status(204).end();
  });

  r.post('/agencies/leave', async (req, res) => {
    await agencies.leave(currentUser(req).uid);
    res.status(204).end();
  });

  // Managing an agency: the owner, or an agency admin (finer rules live in the service).
  r.get('/agencies/mine', async (req, res) => {
    res.json(await agencies.dashboard(currentUser(req).uid));
  });

  r.patch('/agencies/mine', async (req, res) => {
    const agency = await agencies.updateProfile(
      currentUser(req).uid,
      parseBody(req, agencyProfileInput),
    );
    res.json({ agency: toAgencySummary(agency) });
  });

  r.get('/agencies/mine/members', async (req, res) => {
    res.json({ items: await agencies.managedMembers(currentUser(req).uid) });
  });

  r.delete('/agencies/mine/members/:uid', async (req, res) => {
    const { uid } = parseParams(req, hostParam);
    await agencies.removeByManager(currentUser(req).uid, uid);
    res.status(204).end();
  });

  r.post('/agencies/mine/members/:uid/role', async (req, res) => {
    const { uid } = parseParams(req, hostParam);
    const { role } = parseBody(req, z.object({ role: z.enum(AGENCY_ROLES) }));
    await agencies.setRole(currentUser(req).uid, uid, role);
    res.status(204).end();
  });

  r.post('/agencies/mine/members/:uid/lock', async (req, res) => {
    const { uid } = parseParams(req, hostParam);
    await agencies.lock(currentUser(req).uid, uid);
    res.status(204).end();
  });

  r.put('/agencies/mine/members/:uid/target', async (req, res) => {
    const { uid } = parseParams(req, hostParam);
    const { minutes } = parseBody(
      req,
      z.object({ minutes: z.number().int().min(1).max(1440).nullable() }),
    );
    await agencies.setDailyTarget(currentUser(req).uid, uid, minutes);
    res.status(204).end();
  });

  r.get('/agencies/mine/members/:uid/analytics', async (req, res) => {
    const { uid } = parseParams(req, hostParam);
    const { days } = parseQuery(req, daysQuery);
    res.json(await agencies.hostAnalytics(currentUser(req).uid, uid, days));
  });

  r.get('/agencies/mine/members/:uid/gifts', async (req, res) => {
    const { uid } = parseParams(req, hostParam);
    res.json(await agencies.hostGifts(currentUser(req).uid, uid, parseQuery(req, cursorQuery)));
  });

  r.get('/agencies/mine/members/:uid/sessions', async (req, res) => {
    const { uid } = parseParams(req, hostParam);
    res.json(await agencies.hostSessions(currentUser(req).uid, uid, parseQuery(req, cursorQuery)));
  });

  r.get('/agencies/mine/requests', async (req, res) => {
    res.json({ items: await agencies.pendingRequests(currentUser(req).uid) });
  });

  r.post('/agencies/mine/requests/:id', async (req, res) => {
    const { id } = parseParams(req, idParams);
    const { approve } = parseBody(req, z.object({ approve: z.boolean() }));
    await agencies.decideRequest(currentUser(req).uid, toObjectId(id), approve);
    res.status(204).end();
  });

  r.get('/agencies/mine/invitations', async (req, res) => {
    res.json({ items: await agencies.agencyInvitations(currentUser(req).uid) });
  });

  r.post('/agencies/mine/invitations', async (req, res) => {
    const { target } = parseBody(req, z.object({ target: z.string().trim().min(1).max(128) }));
    res.status(201).json({ invitation: await agencies.invite(currentUser(req).uid, target) });
  });

  r.delete('/agencies/mine/invitations/:id', async (req, res) => {
    const { id } = parseParams(req, idParams);
    await agencies.cancelInvitation(currentUser(req).uid, toObjectId(id));
    res.status(204).end();
  });

  r.get('/agencies/mine/analytics', async (req, res) => {
    const { days } = parseQuery(req, daysQuery);
    res.json(await agencies.analytics(currentUser(req).uid, days));
  });

  r.get('/agencies/mine/leaderboard', async (req, res) => {
    const { periodKey } = parseQuery(
      req,
      z.object({
        periodKey: z
          .string()
          .regex(/^\d{4}-\d{2}$/)
          .optional(),
      }),
    );
    res.json(await agencies.leaderboard(currentUser(req).uid, periodKey));
  });

  r.get('/agencies/mine/audit', async (req, res) => {
    res.json(await agencies.managedAuditLog(currentUser(req).uid, parseQuery(req, cursorQuery)));
  });

  // Declared after the literal /agencies/* paths so "top", "mine" etc. never match :id.
  r.post('/agencies/:id/join', async (req, res) => {
    const { id } = parseParams(req, idParams);
    await agencies.requestToJoin(currentUser(req).uid, toObjectId(id));
    res.status(202).end();
  });

  // ── Withdrawals ──────────────────────────────────────────────────────────────
  r.post('/withdrawals', moneyLimit, async (req, res) => {
    const w = await withdrawals.request(
      currentUser(req).uid,
      idempotencyKey(req),
      parseBody(req, withdrawalInput),
    );
    res
      .status(201)
      .json({ id: String(w._id), status: w.status, beans: w.beans, amountUsd: w.amountUsd });
  });

  r.get('/withdrawals', async (req, res) => {
    res.json({ items: await withdrawals.mine(currentUser(req).uid) });
  });

  // ── Games ────────────────────────────────────────────────────────────────
  r.get('/games', async (_req, res) => {
    const items = await games.registry();
    res.json({
      items: items.map((g) => ({ key: g._id, name: g.name, url: g.url, iconUrl: g.iconUrl })),
    });
  });

  r.get('/games/:key/state', async (req, res) => {
    const { key } = parseParams(req, gameParam);
    res.json(await games.state(key, currentUser(req).uid));
  });

  r.post('/games/:key/bets', moneyLimit, async (req, res) => {
    const { key } = parseParams(req, gameParam);
    res.json(
      await games.placeBet(
        currentUser(req).uid,
        key,
        idempotencyKey(req),
        parseBody(req, placeBetInput),
      ),
    );
  });

  r.get('/games/:key/my-bets', async (req, res) => {
    const { key } = parseParams(req, gameParam);
    res.json({ items: await games.myBets(currentUser(req).uid, key, 50) });
  });

  r.get('/games/rounds/:id/verify', async (req, res) => {
    const { id } = parseParams(req, idParams);
    res.json(await games.verify(toObjectId(id)));
  });

  return r;
}
