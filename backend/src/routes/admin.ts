import { Router, type Request } from 'express';
import type { Filter } from 'mongodb';
import { z } from 'zod';
import {
  ADMIN_ROLES,
  CURRENCIES,
  GAME_KEYS,
  REPORT_STATUSES,
  REPORT_TARGETS,
  ROOM_STATUSES,
  ROOM_TYPES,
  USER_STATUSES,
  WITHDRAWAL_STATUSES,
} from '@bigboss/shared';
import type { Ctx } from '../context.js';
import type { LiveRoomDoc, UserDoc } from '../db/schema.js';
import { requireAuth } from '../middleware/auth.js';
import { permissionsFor, requireAnyAdmin, requirePermission as can } from '../middleware/rbac.js';
import {
  currentUser,
  idempotencyKey,
  objectIdString,
  pageQuery,
  parseBody,
  parseParams,
  parseQuery,
  toObjectId,
  uidParam,
} from '../lib/http.js';
import { badRequest, notFound } from '../lib/errors.js';
import { addDays } from '../lib/time.js';
import { CONFIG_SCHEMAS, type ConfigKey } from '../modules/config/config.service.js';
import { giftInput } from '../modules/gifts/gifts.service.js';
import { levelConfigInput } from '../modules/levels/levels.service.js';
import { cosmeticInput, vipPackageInput } from '../modules/store/store.service.js';
import { agencyInput } from '../modules/agencies/agencies.service.js';
import { announcementInput } from '../modules/notifications/notifications.service.js';
import { bannerInput } from '../modules/banners/banners.service.js';
import { gameConfigInput, gameMetaInput } from '../modules/games/games.service.js';
import { rechargePackageInput } from '../modules/wallet/iap.service.js';
import { toLiveRoom } from '../modules/live/live.presenter.js';

const idParams = z.object({ id: objectIdString });
const gameParam = z.object({ key: z.enum(GAME_KEYS) });
const dateRange = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() });
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Admin API for the dashboard. Every route is permission-gated; every write is audited. */
export function adminRoutes(ctx: Ctx): Router {
  const r = Router();
  r.use(requireAuth(ctx), requireAnyAdmin());
  const s = ctx.services;
  const audit = (
    req: Request,
    action: string,
    type: string,
    id: string | null,
    payload?: unknown,
  ) => s.audit.record(req, action, { type, id }, payload);
  const oid = (req: Request) => toObjectId(parseParams(req, idParams).id);

  r.get('/me', (req, res) => {
    const me = currentUser(req);
    res.json({
      uid: me.uid,
      displayName: me.user.displayName,
      avatarUrl: me.user.avatarUrl,
      role: me.adminRole,
      permissions: permissionsFor(me.adminRole),
    });
  });

  // ── Dashboard ────────────────────────────────────────────────────────────────
  r.get('/stats/overview', can('dashboard.view'), async (_req, res) => {
    res.json(await s.stats.overview());
  });

  r.get('/stats/series', can('dashboard.view'), async (req, res) => {
    const { days } = parseQuery(
      req,
      z.object({ days: z.coerce.number().int().min(1).max(180).default(30) }),
    );
    res.json({ items: await s.stats.series(days) });
  });

  // ── Users ──────────────────────────────────────────────────────────────────
  r.get('/users', can('users.read'), async (req, res) => {
    const q = parseQuery(
      req,
      pageQuery.extend({
        q: z.string().trim().max(100).optional(),
        status: z.enum(USER_STATUSES).optional(),
        agent: z.enum(['true', 'false']).optional(),
        sort: z.enum(['new', 'level', 'diamonds', 'beans']).default('new'),
      }),
    );
    const filter: Filter<UserDoc> = {};
    if (q.status) filter.status = q.status;
    if (q.agent) filter.isAgent = q.agent === 'true';
    if (q.q) {
      const term = q.q.trim();
      filter.$or = [
        { _id: term },
        { shortId: term },
        { displayNameLower: { $regex: `^${escape(term.toLowerCase())}` } },
        { email: term.toLowerCase() },
        { phone: term },
      ];
    }
    const sort = {
      new: { createdAt: -1 },
      level: { 'level.level': -1 },
      diamonds: { 'wallet.diamonds': -1 },
      beans: { 'wallet.beans': -1 },
    }[q.sort] as Record<string, 1 | -1>;
    const [items, total] = await Promise.all([
      ctx.col.users
        .find(filter)
        .sort(sort)
        .skip((q.page - 1) * q.pageSize)
        .limit(q.pageSize)
        .toArray(),
      ctx.col.users.countDocuments(filter),
    ]);
    res.json({ items, total, page: q.page, pageSize: q.pageSize });
  });

  r.get('/users/:uid', can('users.read'), async (req, res) => {
    const { uid } = parseParams(req, uidParam);
    const user = await ctx.col.users.findOne({ _id: uid });
    if (!user) throw notFound('User');
    const [devices, agencyMember, progress, liveRoom] = await Promise.all([
      s.moderation.devicesForUser(uid),
      ctx.col.agencyMembers.findOne({ userId: uid }),
      s.levels.progress(user),
      user.liveRoomId ? ctx.col.liveRooms.findOne({ _id: user.liveRoomId }) : null,
    ]);
    res.json({ user, devices, agencyMember, levelProgress: progress, liveRoom });
  });

  r.get('/users/:uid/ledger', can('wallet.read'), async (req, res) => {
    const { uid } = parseParams(req, uidParam);
    const q = parseQuery(
      req,
      z.object({
        cursor: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        currency: z.enum(CURRENCIES).optional(),
      }),
    );
    res.json(await s.wallet.ledger(uid, q));
  });

  r.patch('/users/:uid', can('users.edit'), async (req, res) => {
    const { uid } = parseParams(req, uidParam);
    const patch = parseBody(
      req,
      z.object({
        displayName: z.string().trim().min(2).max(30).optional(),
        bio: z.string().max(160).optional(),
        avatarUrl: z.url().nullable().optional(),
      }),
    );
    const user = await s.users.updateProfile(uid, patch);
    await audit(req, 'user.edit', 'user', uid, patch);
    res.json({ user });
  });

  r.post('/users/:uid/ban', can('users.moderate'), async (req, res) => {
    const { uid } = parseParams(req, uidParam);
    const { reason, days } = parseBody(
      req,
      z.object({
        reason: z.string().trim().min(3).max(300),
        days: z.number().int().min(1).max(3650).nullable(),
      }),
    );
    await s.users.ban(uid, {
      reason,
      until: days ? addDays(ctx.clock.now(), days) : null,
      by: currentUser(req).uid,
    });
    await audit(req, 'user.ban', 'user', uid, { reason, days });
    res.status(204).end();
  });

  r.post('/users/:uid/unban', can('users.moderate'), async (req, res) => {
    const { uid } = parseParams(req, uidParam);
    await s.users.unban(uid);
    await audit(req, 'user.unban', 'user', uid);
    res.status(204).end();
  });

  r.post('/users/:uid/short-id', can('users.edit'), async (req, res) => {
    const { uid } = parseParams(req, uidParam);
    const { shortId } = parseBody(req, z.object({ shortId: z.string().trim() }));
    await s.users.setShortId(uid, shortId);
    await audit(req, 'user.short_id', 'user', uid, { shortId });
    res.status(204).end();
  });

  r.post('/users/:uid/recharge', can('wallet.adjust'), async (req, res) => {
    const { uid } = parseParams(req, uidParam);
    const { diamonds, note } = parseBody(
      req,
      z.object({
        diamonds: z.number().int().positive().max(1_000_000_000),
        note: z.string().trim().max(300).default(''),
      }),
    );
    const result = await s.wallet.recharge({
      uid,
      diamonds,
      source: 'admin',
      adminId: currentUser(req).uid,
      note,
      idempotencyKey: `admin:${currentUser(req).uid}:${idempotencyKey(req)}`,
    });
    if (!result.replayed) await audit(req, 'wallet.recharge', 'user', uid, { diamonds, note });
    res.json({ rechargeId: String(result.recharge._id), replayed: result.replayed });
  });

  r.post('/users/:uid/wallet/adjust', can('wallet.adjust'), async (req, res) => {
    const { uid } = parseParams(req, uidParam);
    const input = parseBody(
      req,
      z.object({
        currency: z.enum(CURRENCIES),
        delta: z.number().int(),
        note: z.string().trim().min(3).max(300),
      }),
    );
    const balance = await s.wallet.adjust({ uid, ...input, adminId: currentUser(req).uid });
    await audit(req, 'wallet.adjust', 'user', uid, input);
    res.json({ balance });
  });

  r.post('/users/:uid/agent', can('agents.manage'), async (req, res) => {
    const { uid } = parseParams(req, uidParam);
    const { isAgent } = parseBody(req, z.object({ isAgent: z.boolean() }));
    await s.wallet.setAgent(uid, isAgent);
    await audit(req, 'user.agent', 'user', uid, { isAgent });
    res.status(204).end();
  });

  r.post('/users/:uid/vip', can('users.edit'), async (req, res) => {
    const { uid } = parseParams(req, uidParam);
    const { tier, days } = parseBody(
      req,
      z.object({ tier: z.number().int().min(0).max(10), days: z.number().int().min(1).max(3650) }),
    );
    const vip =
      tier === 0
        ? { tier: 0, expiresAt: null }
        : { tier, expiresAt: addDays(ctx.clock.now(), days) };
    const r2 = await ctx.col.users.updateOne({ _id: uid }, { $set: { vip } });
    if (!r2.matchedCount) throw notFound('User');
    await audit(req, 'user.vip', 'user', uid, { tier, days });
    res.status(204).end();
  });

  r.post('/users/:uid/level/recalculate', can('users.edit'), async (req, res) => {
    const { uid } = parseParams(req, uidParam);
    res.json(await s.levels.recalculate(uid));
  });

  // ── Admin team (superadmin only) ─────────────────────────────────────────────────
  r.get('/admins', can('admins.manage'), async (_req, res) => {
    res.json({
      items: await ctx.col.users
        .find({ adminRole: { $type: 'string' } })
        .project({
          displayName: 1,
          shortId: 1,
          email: 1,
          adminRole: 1,
          avatarUrl: 1,
          lastSeenAt: 1,
        })
        .toArray(),
    });
  });

  r.post('/admins', can('admins.manage'), async (req, res) => {
    const { uid, role } = parseBody(
      req,
      z.object({ uid: z.string().min(1).max(128), role: z.enum(ADMIN_ROLES).nullable() }),
    );
    if (uid === currentUser(req).uid) throw badRequest('You cannot change your own role');
    await s.users.get(uid);
    await ctx.auth.setAdminRole(uid, role);
    await ctx.col.users.updateOne({ _id: uid }, { $set: { adminRole: role } });
    await audit(req, 'admin.role', 'user', uid, { role });
    res.status(204).end();
  });

  // ── Live ───────────────────────────────────────────────────────────────────
  r.get('/live', can('live.read'), async (req, res) => {
    const q = parseQuery(
      req,
      pageQuery.merge(dateRange).extend({
        status: z.enum(ROOM_STATUSES).default('live'),
        type: z.enum(ROOM_TYPES).optional(),
        hostId: z.string().optional(),
      }),
    );
    const filter: Filter<LiveRoomDoc> = { status: q.status };
    if (q.type) filter.type = q.type;
    if (q.hostId) filter.hostId = q.hostId;
    if (q.from || q.to)
      filter.startedAt = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lt: q.to } : {}) };
    const [rooms, total] = await Promise.all([
      ctx.col.liveRooms
        .find(filter)
        .sort(q.status === 'live' ? { viewerCount: -1 } : { startedAt: -1 })
        .skip((q.page - 1) * q.pageSize)
        .limit(q.pageSize)
        .toArray(),
      ctx.col.liveRooms.countDocuments(filter),
    ]);
    const briefs = await s.users.briefs(rooms.map((x) => x.hostId));
    res.json({
      items: rooms.map((x) => ({
        ...toLiveRoom(x, briefs.get(x.hostId)),
        endReason: x.endReason,
        giftCount: x.giftCount,
        durationSec: Math.round(
          ((x.endedAt ?? ctx.clock.now()).getTime() - x.startedAt.getTime()) / 1000,
        ),
      })),
      total,
      page: q.page,
      pageSize: q.pageSize,
    });
  });

  r.get('/live/:id', can('live.read'), async (req, res) => {
    const id = oid(req);
    const [room, viewers, pk] = await Promise.all([
      s.live.detail(id),
      s.live.viewers(id, 200),
      s.pk.forRoom(id),
    ]);
    res.json({ room, viewers, pk });
  });

  r.post('/live/:id/end', can('live.moderate'), async (req, res) => {
    const id = oid(req);
    const ended = await s.live.end(id, 'admin', currentUser(req).uid);
    if (!ended) throw badRequest('Room is not live');
    await audit(req, 'live.end', 'room', String(id));
    res.status(204).end();
  });

  r.get('/pk', can('live.read'), async (req, res) => {
    const q = parseQuery(
      req,
      pageQuery.extend({
        status: z
          .enum(['pending', 'active', 'ended', 'rejected', 'cancelled', 'expired'])
          .optional(),
        uid: z.string().optional(),
      }),
    );
    res.json(await s.pk.list(q, q.page, q.pageSize));
  });

  r.post('/pk/:id/end', can('live.moderate'), async (req, res) => {
    await s.pk.end(oid(req), 'admin');
    await audit(req, 'pk.end', 'pk', parseParams(req, idParams).id);
    res.status(204).end();
  });

  // ── Gifts & economy catalog ─────────────────────────────────────────────────────
  r.get('/gifts', can('catalog.manage'), async (_req, res) => {
    res.json({ items: await s.gifts.listAll() });
  });

  r.post('/gifts', can('catalog.manage'), async (req, res) => {
    const gift = await s.gifts.create(parseBody(req, giftInput));
    await audit(req, 'gift.create', 'gift', gift.id, gift);
    res.status(201).json({ gift });
  });

  r.patch('/gifts/:id', can('catalog.manage'), async (req, res) => {
    const patch = parseBody(req, giftInput.partial());
    const gift = await s.gifts.update(oid(req), patch);
    await audit(req, 'gift.update', 'gift', gift.id, patch);
    res.json({ gift });
  });

  r.get('/gift-transactions', can('wallet.read'), async (req, res) => {
    const q = parseQuery(
      req,
      pageQuery.merge(dateRange).extend({
        senderId: z.string().optional(),
        receiverId: z.string().optional(),
        roomId: objectIdString.optional(),
      }),
    );
    res.json(
      await s.gifts.history(
        { ...q, roomId: q.roomId ? toObjectId(q.roomId) : undefined },
        q.page,
        q.pageSize,
      ),
    );
  });

  r.get('/recharges', can('wallet.read'), async (req, res) => {
    const q = parseQuery(
      req,
      pageQuery.merge(dateRange).extend({
        uid: z.string().optional(),
        agentId: z.string().optional(),
        source: z.enum(['agent', 'admin', 'iap']).optional(),
      }),
    );
    res.json(await s.wallet.listRecharges(q, q.page, q.pageSize));
  });

  r.get('/recharge-packages', can('catalog.manage'), async (_req, res) => {
    res.json({ items: await s.iap.packages(true) });
  });

  r.post('/recharge-packages', can('catalog.manage'), async (req, res) => {
    const pkg = await s.iap.upsertPackage(null, parseBody(req, rechargePackageInput));
    await audit(req, 'recharge_package.create', 'recharge_package', String(pkg._id), pkg);
    res.status(201).json({ package: pkg });
  });

  r.put('/recharge-packages/:id', can('catalog.manage'), async (req, res) => {
    const pkg = await s.iap.upsertPackage(oid(req), parseBody(req, rechargePackageInput));
    await audit(req, 'recharge_package.update', 'recharge_package', String(pkg._id), pkg);
    res.json({ package: pkg });
  });

  r.get('/levels', can('catalog.manage'), async (_req, res) => {
    res.json({ items: await s.levels.configs() });
  });

  r.put('/levels', can('catalog.manage'), async (req, res) => {
    const { items } = parseBody(req, z.object({ items: z.array(levelConfigInput).max(100) }));
    const saved = await s.levels.replaceAll(items);
    await audit(req, 'levels.replace', 'levels', null, { count: saved.length });
    res.json({ items: saved, relevelRecommended: true });
  });

  r.post('/levels/relevel', can('catalog.manage'), async (req, res) => {
    const result = await s.levels.relevelAll();
    await audit(req, 'levels.relevel', 'levels', null, result);
    res.json(result);
  });

  r.get('/vip-packages', can('catalog.manage'), async (_req, res) => {
    res.json({ items: await s.store.vipPackages(true) });
  });

  r.post('/vip-packages', can('catalog.manage'), async (req, res) => {
    const pkg = await s.store.upsertVipPackage(null, parseBody(req, vipPackageInput));
    await audit(req, 'vip_package.create', 'vip_package', String(pkg._id), pkg);
    res.status(201).json({ package: pkg });
  });

  r.put('/vip-packages/:id', can('catalog.manage'), async (req, res) => {
    const pkg = await s.store.upsertVipPackage(oid(req), parseBody(req, vipPackageInput));
    await audit(req, 'vip_package.update', 'vip_package', String(pkg._id), pkg);
    res.json({ package: pkg });
  });

  r.get('/cosmetics', can('catalog.manage'), async (_req, res) => {
    res.json({ items: await s.store.cosmetics(undefined, true) });
  });

  r.post('/cosmetics', can('catalog.manage'), async (req, res) => {
    const item = await s.store.upsertCosmetic(null, parseBody(req, cosmeticInput));
    await audit(req, 'cosmetic.create', 'cosmetic', item.id, item);
    res.status(201).json({ item });
  });

  r.put('/cosmetics/:id', can('catalog.manage'), async (req, res) => {
    const item = await s.store.upsertCosmetic(oid(req), parseBody(req, cosmeticInput));
    await audit(req, 'cosmetic.update', 'cosmetic', item.id, item);
    res.json({ item });
  });

  // ── Agencies ────────────────────────────────────────────────────────────────
  r.get('/agencies', can('agencies.manage'), async (req, res) => {
    const q = parseQuery(
      req,
      pageQuery.extend({
        q: z.string().max(40).optional(),
        status: z.enum(['active', 'suspended']).optional(),
      }),
    );
    const result = await s.agencies.list(q, q.page, q.pageSize);
    const owners = await s.users.briefs(result.items.map((a) => a.ownerId));
    res.json({
      ...result,
      items: result.items.map((a) => ({ ...a, owner: owners.get(a.ownerId) ?? null })),
    });
  });

  r.post('/agencies', can('agencies.manage'), async (req, res) => {
    const agency = await s.agencies.create(parseBody(req, agencyInput));
    await audit(req, 'agency.create', 'agency', String(agency._id), agency);
    res.status(201).json({ agency });
  });

  r.patch('/agencies/:id', can('agencies.manage'), async (req, res) => {
    const patch = parseBody(
      req,
      agencyInput
        .omit({ ownerId: true })
        .partial()
        .extend({ status: z.enum(['active', 'suspended']).optional() }),
    );
    const agency = await s.agencies.update(oid(req), patch);
    await audit(req, 'agency.update', 'agency', String(agency._id), patch);
    res.json({ agency });
  });

  r.get('/agencies/:id', can('agencies.manage'), async (req, res) => {
    const id = oid(req);
    const { periodKey } = parseQuery(
      req,
      z.object({
        periodKey: z
          .string()
          .regex(/^\d{4}-\d{2}$/)
          .optional(),
      }),
    );
    const [agency, members, history] = await Promise.all([
      s.agencies.get(id),
      s.agencies.members(id),
      s.agencies.history(id, periodKey),
    ]);
    res.json({
      agency,
      owner: (await s.users.briefs([agency.ownerId])).get(agency.ownerId) ?? null,
      members,
      history,
      currentPeriod: s.agencies.currentPeriodKey(),
    });
  });

  r.post('/agencies/:id/members', can('agencies.manage'), async (req, res) => {
    const { userId } = parseBody(req, z.object({ userId: z.string().min(1).max(128) }));
    await s.agencies.addMember(oid(req), userId);
    await audit(req, 'agency.add_member', 'agency', parseParams(req, idParams).id, { userId });
    res.status(204).end();
  });

  r.delete('/agencies/:id/members/:uid', can('agencies.manage'), async (req, res) => {
    const { uid } = z.object({ uid: z.string().min(1).max(128) }).parse(req.params);
    await s.agencies.removeMember(uid);
    await audit(
      req,
      'agency.remove_member',
      'agency',
      parseParams(req, idParams.extend({ uid: z.string() })).id,
      { uid },
    );
    res.status(204).end();
  });

  r.post('/agencies/monthly-reset', can('agencies.manage'), async (req, res) => {
    const result = await s.agencies.monthlyReset();
    await audit(req, 'agency.monthly_reset', 'agency', null, result);
    res.json(result);
  });

  // ── Withdrawals ───────────────────────────────────────────────────────────────
  r.get('/withdrawals', can('withdrawals.read'), async (req, res) => {
    const q = parseQuery(
      req,
      pageQuery.extend({
        status: z.enum(WITHDRAWAL_STATUSES).optional(),
        uid: z.string().optional(),
      }),
    );
    res.json(await s.withdrawals.list(q, q.page, q.pageSize));
  });

  r.post('/withdrawals/:id/review', can('withdrawals.review'), async (req, res) => {
    const { action, note } = parseBody(
      req,
      z.object({
        action: z.enum(['approve', 'reject', 'mark_paid']),
        note: z.string().trim().max(300).nullable().default(null),
      }),
    );
    const w = await s.withdrawals.review(oid(req), currentUser(req).uid, action, note);
    await audit(req, `withdrawal.${action}`, 'withdrawal', String(w._id), { note });
    res.json({ withdrawal: w });
  });

  // ── Moderation ───────────────────────────────────────────────────────────────
  r.get('/reports', can('reports.read'), async (req, res) => {
    const q = parseQuery(
      req,
      pageQuery.extend({
        status: z.enum(REPORT_STATUSES).optional(),
        targetType: z.enum(REPORT_TARGETS).optional(),
      }),
    );
    const result = await s.moderation.listReports(q, q.page, q.pageSize);
    const briefs = await s.users.briefs(
      result.items.flatMap((x) => [x.reporterId, ...(x.targetType === 'user' ? [x.targetId] : [])]),
    );
    res.json({
      ...result,
      items: result.items.map((x) => ({
        ...x,
        reporter: briefs.get(x.reporterId) ?? null,
        targetUser: x.targetType === 'user' ? (briefs.get(x.targetId) ?? null) : null,
      })),
    });
  });

  r.post('/reports/:id/resolve', can('reports.resolve'), async (req, res) => {
    const input = parseBody(
      req,
      z.object({
        status: z.enum(['resolved', 'dismissed']),
        action: z.string().trim().min(1).max(60),
        note: z.string().trim().max(500).nullable().default(null),
      }),
    );
    const report = await s.moderation.resolveReport(oid(req), {
      ...input,
      by: currentUser(req).uid,
    });
    await audit(req, 'report.resolve', 'report', String(report._id), input);
    res.json({ report });
  });

  r.get('/feed', can('feed.moderate'), async (req, res) => {
    const q = parseQuery(
      req,
      pageQuery.extend({
        status: z.enum(['active', 'hidden', 'removed']).optional(),
        authorId: z.string().optional(),
      }),
    );
    res.json(await s.feed.adminList(q, q.page, q.pageSize));
  });

  r.post('/feed/:id/status', can('feed.moderate'), async (req, res) => {
    const { status } = parseBody(
      req,
      z.object({ status: z.enum(['active', 'hidden', 'removed']) }),
    );
    await s.feed.setStatus(oid(req), status);
    await audit(req, 'feed.status', 'post', parseParams(req, idParams).id, { status });
    res.status(204).end();
  });

  r.get('/devices/bans', can('devices.ban'), async (req, res) => {
    const q = parseQuery(req, pageQuery);
    const [items, total] = await Promise.all([
      ctx.col.deviceBans
        .find()
        .sort({ createdAt: -1 })
        .skip((q.page - 1) * q.pageSize)
        .limit(q.pageSize)
        .toArray(),
      ctx.col.deviceBans.countDocuments(),
    ]);
    res.json({ items, total, page: q.page, pageSize: q.pageSize });
  });

  r.post('/devices/bans', can('devices.ban'), async (req, res) => {
    const { deviceId, reason, cascade } = parseBody(
      req,
      z.object({
        deviceId: z.string().trim().toLowerCase().min(6).max(128),
        reason: z.string().trim().min(3).max(300),
        cascade: z.boolean().default(true),
      }),
    );
    const result = await s.moderation.banDevice(deviceId, {
      reason,
      by: currentUser(req).uid,
      cascade,
    });
    await audit(req, 'device.ban', 'device', deviceId, { reason, cascade, ...result });
    res.json(result);
  });

  r.delete('/devices/bans/:deviceId', can('devices.ban'), async (req, res) => {
    const { deviceId } = z.object({ deviceId: z.string().min(1).max(128) }).parse(req.params);
    await s.moderation.unbanDevice(deviceId);
    await audit(req, 'device.unban', 'device', deviceId);
    res.status(204).end();
  });

  r.get('/devices/:deviceId/users', can('devices.ban'), async (req, res) => {
    const { deviceId } = z.object({ deviceId: z.string().min(1).max(128) }).parse(req.params);
    res.json({ items: await s.moderation.usersForDevice(deviceId) });
  });

  // ── Notifications & banners ────────────────────────────────────────────────────
  r.get('/announcements', can('notifications.send'), async (req, res) => {
    const q = parseQuery(req, pageQuery);
    res.json(await s.notifications.announcements(q.page, q.pageSize));
  });

  r.post('/announcements', can('notifications.send'), async (req, res) => {
    const ann = await s.notifications.createAnnouncement(
      currentUser(req).uid,
      parseBody(req, announcementInput),
    );
    await audit(req, 'announcement.create', 'announcement', String(ann._id), {
      title: ann.title,
      audience: ann.audience,
    });
    res.status(202).json({ announcement: ann });
  });

  r.get('/banners', can('config.manage'), async (_req, res) => {
    res.json({ items: await s.banners.all() });
  });

  r.post('/banners', can('config.manage'), async (req, res) => {
    const banner = await s.banners.upsert(null, parseBody(req, bannerInput));
    await audit(req, 'banner.create', 'banner', String(banner._id), banner);
    res.status(201).json({ banner });
  });

  r.put('/banners/:id', can('config.manage'), async (req, res) => {
    const banner = await s.banners.upsert(oid(req), parseBody(req, bannerInput));
    await audit(req, 'banner.update', 'banner', String(banner._id), banner);
    res.json({ banner });
  });

  r.delete('/banners/:id', can('config.manage'), async (req, res) => {
    await s.banners.remove(oid(req));
    await audit(req, 'banner.delete', 'banner', parseParams(req, idParams).id);
    res.status(204).end();
  });

  // ── Games ─────────────────────────────────────────────────────────────────
  r.get('/games', can('games.read'), async (_req, res) => {
    res.json({ items: await s.games.registry(true) });
  });

  r.patch('/games/:key', can('games.manage'), async (req, res) => {
    const { key } = parseParams(req, gameParam);
    const patch = parseBody(req, gameMetaInput);
    const game = await s.games.updateMeta(key, patch);
    await audit(req, 'game.update', 'game', key, patch);
    res.json({ game });
  });

  r.put('/games/:key/config', can('games.manage'), async (req, res) => {
    const { key } = parseParams(req, gameParam);
    const config = parseBody(req, gameConfigInput);
    const game = await s.games.updateConfig(key, config);
    await audit(req, 'game.config', 'game', key, config);
    res.json({ game });
  });

  r.get('/games/:key/rounds', can('games.read'), async (req, res) => {
    const { key } = parseParams(req, gameParam);
    const q = parseQuery(req, pageQuery);
    res.json(await s.games.rounds(key, q.page, q.pageSize));
  });

  r.get('/games/:key/analytics', can('games.read'), async (req, res) => {
    const { key } = parseParams(req, gameParam);
    const { days } = parseQuery(
      req,
      z.object({ days: z.coerce.number().int().min(1).max(90).default(14) }),
    );
    res.json(await s.games.analytics(key, days));
  });

  r.post('/games/rounds/:id/void', can('games.manage'), async (req, res) => {
    const result = await s.games.voidRound(oid(req));
    await audit(req, 'game.void_round', 'game_round', parseParams(req, idParams).id, result);
    res.json(result);
  });

  // ── Config & audit ────────────────────────────────────────────────────────────
  r.get('/config', can('config.manage'), async (_req, res) => {
    res.json(await s.config.all());
  });

  r.put('/config/:key', can('config.manage'), async (req, res) => {
    const { key } = z
      .object({ key: z.enum(Object.keys(CONFIG_SCHEMAS) as [ConfigKey, ...ConfigKey[]]) })
      .parse(req.params);
    const value = await s.config.set(key, req.body, currentUser(req).uid);
    if (key === 'economy') s.levels.invalidate();
    await audit(req, 'config.update', 'config', key, value);
    res.json({ value });
  });

  r.get('/audit', can('audit.read'), async (req, res) => {
    const q = parseQuery(
      req,
      pageQuery.extend({
        adminId: z.string().optional(),
        action: z.string().optional(),
        targetId: z.string().optional(),
      }),
    );
    res.json(await s.audit.list(q, q.page, q.pageSize));
  });

  return r;
}
