import { ObjectId } from 'mongodb';
import { LIVEKIT_TOPICS, type PkBattle } from '@bigboss/shared';
import type { Ctx } from '../../context.js';
import type { LiveRoomDoc, PkBattleDoc } from '../../db/schema.js';
import { AppError, badRequest, conflict, forbidden, isDuplicateKeyError, notFound } from '../../lib/errors.js';
import { addSeconds } from '../../lib/time.js';

/**
 * PK battles: two live video hosts compete for gift points over a fixed duration.
 *
 * The server owns the state machine (pending → active → ended, or pending → rejected /
 * cancelled / expired). Every deadline is a timestamp on the document and the sweeper job
 * enforces it — there are no in-memory timers, so restarts and multiple replicas are safe.
 * `pkLive` is cleared in the same update that writes any terminal status; the partial unique
 * index on `participantUids` (pkLive: true) guarantees one battle per host.
 *
 * Media: each host's tracks are forwarded into the opponent's room by the LiveKit SFU, so
 * clients never hold a cross-room connection. Events ride the LiveKit data channel.
 */
export class PkService {
  constructor(private readonly ctx: Ctx) {}

  private async present(b: PkBattleDoc): Promise<PkBattle> {
    const briefs = await this.ctx.services.users.briefs(b.participantUids);
    return {
      id: String(b._id),
      status: b.status,
      hosts: b.hosts.map((h) => ({
        uid: h.uid,
        roomId: String(h.roomId),
        score: h.score,
        displayName: briefs.get(h.uid)?.displayName ?? 'Host',
        avatarUrl: briefs.get(h.uid)?.avatarUrl ?? null,
      })),
      durationSec: b.durationSec,
      startedAt: b.startedAt?.toISOString() ?? null,
      endsAt: b.endsAt?.toISOString() ?? null,
      winnerUid: b.winnerUid,
      isDraw: b.isDraw,
    };
  }

  private async broadcast(b: PkBattleDoc, topic: string, extra: Record<string, unknown> = {}): Promise<void> {
    const payload = { battle: await this.present(b), ...extra };
    await Promise.all(
      b.hosts.map((h) => this.ctx.livekit.sendData(h.livekitRoom, topic, payload).catch((err: unknown) => this.ctx.log.warn({ err, topic }, 'pk broadcast failed'))),
    );
  }

  private async liveVideoRoomOf(uid: string): Promise<LiveRoomDoc> {
    const room = await this.ctx.col.liveRooms.findOne({ hostId: uid, status: 'live' });
    if (!room) throw new AppError(409, 'not_live', 'Host is not live');
    if (room.type !== 'video') throw badRequest('PK is only available in video lives');
    return room;
  }

  async invite(inviterUid: string, opponentUid: string, durationSec: number) {
    if (inviterUid === opponentUid) throw badRequest('You cannot PK yourself');
    const [features, cfg] = await Promise.all([this.ctx.services.config.get('features'), this.ctx.services.config.get('pk')]);
    if (!features.pkEnabled) throw forbidden('PK is currently disabled');
    if (!cfg.durationsSec.includes(durationSec)) throw badRequest(`Duration must be one of ${cfg.durationsSec.join(', ')} seconds`);
    const [a, b] = await Promise.all([this.liveVideoRoomOf(inviterUid), this.liveVideoRoomOf(opponentUid)]);
    if (await this.ctx.services.users.isBlockedEitherWay(inviterUid, opponentUid)) throw forbidden('You cannot PK this host');

    const now = this.ctx.clock.now();
    const doc: PkBattleDoc = {
      _id: new ObjectId(),
      status: 'pending',
      pkLive: true,
      participantUids: [inviterUid, opponentUid],
      hosts: [
        { uid: inviterUid, roomId: a._id, livekitRoom: a.livekitRoom, score: 0 },
        { uid: opponentUid, roomId: b._id, livekitRoom: b.livekitRoom, score: 0 },
      ],
      invitedBy: inviterUid,
      durationSec,
      inviteExpiresAt: addSeconds(now, cfg.inviteTtlSec),
      startedAt: null,
      endsAt: null,
      endedAt: null,
      winnerUid: null,
      isDraw: false,
      endReason: null,
      createdAt: now,
    };
    try {
      await this.ctx.col.pkBattles.insertOne(doc);
    } catch (err) {
      if (isDuplicateKeyError(err)) throw conflict('One of the hosts is already in a PK', 'pk_busy');
      throw err;
    }
    const presented = await this.present(doc);
    await this.ctx.livekit
      .sendData(b.livekitRoom, LIVEKIT_TOPICS.pkInvitation, { battle: presented, expiresAt: doc.inviteExpiresAt.toISOString() }, [opponentUid])
      .catch(() => undefined);
    return presented;
  }

  /** Invite a random live host who is not already in a PK. */
  async randomMatch(inviterUid: string, durationSec: number) {
    const busy = await this.ctx.col.pkBattles.distinct('participantUids', { pkLive: true });
    const [candidate] = await this.ctx.col.liveRooms
      .aggregate<{ hostId: string }>([
        { $match: { status: 'live', type: 'video', hostId: { $nin: [inviterUid, ...busy] } } },
        { $sample: { size: 1 } },
        { $project: { hostId: 1 } },
      ])
      .toArray();
    if (!candidate) throw new AppError(404, 'no_opponent', 'No hosts are available for PK right now');
    return this.invite(inviterUid, candidate.hostId, durationSec);
  }

  async respond(battleId: ObjectId, uid: string, accept: boolean) {
    const now = this.ctx.clock.now();
    const pending = await this.ctx.col.pkBattles.findOne({ _id: battleId, status: 'pending' });
    if (!pending) throw notFound('Pending PK');
    if (pending.hosts[1].uid !== uid) throw forbidden('Only the invited host can respond');

    if (!accept) {
      const res = await this.terminatePending(battleId, 'rejected');
      if (res) await this.broadcast(res, LIVEKIT_TOPICS.pkRejected);
      return res ? this.present(res) : null;
    }

    const battle = await this.ctx.col.pkBattles.findOneAndUpdate(
      { _id: battleId, status: 'pending', inviteExpiresAt: { $gt: now } },
      { $set: { status: 'active', startedAt: now, endsAt: addSeconds(now, pending.durationSec) } },
      { returnDocument: 'after' },
    );
    if (!battle) throw new AppError(410, 'pk_expired', 'This invitation expired');

    // Both rooms must still be live; otherwise end immediately.
    const rooms = await this.ctx.col.liveRooms.find({ _id: { $in: battle.hosts.map((h) => h.roomId) }, status: 'live' }).toArray();
    if (rooms.length !== 2) {
      await this.end(battleId, 'host_left');
      throw new AppError(409, 'not_live', 'The other host is no longer live');
    }
    await this.ctx.col.liveRooms.updateMany({ _id: { $in: battle.hosts.map((h) => h.roomId) } }, { $set: { pkBattleId: battle._id } });
    const [h0, h1] = battle.hosts;
    await Promise.all([
      this.ctx.livekit.forwardParticipant(h0.livekitRoom, h0.uid, h1.livekitRoom),
      this.ctx.livekit.forwardParticipant(h1.livekitRoom, h1.uid, h0.livekitRoom),
    ]).catch((err: unknown) => this.ctx.log.error({ err, battleId: String(battleId) }, 'pk forwarding failed'));
    await this.broadcast(battle, LIVEKIT_TOPICS.pkStarted);
    return this.present(battle);
  }

  async cancel(battleId: ObjectId, uid: string) {
    const pending = await this.ctx.col.pkBattles.findOne({ _id: battleId, status: 'pending' });
    if (!pending) throw notFound('Pending PK');
    if (pending.invitedBy !== uid) throw forbidden('Only the inviter can cancel');
    const res = await this.terminatePending(battleId, 'cancelled');
    if (res) await this.broadcast(res, LIVEKIT_TOPICS.pkCancelled);
  }

  /** The only writer of pending → terminal. Clears `pkLive` in the same update. */
  private async terminatePending(battleId: ObjectId, status: 'rejected' | 'cancelled' | 'expired') {
    return this.ctx.col.pkBattles.findOneAndUpdate(
      { _id: battleId, status: 'pending' },
      { $set: { status, pkLive: false, endedAt: this.ctx.clock.now() } },
      { returnDocument: 'after' },
    );
  }

  /**
   * Score a gift for a host. Called after the gift transaction commits, with the diamonds
   * actually debited. Conditional on the battle being active and not past its deadline.
   */
  async addScore(battleId: ObjectId, hostUid: string, senderId: string, amount: number): Promise<void> {
    const now = this.ctx.clock.now();
    const battle = await this.ctx.col.pkBattles.findOneAndUpdate(
      { _id: battleId, status: 'active', endsAt: { $gt: now }, 'hosts.uid': hostUid },
      { $inc: { 'hosts.$.score': amount } },
      { returnDocument: 'after' },
    );
    if (!battle) return;
    await this.ctx.col.pkContributions.updateOne(
      { battleId, hostUid, userId: senderId },
      { $inc: { score: amount }, $setOnInsert: { battleId, hostUid, userId: senderId } },
      { upsert: true },
    );
    await this.broadcast(battle, LIVEKIT_TOPICS.pkScore, { contributors: await this.topContributors(battleId, 3) });
  }

  async topContributors(battleId: ObjectId, perHost = 10) {
    const rows = await this.ctx.col.pkContributions.find({ battleId }).sort({ score: -1 }).limit(perHost * 4).toArray();
    const briefs = await this.ctx.services.users.briefs(rows.map((r) => r.userId));
    const grouped: Record<string, { user: unknown; score: number }[]> = {};
    for (const r of rows) {
      const list = (grouped[r.hostUid] ??= []);
      if (list.length < perHost) list.push({ user: briefs.get(r.userId) ?? null, score: r.score });
    }
    return grouped;
  }

  /** The only writer of active → ended. Clears `pkLive`, stops forwarding, announces result. */
  async end(battleId: ObjectId, reason: NonNullable<PkBattleDoc['endReason']>, forfeitUid?: string): Promise<PkBattleDoc | null> {
    const current = await this.ctx.col.pkBattles.findOne({ _id: battleId, status: 'active' });
    if (!current) return null;
    const [a, b] = current.hosts;
    let winnerUid: string | null;
    let isDraw = false;
    if (forfeitUid) winnerUid = forfeitUid === a.uid ? b.uid : a.uid;
    else if (a.score === b.score) {
      winnerUid = null;
      isDraw = true;
    } else winnerUid = a.score > b.score ? a.uid : b.uid;

    const battle = await this.ctx.col.pkBattles.findOneAndUpdate(
      { _id: battleId, status: 'active' },
      { $set: { status: 'ended', pkLive: false, endedAt: this.ctx.clock.now(), winnerUid, isDraw, endReason: reason } },
      { returnDocument: 'after' },
    );
    if (!battle) return null;
    await this.ctx.col.liveRooms.updateMany({ pkBattleId: battle._id }, { $set: { pkBattleId: null } });
    await Promise.all([
      this.ctx.livekit.unforwardParticipant(a.livekitRoom, a.uid, b.livekitRoom),
      this.ctx.livekit.unforwardParticipant(b.livekitRoom, b.uid, a.livekitRoom),
    ]).catch(() => undefined);
    await this.broadcast(battle, LIVEKIT_TOPICS.pkEnded, { contributors: await this.topContributors(battleId, 3) });
    return battle;
  }

  async endByHost(battleId: ObjectId, uid: string) {
    const battle = await this.ctx.col.pkBattles.findOne({ _id: battleId });
    if (!battle) throw notFound('PK');
    if (!battle.participantUids.includes(uid)) throw forbidden();
    if (battle.status === 'pending') return this.cancel(battleId, uid);
    // Ending early forfeits the battle.
    await this.end(battleId, 'forfeit', uid);
  }

  async forfeitForHost(battleId: ObjectId, uid: string): Promise<void> {
    const battle = await this.ctx.col.pkBattles.findOne({ _id: battleId, pkLive: true });
    if (!battle) return;
    if (battle.status === 'pending') {
      const res = await this.terminatePending(battleId, 'cancelled');
      if (res) await this.broadcast(res, LIVEKIT_TOPICS.pkCancelled);
      return;
    }
    await this.end(battleId, 'host_left', uid);
  }

  async forRoom(roomId: ObjectId) {
    const battle = await this.ctx.col.pkBattles.findOne({ 'hosts.roomId': roomId, pkLive: true });
    if (!battle) return null;
    return { battle: await this.present(battle), contributors: await this.topContributors(battle._id, 3) };
  }

  async get(battleId: ObjectId) {
    const battle = await this.ctx.col.pkBattles.findOne({ _id: battleId });
    if (!battle) throw notFound('PK');
    return { battle: await this.present(battle), contributors: await this.topContributors(battleId, 10) };
  }

  async list(filter: { status?: PkBattleDoc['status']; uid?: string }, page: number, pageSize: number) {
    const q = { ...(filter.status ? { status: filter.status } : {}), ...(filter.uid ? { participantUids: filter.uid } : {}) };
    const [docs, total] = await Promise.all([
      this.ctx.col.pkBattles.find(q).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray(),
      this.ctx.col.pkBattles.countDocuments(q),
    ]);
    return { items: await Promise.all(docs.map((d) => this.present(d))), total, page, pageSize };
  }

  /** Sweeper (every few seconds): expire stale invitations and end battles past `endsAt`. */
  async sweep(): Promise<{ expired: number; ended: number }> {
    const now = this.ctx.clock.now();
    let expired = 0;
    let ended = 0;
    const pending = await this.ctx.col.pkBattles.find({ status: 'pending', inviteExpiresAt: { $lte: now } }, { projection: { _id: 1 } }).limit(200).toArray();
    for (const p of pending) {
      const res = await this.terminatePending(p._id, 'expired');
      if (res) {
        expired++;
        await this.broadcast(res, LIVEKIT_TOPICS.pkExpired);
      }
    }
    const due = await this.ctx.col.pkBattles.find({ status: 'active', endsAt: { $lte: now } }, { projection: { _id: 1 } }).limit(200).toArray();
    for (const d of due) if (await this.end(d._id, 'timeout')) ended++;
    return { expired, ended };
  }
}
