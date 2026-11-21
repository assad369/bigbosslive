import { ObjectId, type ClientSession } from 'mongodb';
import { z } from 'zod';
import { LIVEKIT_TOPICS, SOCKET, type CoinBagSummary } from '@bigboss/shared';
import type { Ctx } from '../../context.js';
import type { CoinBagCloseReason, CoinBagDoc, CoinBagShareDoc } from '../../db/schema.js';
import {
  AppError,
  agencyMemberCoinBagBlocked,
  badRequest,
  conflict,
  isDuplicateKeyError,
  notFound,
} from '../../lib/errors.js';
import { once } from '../../lib/idempotency.js';
import { objectIdString } from '../../lib/http.js';
import { feeSplit, splitShares } from './split.js';

export const releaseCoinBagInput = z.object({
  roomId: objectIdString,
  amount: z.number().int().positive(),
  shareCount: z.number().int().positive(),
});

/** A close may run this long after `expiresAt`, so a grab sent in the last second lands first. */
const REFUND_GRACE_MS = 3_000;
const ACTIVE_CACHE_MS = 2_000;
const UPDATE_COALESCE_MS = 1_000;

/** Sent when a closing transaction lost a race with a grab; the next sweep retries. */
class CloseRaced extends Error {}

type Refusal = { code: string; message: string };

/**
 * Coin bags: a user in a live puts diamonds in a bag, split at release into random shares
 * (`splitShares`), which people in that room grab once each after a countdown. Hosts of other
 * lives grab from their own room. Unclaimed shares go back to the releaser when the bag closes;
 * the platform fee does not. No step moves anyone's level (CLAUDE.md level rule).
 */
export class CoinBagsService {
  private activeCache: { at: number; bags: CoinBagSummary[] } | null = null;
  private readonly pendingUpdates = new Map<string, NodeJS.Timeout>();

  constructor(private readonly ctx: Ctx) {}

  private get col() {
    return this.ctx.col.coinBags;
  }

  // ── Reads ───────────────────────────────────────────────────────────────────

  /** Why `uid` may not release a bag right now, or null. */
  async releaseRefusal(uid: string): Promise<Refusal | null> {
    const features = await this.ctx.services.config.get('features');
    if (!features.coinBagsEnabled)
      return { code: 'coin_bags_disabled', message: 'Coin bags are switched off right now' };
    const user = await this.ctx.col.users.findOne(
      { _id: uid },
      { projection: { agencyId: 1, isAgent: 1 } },
    );
    if (!user) return { code: 'not_found', message: 'User not found' };
    if (user.agencyId)
      return {
        code: 'agency_member_coin_bag_blocked',
        message: "Agency hosts can't release coin bags",
      };
    if (user.isAgent)
      return { code: 'agent_coin_bag_blocked', message: "Agents can't release coin bags" };
    return null;
  }

  async config(uid: string) {
    const [features, rules, refusal] = await Promise.all([
      this.ctx.services.config.get('features'),
      this.ctx.services.config.get('coinBags'),
      this.releaseRefusal(uid),
    ]);
    return {
      enabled: features.coinBagsEnabled,
      amountOptions: rules.amountOptions,
      shareOptions: rules.shareOptions,
      feeRate: rules.feeRate,
      minShare: rules.minShare,
      countdownSec: rules.countdownSec,
      grabWindowSec: rules.grabWindowSec,
      canRelease: refusal === null,
      refusal,
      serverNow: this.ctx.clock.now().toISOString(),
    };
  }

  /** Running bags, newest first, plus what [uid] already grabbed from them. */
  async active(uid: string) {
    const bags = await this.activeSummaries();
    const mine = bags.length
      ? await this.ctx.col.coinBagShares
          .find(
            { bagId: { $in: bags.map((b) => new ObjectId(b.id)) }, claimedBy: uid },
            { projection: { bagId: 1, amount: 1 } },
          )
          .toArray()
      : [];
    return {
      items: bags,
      grabbed: Object.fromEntries(mine.map((s) => [String(s.bagId), s.amount])),
      serverNow: this.ctx.clock.now().toISOString(),
    };
  }

  /** Shared by every caller for a couple of seconds: the list is the same for everyone. */
  private async activeSummaries(): Promise<CoinBagSummary[]> {
    const now = Date.now();
    if (this.activeCache && now - this.activeCache.at < ACTIVE_CACHE_MS)
      return this.activeCache.bags;
    const docs = await this.col
      .find({ status: 'active' })
      .sort({ createdAt: -1, _id: -1 })
      .limit(100)
      .toArray();
    const bags = await this.summaries(docs);
    this.activeCache = { at: now, bags };
    return bags;
  }

  private invalidateActive() {
    this.activeCache = null;
  }

  async detail(bagId: ObjectId, uid: string) {
    const bag = await this.col.findOne({ _id: bagId });
    if (!bag) throw notFound('Coin bag');
    const [summary] = await this.summaries([bag]);
    const [mine, top] = await Promise.all([
      this.ctx.col.coinBagShares.findOne({ bagId, claimedBy: uid }, { projection: { amount: 1 } }),
      this.ctx.col.coinBagShares
        .find({ bagId, claimedBy: { $type: 'string' } })
        .sort({ amount: -1, claimedAt: 1 })
        .limit(10)
        .toArray(),
    ]);
    const briefs = await this.ctx.services.users.briefs(top.map((s) => s.claimedBy!));
    return {
      bag: summary!,
      myAmount: mine?.amount ?? null,
      luckiest: top.map((s) => ({ user: briefs.get(s.claimedBy!) ?? null, amount: s.amount })),
      serverNow: this.ctx.clock.now().toISOString(),
    };
  }

  async summaries(docs: CoinBagDoc[]): Promise<CoinBagSummary[]> {
    const briefs = await this.ctx.services.users.briefs(
      docs.flatMap((d) => [d.releaserId, d.hostId]),
    );
    return docs.map((d) => ({
      id: String(d._id),
      releaser: briefs.get(d.releaserId) ?? null,
      roomId: String(d.roomId),
      host: briefs.get(d.hostId) ?? null,
      amount: d.amount,
      pool: d.pool,
      shareCount: d.shareCount,
      grabbedCount: d.grabbedCount,
      status: d.status,
      createdAt: d.createdAt.toISOString(),
      opensAt: d.opensAt.toISOString(),
      expiresAt: d.expiresAt.toISOString(),
    }));
  }

  // ── Release ─────────────────────────────────────────────────────────────────

  async release(uid: string, key: string, input: z.infer<typeof releaseCoinBagInput>) {
    const refusal = await this.releaseRefusal(uid);
    if (refusal?.code === 'agency_member_coin_bag_blocked') throw agencyMemberCoinBagBlocked();
    if (refusal) throw new AppError(403, refusal.code, refusal.message);
    const rules = await this.ctx.services.config.get('coinBags');
    if (!rules.amountOptions.includes(input.amount)) throw badRequest('Pick one of the amounts');
    if (!rules.shareOptions.includes(input.shareCount))
      throw badRequest('Pick one of the share counts');
    const { fee, pool } = feeSplit(input.amount, rules.feeRate);
    if (pool < input.shareCount * rules.minShare)
      throw badRequest('That amount is too small for so many shares');

    const room = await this.ctx.services.live.getLive(new ObjectId(input.roomId));
    if (room.locked)
      throw new AppError(403, 'room_locked', "Coin bags can't go into a locked live");
    if (!(await this.ctx.services.live.presentOf(room, [uid])).has(uid))
      throw new AppError(403, 'not_in_room', 'Join the live to release a coin bag');
    const running = await this.col.countDocuments({ status: 'active' });
    if (running >= rules.maxActiveGlobal)
      throw new AppError(429, 'too_many_coin_bags', 'Too many coin bags right now, try again soon');

    const { result, replayed } = await once(this.ctx, 'coin_bag', uid, key, async (session) => {
      const now = this.ctx.clock.now();
      const opensAt = new Date(now.getTime() + rules.countdownSec * 1000);
      const bag: CoinBagDoc = {
        _id: new ObjectId(),
        releaserId: uid,
        roomId: room._id,
        hostId: room.hostId,
        amount: input.amount,
        fee,
        feeRate: rules.feeRate,
        pool,
        shareCount: input.shareCount,
        minShare: rules.minShare,
        grabbedCount: 0,
        grabbedAmount: 0,
        refundedAmount: 0,
        status: 'active',
        activeSlot: true,
        createdAt: now,
        opensAt,
        expiresAt: new Date(opensAt.getTime() + rules.grabWindowSec * 1000),
        closedAt: null,
        closeReason: null,
      };
      try {
        await this.col.insertOne(bag, { session });
      } catch (err) {
        if (isDuplicateKeyError(err))
          throw conflict('You already have a coin bag running', 'coin_bag_active');
        throw err;
      }
      const balance = await this.ctx.services.wallet.debit(session, {
        uid,
        currency: 'diamonds',
        amount: input.amount,
        reason: 'coin_bag_release',
        refId: String(bag._id),
        meta: { roomId: String(room._id), shareCount: input.shareCount, fee },
      });
      const shares: CoinBagShareDoc[] = splitShares(pool, input.shareCount, rules.minShare).map(
        (amount, idx) => ({
          _id: new ObjectId(),
          bagId: bag._id,
          idx,
          amount,
          claimedBy: null,
          claimedAt: null,
          remote: false,
          refundedAt: null,
        }),
      );
      await this.ctx.col.coinBagShares.insertMany(shares, { session });
      return { bagId: String(bag._id), balance };
    });

    const doc = await this.col.findOne({ _id: new ObjectId(result.bagId) });
    const [bag] = await this.summaries([doc!]);
    if (!replayed) {
      this.invalidateActive();
      const serverNow = this.ctx.clock.now().toISOString();
      this.ctx.realtime.broadcast(SOCKET.namespaces.app, SOCKET.app.coinBagReleased, {
        bag,
        serverNow,
      });
      // A chat line in the room it went into.
      await this.ctx.livekit
        .sendData(room.livekitRoom, LIVEKIT_TOPICS.system, { kind: 'coin_bag', bag })
        .catch(() => undefined);
    }
    return { bag: bag!, balance: result.balance, replayed };
  }

  // ── Grab ────────────────────────────────────────────────────────────────────

  async grab(uid: string, bagId: ObjectId) {
    const prior = await this.ctx.col.coinBagShares.findOne({ bagId, claimedBy: uid });
    if (prior) return this.grabResult(uid, prior, true);
    const bag = await this.col.findOne({ _id: bagId });
    if (!bag) throw notFound('Coin bag');
    if (bag.releaserId === uid)
      throw new AppError(403, 'own_coin_bag', "You can't grab your own coin bag");
    if (bag.status === 'finished')
      throw new AppError(410, 'coin_bag_empty', 'Every share has been grabbed');
    if (bag.status !== 'active') throw new AppError(410, 'coin_bag_closed', 'This coin bag ended');
    const now = this.ctx.clock.now();
    if (now < bag.opensAt)
      throw new AppError(409, 'coin_bag_not_open', 'This coin bag is not open yet', {
        opensAt: bag.opensAt.toISOString(),
      });
    if (now >= bag.expiresAt) throw new AppError(410, 'coin_bag_closed', 'This coin bag ended');
    const remote = await this.grabFrom(uid, bag);

    let share: CoinBagShareDoc | null;
    try {
      share = await this.ctx.db.withTransaction(async (session) => {
        const claimed = await this.claimShare(session, bag, uid, remote);
        if (!claimed) return null;
        await this.ctx.services.wallet.credit(session, {
          uid,
          currency: 'diamonds',
          amount: claimed.amount,
          reason: 'coin_bag_grab',
          refId: String(bag._id),
          meta: { from: bag.releaserId, roomId: String(bag.roomId), remote },
        });
        return claimed;
      });
    } catch (err) {
      // A parallel request from the same user claimed first (unique bagId+claimedBy).
      if (!isDuplicateKeyError(err)) throw err;
      share = await this.ctx.col.coinBagShares.findOne({ bagId, claimedBy: uid });
      if (share) return this.grabResult(uid, share, true);
      throw err;
    }
    if (!share) throw new AppError(410, 'coin_bag_empty', 'Every share has been grabbed');

    const after = await this.col.findOneAndUpdate(
      { _id: bag._id },
      { $inc: { grabbedCount: 1, grabbedAmount: share.amount } },
      { returnDocument: 'after', projection: { grabbedCount: 1, shareCount: 1 } },
    );
    this.invalidateActive();
    if (after && after.grabbedCount >= after.shareCount) {
      await this.close(bag._id, 'finished').catch((err: unknown) =>
        this.ctx.log.warn({ err }, 'coin bag close after last grab failed'),
      );
    } else {
      this.queueUpdate(bag._id);
    }
    return this.grabResult(uid, share, false);
  }

  /** Remote = false when [uid] is in the bag's room, true when they host another live. */
  private async grabFrom(uid: string, bag: CoinBagDoc): Promise<boolean> {
    const room = await this.ctx.col.liveRooms.findOne({ _id: bag.roomId, status: 'live' });
    if (room && (await this.ctx.services.live.presentOf(room, [uid])).has(uid)) return false;
    const hosting = await this.ctx.col.liveRooms.findOne(
      { hostId: uid, status: 'live' },
      { projection: { _id: 1 } },
    );
    if (hosting) return true;
    throw new AppError(403, 'not_in_room', 'Join that live to grab its coin bag');
  }

  /** Claims an open share, starting at a random index so grabbers spread over rows. */
  private async claimShare(
    session: ClientSession,
    bag: CoinBagDoc,
    uid: string,
    remote: boolean,
  ): Promise<CoinBagShareDoc | null> {
    const shares = this.ctx.col.coinBagShares;
    const start = Math.floor(Math.random() * bag.shareCount);
    const base = { bagId: bag._id, claimedBy: null, refundedAt: null };
    const claim = { $set: { claimedBy: uid, claimedAt: this.ctx.clock.now(), remote } };
    return (
      (await shares.findOneAndUpdate({ ...base, idx: { $gte: start } }, claim, {
        session,
        returnDocument: 'after',
        sort: { idx: 1 },
      })) ??
      (await shares.findOneAndUpdate({ ...base, idx: { $lt: start } }, claim, {
        session,
        returnDocument: 'after',
        sort: { idx: 1 },
      }))
    );
  }

  private async grabResult(uid: string, share: CoinBagShareDoc, duplicate: boolean) {
    const user = await this.ctx.col.users.findOne(
      { _id: uid },
      { projection: { 'wallet.diamonds': 1 } },
    );
    return {
      bagId: String(share.bagId),
      amount: share.amount,
      remote: share.remote,
      balance: user?.wallet.diamonds ?? 0,
      duplicate,
    };
  }

  /** At most one `coinbag:updated` per bag per second, from this replica. */
  private queueUpdate(bagId: ObjectId) {
    const id = String(bagId);
    if (this.pendingUpdates.has(id)) return;
    const timer = setTimeout(() => {
      this.pendingUpdates.delete(id);
      void this.col
        .findOne({ _id: bagId }, { projection: { grabbedCount: 1, status: 1 } })
        .then((b) => {
          if (b?.status !== 'active') return;
          this.ctx.realtime.broadcast(SOCKET.namespaces.app, SOCKET.app.coinBagUpdated, {
            bagId: id,
            grabbedCount: b.grabbedCount,
            serverNow: this.ctx.clock.now().toISOString(),
          });
        })
        .catch(() => undefined);
    }, UPDATE_COALESCE_MS);
    timer.unref?.();
    this.pendingUpdates.set(id, timer);
  }

  // ── Close ───────────────────────────────────────────────────────────────────

  /**
   * Closes an active bag and gives unclaimed shares back to the releaser, in one transaction.
   * Without `force` it waits until a short grace after `expiresAt` while shares are left, so a
   * grab sent at the last second still lands. Returns whether this call closed it.
   */
  async close(bagId: ObjectId, reason: CoinBagCloseReason, force = false): Promise<boolean> {
    const bag = await this.col.findOne({ _id: bagId, status: 'active' });
    if (!bag) return false;
    let closed: CoinBagDoc['status'] | null = null;
    try {
      closed = await this.ctx.db.withTransaction(async (session) => {
        const now = this.ctx.clock.now();
        const open = await this.ctx.col.coinBagShares
          .find({ bagId, claimedBy: null, refundedAt: null }, { session })
          .toArray();
        if (open.length && !force && now.getTime() < bag.expiresAt.getTime() + REFUND_GRACE_MS)
          return null;
        const refund = open.reduce((n, s) => n + s.amount, 0);
        if (open.length) {
          const marked = await this.ctx.col.coinBagShares.updateMany(
            { bagId, claimedBy: null, refundedAt: null },
            { $set: { refundedAt: now } },
            { session },
          );
          if (marked.modifiedCount !== open.length) throw new CloseRaced();
        }
        const status: CoinBagDoc['status'] =
          refund === 0 ? 'finished' : reason === 'cancelled' ? 'cancelled' : 'expired';
        const releaser = await this.ctx.col.users.findOne(
          { _id: bag.releaserId },
          { session, projection: { status: 1 } },
        );
        const orphaned = refund > 0 && (!releaser || releaser.status === 'deleted');
        const updated = await this.col.updateOne(
          { _id: bagId, status: 'active' },
          {
            $set: {
              status,
              closedAt: now,
              closeReason: refund === 0 ? 'finished' : reason,
              refundedAmount: orphaned ? 0 : refund,
              ...(orphaned ? { refundOrphaned: refund } : {}),
            },
            $unset: { activeSlot: '' },
          },
          { session },
        );
        if (!updated.modifiedCount) throw new CloseRaced();
        if (refund > 0 && !orphaned) {
          await this.ctx.services.wallet.credit(session, {
            uid: bag.releaserId,
            currency: 'diamonds',
            amount: refund,
            reason: 'coin_bag_refund',
            refId: String(bagId),
            meta: { shares: open.length, closeReason: reason },
          });
        }
        return status;
      });
    } catch (err) {
      if (err instanceof CloseRaced) return false;
      throw err;
    }
    if (!closed) return false;
    this.invalidateActive();
    this.ctx.realtime.broadcast(SOCKET.namespaces.app, SOCKET.app.coinBagClosed, {
      bagId: String(bagId),
      status: closed,
      serverNow: this.ctx.clock.now().toISOString(),
    });
    return true;
  }

  /** A live ended: its running bag closes now and refunds what is left. */
  async closeForRoom(roomId: ObjectId): Promise<void> {
    const bags = await this.col
      .find({ roomId, status: 'active' }, { projection: { _id: 1 } })
      .toArray();
    for (const b of bags) await this.close(b._id, 'room_ended', true);
  }

  /** Staff cancel: closes at once and refunds the unclaimed shares. */
  async cancel(bagId: ObjectId, adminId: string, reason: string) {
    const bag = await this.col.findOne({ _id: bagId });
    if (!bag) throw notFound('Coin bag');
    if (bag.status !== 'active') throw conflict('This coin bag already ended', 'coin_bag_closed');
    await this.col.updateOne(
      { _id: bagId, status: 'active' },
      { $set: { cancelledBy: adminId, cancelReason: reason } },
    );
    if (!(await this.close(bagId, 'cancelled', true)))
      throw conflict('This coin bag already ended', 'coin_bag_closed');
    return (await this.col.findOne({ _id: bagId }))!;
  }

  /**
   * Every few seconds: close bags past their window, bags whose live ended, and bags whose
   * shares are all taken (in case the step after the last grab was lost).
   */
  async sweep(): Promise<number> {
    const now = this.ctx.clock.now();
    let closed = 0;
    const due = await this.col
      .find(
        { status: 'active', expiresAt: { $lte: new Date(now.getTime() - REFUND_GRACE_MS) } },
        { projection: { _id: 1 } },
      )
      .limit(100)
      .toArray();
    for (const b of due) if (await this.close(b._id, 'expired')) closed++;

    const active = await this.col
      .find(
        { status: 'active' },
        { projection: { _id: 1, roomId: 1, grabbedCount: 1, shareCount: 1 } },
      )
      .limit(500)
      .toArray();
    if (!active.length) return closed;
    const live = new Set(
      (
        await this.ctx.col.liveRooms
          .find(
            {
              _id: {
                $in: [...new Set(active.map((b) => String(b.roomId)))].map(
                  (id) => new ObjectId(id),
                ),
              },
              status: 'live',
            },
            { projection: { _id: 1 } },
          )
          .toArray()
      ).map((r) => String(r._id)),
    );
    for (const b of active) {
      if (!live.has(String(b.roomId))) {
        if (await this.close(b._id, 'room_ended', true)) closed++;
      } else if (b.grabbedCount >= b.shareCount) {
        if (await this.close(b._id, 'finished')) closed++;
      }
    }
    return closed;
  }

  // ── Admin ───────────────────────────────────────────────────────────────────

  async adminList(
    filter: { status?: CoinBagDoc['status']; uid?: string },
    page: number,
    pageSize: number,
  ) {
    const q = {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.uid ? { releaserId: filter.uid } : {}),
    };
    const [docs, total] = await Promise.all([
      this.col
        .find(q)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
      this.col.countDocuments(q),
    ]);
    const summaries = await this.summaries(docs);
    return {
      items: docs.map((d, i) => ({
        ...summaries[i]!,
        fee: d.fee,
        feeRate: d.feeRate,
        grabbedAmount: d.grabbedAmount,
        refundedAmount: d.refundedAmount,
        refundOrphaned: d.refundOrphaned ?? 0,
        closedAt: d.closedAt?.toISOString() ?? null,
        closeReason: d.closeReason,
        cancelReason: d.cancelReason ?? null,
      })),
      total,
      page,
      pageSize,
    };
  }

  async adminGrabs(bagId: ObjectId) {
    const shares = await this.ctx.col.coinBagShares.find({ bagId }).sort({ idx: 1 }).toArray();
    if (!shares.length && !(await this.col.findOne({ _id: bagId }))) throw notFound('Coin bag');
    const briefs = await this.ctx.services.users.briefs(
      shares.flatMap((s) => (s.claimedBy ? [s.claimedBy] : [])),
    );
    return {
      items: shares.map((s) => ({
        idx: s.idx,
        amount: s.amount,
        uid: s.claimedBy,
        user: s.claimedBy ? (briefs.get(s.claimedBy) ?? null) : null,
        claimedAt: s.claimedAt?.toISOString() ?? null,
        remote: s.remote,
        refundedAt: s.refundedAt?.toISOString() ?? null,
      })),
    };
  }
}
