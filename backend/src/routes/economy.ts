import { Router } from 'express';
import { z } from 'zod';
import { CURRENCIES, COSMETIC_TYPES, GAME_KEYS } from '@bigboss/shared';
import type { Ctx } from '../context.js';
import { requireAuth } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/http.js';
import { currentUser, cursorQuery, idempotencyKey, objectIdString, parseBody, parseParams, parseQuery, toObjectId } from '../lib/http.js';
import { forbidden, notFound } from '../lib/errors.js';
import { sendGiftInput } from '../modules/gifts/gifts.service.js';
import { iapVerifyInput } from '../modules/wallet/iap.service.js';
import { withdrawalInput } from '../modules/withdrawals/withdrawals.service.js';
import { placeBetInput } from '../modules/games/games.service.js';

const idParams = z.object({ id: objectIdString });
const gameParam = z.object({ key: z.enum(GAME_KEYS) });

/** Gifts, wallet, store (VIP/cosmetics), agents, agencies, withdrawals and games. */
export function economyRoutes(ctx: Ctx): Router {
  const r = Router();
  // Scope auth to this router's own prefixes so unknown /v1 paths still fall through to 404.
  r.use(['/gifts', '/wallet', '/agent', '/store', '/agencies', '/withdrawals', '/games'], requireAuth(ctx));
  const { gifts, wallet, iap, store, agencies, withdrawals, games, users } = ctx.services;
  // Money-moving endpoints get a tighter per-user budget on top of the global limiter.
  const moneyLimit = createRateLimiter(ctx.redis, { windowMs: 60_000, limit: 120, prefix: 'money', byUser: true });

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
    res.json({ items: items.map((p) => ({ id: String(p._id), sku: p.sku, diamonds: p.diamonds, bonusDiamonds: p.bonusDiamonds, priceUsd: p.priceUsd })) });
  });

  r.post('/wallet/iap/verify', moneyLimit, async (req, res) => {
    res.json(await iap.verifyAndCredit(currentUser(req).uid, parseBody(req, iapVerifyInput)));
  });

  // ── Agents (resellers) ──────────────────────────────────────────────────────
  r.post('/agent/recharge', moneyLimit, async (req, res) => {
    const me = currentUser(req);
    if (!me.user.isAgent) throw forbidden('Only agents can recharge users');
    const { target, diamonds } = parseBody(req, z.object({ target: z.string().min(1).max(128), diamonds: z.number().int().positive().max(100_000_000) }));
    // Agents type the public short id; accept a uid too.
    const user = /^\d{4,12}$/.test(target)
      ? await ctx.col.users.findOne({ shortId: target, status: 'active' }, { projection: { _id: 1 } })
      : await ctx.col.users.findOne({ _id: target, status: 'active' }, { projection: { _id: 1 } });
    if (!user) throw notFound('User');
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
    const { shortId } = z.object({ shortId: z.string().regex(/^\d{4,12}$/) }).parse(req.params);
    const user = await ctx.col.users.findOne({ shortId, status: 'active' }, { projection: { _id: 1 } });
    if (!user) throw notFound('User');
    res.json({ user: (await users.briefs([user._id])).get(user._id) });
  });

  r.get('/agent/history', async (req, res) => {
    if (!currentUser(req).user.isAgent) throw forbidden();
    const q = parseQuery(req, z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) }));
    res.json(await wallet.listRecharges({ agentId: currentUser(req).uid }, q.page, q.pageSize));
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
    res.json(await store.purchaseCosmetic(currentUser(req).uid, toObjectId(id), idempotencyKey(req)));
  });

  r.get('/store/mine', async (req, res) => {
    res.json({ items: await store.owned(currentUser(req).uid) });
  });

  r.post('/store/equip', async (req, res) => {
    const { itemId, type } = parseBody(req, z.object({ itemId: objectIdString.nullable(), type: z.enum(['frame', 'entry_animation']) }));
    await store.equip(currentUser(req).uid, itemId ? toObjectId(itemId) : null, type);
    res.status(204).end();
  });

  // ── Host agencies ────────────────────────────────────────────────────────────
  r.get('/agencies', async (req, res) => {
    const q = parseQuery(req, z.object({ q: z.string().trim().max(40).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(20) }));
    const result = await agencies.list({ q: q.q, status: 'active' }, q.page, q.pageSize);
    res.json({ ...result, items: result.items.map((a) => ({ id: String(a._id), name: a.name, logoUrl: a.logoUrl, memberCount: a.memberCount })) });
  });

  r.get('/agencies/membership', async (req, res) => {
    const member = await ctx.col.agencyMembers.findOne({ userId: currentUser(req).uid });
    const agency = member ? await agencies.get(member.agencyId) : null;
    res.json({ membership: member && agency ? { agencyId: String(agency._id), name: agency.name, joinedAt: member.joinedAt } : null });
  });

  r.post('/agencies/:id/join', async (req, res) => {
    const { id } = parseParams(req, idParams);
    await agencies.requestToJoin(currentUser(req).uid, toObjectId(id));
    res.status(202).end();
  });

  r.post('/agencies/leave', async (req, res) => {
    await agencies.removeMember(currentUser(req).uid);
    res.status(204).end();
  });

  r.get('/agencies/mine', async (req, res) => {
    res.json(await agencies.ownerDashboard(currentUser(req).uid));
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

  r.delete('/agencies/mine/members/:uid', async (req, res) => {
    const { uid } = z.object({ uid: z.string().min(1).max(128) }).parse(req.params);
    const agency = await agencies.byOwner(currentUser(req).uid);
    const member = await ctx.col.agencyMembers.findOne({ userId: uid });
    if (!agency || !member || String(member.agencyId) !== String(agency._id)) throw notFound('Member');
    await agencies.removeMember(uid);
    res.status(204).end();
  });

  // ── Withdrawals ──────────────────────────────────────────────────────────────
  r.post('/withdrawals', moneyLimit, async (req, res) => {
    const w = await withdrawals.request(currentUser(req).uid, idempotencyKey(req), parseBody(req, withdrawalInput));
    res.status(201).json({ id: String(w._id), status: w.status, beans: w.beans, amountUsd: w.amountUsd });
  });

  r.get('/withdrawals', async (req, res) => {
    res.json({ items: await withdrawals.mine(currentUser(req).uid) });
  });

  // ── Games ────────────────────────────────────────────────────────────────
  r.get('/games', async (_req, res) => {
    const items = await games.registry();
    res.json({ items: items.map((g) => ({ key: g._id, name: g.name, url: g.url, iconUrl: g.iconUrl })) });
  });

  r.get('/games/:key/state', async (req, res) => {
    const { key } = parseParams(req, gameParam);
    res.json(await games.state(key, currentUser(req).uid));
  });

  r.post('/games/:key/bets', moneyLimit, async (req, res) => {
    const { key } = parseParams(req, gameParam);
    res.json(await games.placeBet(currentUser(req).uid, key, idempotencyKey(req), parseBody(req, placeBetInput)));
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
