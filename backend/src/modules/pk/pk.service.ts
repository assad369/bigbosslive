import { ObjectId } from 'mongodb';
import { LIVEKIT_TOPICS, type PkBattle } from '@bigboss/shared';
import type { Ctx } from '../../context.js';
import type { LiveRoomDoc, PkBattleDoc } from '../../db/schema.js';
import {
  AppError,
  badRequest,
  conflict,
  forbidden,
  isDuplicateKeyError,
  notFound,
} from '../../lib/errors.js';
import { addSeconds } from '../../lib/time.js';

/**
 * PK battles: two live video hosts compete for gift points over up to `maxRounds` rounds.
 *
 * The server owns the state machine (pending → active → ended, or pending → rejected /
 * cancelled / expired). While active, each round is `live` (gifts score once the lead-in
 * countdown has passed) and then `paused` until a host starts the next round. The battle ends
 * when one host has won a majority of rounds, all rounds are played, the pause times out, or
 * a host ends it. Every deadline is a timestamp on the document and the sweeper job enforces
 * it — there are no in-memory timers, so restarts and multiple replicas are safe.
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
    const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;
    return {
      id: String(b._id),
      status: b.status,
      hosts: b.hosts.map((h) => ({
        uid: h.uid,
        roomId: String(h.roomId),
        score: h.score,
        // Battles created before rounds existed have a single round.
        roundScore: h.roundScore ?? h.score,
        roundsWon: h.roundsWon ?? 0,
        displayName: briefs.get(h.uid)?.displayName ?? 'Host',
        avatarUrl: briefs.get(h.uid)?.avatarUrl ?? null,
        level: briefs.get(h.uid)?.level ?? 0,
        vipTier: briefs.get(h.uid)?.vipTier ?? 0,
        frameUrl: briefs.get(h.uid)?.frameUrl ?? null,
        frameFormat: briefs.get(h.uid)?.frameFormat ?? 'none',
      })),
      invitedBy: b.invitedBy,
      durationSec: b.durationSec,
      round: b.round ?? 1,
      maxRounds: b.maxRounds ?? 1,
      roundState: b.roundState ?? null,
      scoringOpensAt: iso(b.scoringOpensAt ?? b.startedAt),
      endsAt: iso(b.endsAt),
      pausedUntil: iso(b.pausedUntil),
      rounds: b.rounds ?? [],
      inviteExpiresAt: iso(b.inviteExpiresAt),
      startedAt: iso(b.startedAt),
      endedAt: iso(b.endedAt),
      winnerUid: b.winnerUid,
      isDraw: b.isDraw,
      endReason: b.endReason,
      serverTime: this.ctx.clock.now().toISOString(),
    };
  }

  private async broadcast(
    b: PkBattleDoc,
    topic: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const payload = { battle: await this.present(b), ...extra };
    await Promise.all(
      b.hosts.map((h) =>
        this.ctx.livekit
          .sendData(h.livekitRoom, topic, payload)
          .catch((err: unknown) => this.ctx.log.warn({ err, topic }, 'pk broadcast failed')),
      ),
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
    const [features, cfg] = await Promise.all([
      this.ctx.services.config.get('features'),
      this.ctx.services.config.get('pk'),
    ]);
    if (!features.pkEnabled) throw forbidden('PK is currently disabled');
    if (!cfg.durationsSec.includes(durationSec))
      throw badRequest(`Duration must be one of ${cfg.durationsSec.join(', ')} seconds`);
    const [a, b] = await Promise.all([
      this.liveVideoRoomOf(inviterUid),
      this.liveVideoRoomOf(opponentUid),
    ]);
    if (await this.ctx.services.users.isBlockedEitherWay(inviterUid, opponentUid))
      throw forbidden('You cannot PK this host');

    const now = this.ctx.clock.now();
    const doc: PkBattleDoc = {
      _id: new ObjectId(),
      status: 'pending',
      pkLive: true,
      participantUids: [inviterUid, opponentUid],
      hosts: [
        {
          uid: inviterUid,
          roomId: a._id,
          livekitRoom: a.livekitRoom,
          score: 0,
          roundScore: 0,
          roundsWon: 0,
        },
        {
          uid: opponentUid,
          roomId: b._id,
          livekitRoom: b.livekitRoom,
          score: 0,
          roundScore: 0,
          roundsWon: 0,
        },
      ],
      invitedBy: inviterUid,
      durationSec,
      round: 0,
      maxRounds: cfg.maxRounds,
      roundState: null,
      scoringOpensAt: null,
      pausedUntil: null,
      rounds: [],
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
      if (isDuplicateKeyError(err))
        throw conflict('One of the hosts is already in a PK', 'pk_busy');
      throw err;
    }
    const presented = await this.present(doc);
    await this.ctx.livekit
      .sendData(
        b.livekitRoom,
        LIVEKIT_TOPICS.pkInvitation,
        { battle: presented, expiresAt: doc.inviteExpiresAt.toISOString() },
        [opponentUid],
      )
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
    if (!candidate)
      throw new AppError(404, 'no_opponent', 'No hosts are available for PK right now');
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

    const { leadInSec } = await this.ctx.services.config.get('pk');
    const opensAt = addSeconds(now, leadInSec);
    const battle = await this.ctx.col.pkBattles.findOneAndUpdate(
      { _id: battleId, status: 'pending', inviteExpiresAt: { $gt: now } },
      {
        $set: {
          status: 'active',
          startedAt: now,
          round: 1,
          roundState: 'live',
          scoringOpensAt: opensAt,
          endsAt: addSeconds(opensAt, pending.durationSec),
        },
      },
      { returnDocument: 'after' },
    );
    if (!battle) throw new AppError(410, 'pk_expired', 'This invitation expired');

    // Both rooms must still be live; otherwise end immediately.
    const rooms = await this.ctx.col.liveRooms
      .find({ _id: { $in: battle.hosts.map((h) => h.roomId) }, status: 'live' })
      .toArray();
    if (rooms.length !== 2) {
      await this.end(battleId, 'host_left');
      throw new AppError(409, 'not_live', 'The other host is no longer live');
    }
    await this.ctx.col.liveRooms.updateMany(
      { _id: { $in: battle.hosts.map((h) => h.roomId) } },
      { $set: { pkBattleId: battle._id } },
    );
    const [h0, h1] = battle.hosts;
    await Promise.all([
      this.ctx.livekit.forwardParticipant(h0.livekitRoom, h0.uid, h1.livekitRoom),
      this.ctx.livekit.forwardParticipant(h1.livekitRoom, h1.uid, h0.livekitRoom),
    ]).catch((err: unknown) =>
      this.ctx.log.error({ err, battleId: String(battleId) }, 'pk forwarding failed'),
    );
    await this.broadcast(battle, LIVEKIT_TOPICS.pkStarted);
    await this.publishRooms(battle);
    return this.present(battle);
  }

  /** Both rooms' directory cards show the PK badge while a battle runs. */
  private async publishRooms(b: PkBattleDoc): Promise<void> {
    await Promise.all(
      b.hosts.map((h) => this.ctx.services.live.publishDirectory(h.roomId).catch(() => undefined)),
    );
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
   * actually debited. Conditional on a round being live, past its lead-in and before its deadline.
   */
  async addScore(
    battleId: ObjectId,
    hostUid: string,
    senderId: string,
    amount: number,
  ): Promise<void> {
    const now = this.ctx.clock.now();
    const battle = await this.ctx.col.pkBattles.findOneAndUpdate(
      {
        _id: battleId,
        status: 'active',
        roundState: 'live',
        scoringOpensAt: { $lte: now },
        endsAt: { $gt: now },
        'hosts.uid': hostUid,
      },
      { $inc: { 'hosts.$.score': amount, 'hosts.$.roundScore': amount } },
      { returnDocument: 'after' },
    );
    if (!battle) return;
    await this.ctx.col.pkContributions.updateOne(
      { battleId, hostUid, userId: senderId },
      { $inc: { score: amount }, $setOnInsert: { battleId, hostUid, userId: senderId } },
      { upsert: true },
    );
    await this.broadcast(battle, LIVEKIT_TOPICS.pkScore, {
      contributors: await this.topContributors(battleId, 3),
    });
  }

  async topContributors(battleId: ObjectId, perHost = 10) {
    const battle = await this.ctx.col.pkBattles.findOne(
      { _id: battleId },
      { projection: { participantUids: 1 } },
    );
    if (!battle) return {};
    // One indexed query per host, so a host with few big supporters still gets their top N.
    const perSide = await Promise.all(
      battle.participantUids.map((hostUid) =>
        this.ctx.col.pkContributions
          .find({ battleId, hostUid })
          .sort({ score: -1 })
          .limit(perHost)
          .toArray(),
      ),
    );
    const rows = perSide.flat();
    const briefs = await this.ctx.services.users.briefs(rows.map((r) => r.userId));
    const grouped: Record<string, { user: unknown; score: number }[]> = {};
    for (const r of rows)
      (grouped[r.hostUid] ??= []).push({ user: briefs.get(r.userId) ?? null, score: r.score });
    return grouped;
  }

  /**
   * Close the live round whose deadline has passed: record its result and pause, or end the
   * battle when it is decided. Conditional on the round number, so concurrent sweeps are safe.
   */
  private async closeRound(battleId: ObjectId): Promise<'paused' | 'ended' | null> {
    const now = this.ctx.clock.now();
    const current = await this.ctx.col.pkBattles.findOne({
      _id: battleId,
      status: 'active',
      roundState: 'live',
      endsAt: { $lte: now },
    });
    if (!current) return null;
    const [a, b] = current.hosts;
    const winnerIdx = a.roundScore === b.roundScore ? -1 : a.roundScore > b.roundScore ? 0 : 1;
    const { pauseTimeoutSec } = await this.ctx.services.config.get('pk');
    const battle = await this.ctx.col.pkBattles.findOneAndUpdate(
      { _id: battleId, status: 'active', roundState: 'live', round: current.round },
      {
        $set: { roundState: 'paused', pausedUntil: addSeconds(now, pauseTimeoutSec) },
        $push: {
          rounds: {
            round: current.round,
            scores: [a.roundScore, b.roundScore],
            winnerUid: winnerIdx === -1 ? null : current.hosts[winnerIdx]!.uid,
          },
        },
        ...(winnerIdx === -1 ? {} : { $inc: { [`hosts.${winnerIdx}.roundsWon`]: 1 } }),
      },
      { returnDocument: 'after' },
    );
    if (!battle) return null;
    const majority = Math.floor(battle.maxRounds / 2) + 1;
    const decided =
      battle.round >= battle.maxRounds || battle.hosts.some((h) => h.roundsWon >= majority);
    if (decided) return (await this.end(battleId, 'completed')) ? 'ended' : null;
    await this.broadcast(battle, LIVEKIT_TOPICS.pkRoundEnded, {
      contributors: await this.topContributors(battleId, 3),
    });
    return 'paused';
  }

  /** Either host starts the next round from the pause. */
  async nextRound(battleId: ObjectId, uid: string) {
    const current = await this.ctx.col.pkBattles.findOne({ _id: battleId });
    if (!current) throw notFound('PK');
    if (!current.participantUids.includes(uid)) throw forbidden();
    if (current.status !== 'active' || current.roundState !== 'paused')
      throw conflict('The next round cannot start now', 'pk_not_paused');
    if (current.round >= current.maxRounds)
      throw conflict('All rounds are played', 'pk_not_paused');
    const now = this.ctx.clock.now();
    const { leadInSec } = await this.ctx.services.config.get('pk');
    const opensAt = addSeconds(now, leadInSec);
    const battle = await this.ctx.col.pkBattles.findOneAndUpdate(
      { _id: battleId, status: 'active', roundState: 'paused', round: current.round },
      {
        $set: {
          round: current.round + 1,
          roundState: 'live',
          scoringOpensAt: opensAt,
          endsAt: addSeconds(opensAt, current.durationSec),
          pausedUntil: null,
          'hosts.0.roundScore': 0,
          'hosts.1.roundScore': 0,
        },
      },
      { returnDocument: 'after' },
    );
    // The other host already started it.
    if (!battle) return (await this.get(battleId)).battle;
    await this.broadcast(battle, LIVEKIT_TOPICS.pkRoundStarted, {
      contributors: await this.topContributors(battleId, 3),
    });
    return this.present(battle);
  }

  /** The only writer of active → ended. Clears `pkLive`, stops forwarding, announces result. */
  async end(
    battleId: ObjectId,
    reason: NonNullable<PkBattleDoc['endReason']>,
    forfeitUid?: string,
  ): Promise<PkBattleDoc | null> {
    const current = await this.ctx.col.pkBattles.findOne({ _id: battleId, status: 'active' });
    if (!current) return null;
    const [a, b] = current.hosts;
    // Rounds won decide; total score breaks a tie.
    const key = (h: (typeof current.hosts)[number]) => [h.roundsWon ?? 0, h.score] as const;
    const cmp = (() => {
      const [ka, kb] = [key(a), key(b)];
      return ka[0] !== kb[0] ? ka[0] - kb[0] : ka[1] - kb[1];
    })();
    let winnerUid: string | null;
    let isDraw = false;
    if (forfeitUid) winnerUid = forfeitUid === a.uid ? b.uid : a.uid;
    else if (cmp === 0) {
      winnerUid = null;
      isDraw = true;
    } else winnerUid = cmp > 0 ? a.uid : b.uid;

    const battle = await this.ctx.col.pkBattles.findOneAndUpdate(
      { _id: battleId, status: 'active' },
      {
        $set: {
          status: 'ended',
          pkLive: false,
          endedAt: this.ctx.clock.now(),
          winnerUid,
          isDraw,
          endReason: reason,
          roundState: null,
          pausedUntil: null,
        },
      },
      { returnDocument: 'after' },
    );
    if (!battle) return null;
    await this.ctx.col.liveRooms.updateMany(
      { pkBattleId: battle._id },
      { $set: { pkBattleId: null } },
    );
    await Promise.all([
      this.ctx.livekit.unforwardParticipant(a.livekitRoom, a.uid, b.livekitRoom),
      this.ctx.livekit.unforwardParticipant(b.livekitRoom, b.uid, a.livekitRoom),
    ]).catch(() => undefined);
    await this.broadcast(battle, LIVEKIT_TOPICS.pkEnded, {
      contributors: await this.topContributors(battleId, 3),
    });
    await this.publishRooms(battle);
    return battle;
  }

  /**
   * A host leaves the battle. Pending: the inviter cancels, the invitee declines. Between rounds
   * the battle is settled on rounds won; during a live round, leaving forfeits.
   */
  async endByHost(battleId: ObjectId, uid: string) {
    const battle = await this.ctx.col.pkBattles.findOne({ _id: battleId });
    if (!battle) throw notFound('PK');
    if (!battle.participantUids.includes(uid)) throw forbidden();
    if (battle.status === 'pending') {
      if (battle.invitedBy === uid) return this.cancel(battleId, uid);
      await this.respond(battleId, uid, false);
      return;
    }
    if (battle.roundState === 'paused') await this.end(battleId, 'host_ended');
    else await this.end(battleId, 'forfeit', uid);
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
    return {
      battle: await this.present(battle),
      contributors: await this.topContributors(battle._id, 3),
    };
  }

  async get(battleId: ObjectId) {
    const battle = await this.ctx.col.pkBattles.findOne({ _id: battleId });
    if (!battle) throw notFound('PK');
    return {
      battle: await this.present(battle),
      contributors: await this.topContributors(battleId, 10),
    };
  }

  async list(
    filter: { status?: PkBattleDoc['status']; uid?: string },
    page: number,
    pageSize: number,
  ) {
    const q = {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.uid ? { participantUids: filter.uid } : {}),
    };
    const [docs, total] = await Promise.all([
      this.ctx.col.pkBattles
        .find(q)
        .sort({ createdAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
      this.ctx.col.pkBattles.countDocuments(q),
    ]);
    return { items: await Promise.all(docs.map((d) => this.present(d))), total, page, pageSize };
  }

  /**
   * Sweeper (every few seconds): expire stale invitations, close rounds past their deadline and
   * end battles whose between-rounds pause timed out.
   */
  async sweep(): Promise<{ expired: number; rounds: number; ended: number }> {
    const now = this.ctx.clock.now();
    let expired = 0;
    let rounds = 0;
    let ended = 0;
    const pending = await this.ctx.col.pkBattles
      .find({ status: 'pending', inviteExpiresAt: { $lte: now } }, { projection: { _id: 1 } })
      .limit(200)
      .toArray();
    for (const p of pending) {
      const res = await this.terminatePending(p._id, 'expired');
      if (res) {
        expired++;
        await this.broadcast(res, LIVEKIT_TOPICS.pkExpired);
      }
    }
    const due = await this.ctx.col.pkBattles
      .find(
        { status: 'active', roundState: 'live', endsAt: { $lte: now } },
        { projection: { _id: 1 } },
      )
      .limit(200)
      .toArray();
    for (const d of due) {
      const outcome = await this.closeRound(d._id);
      if (outcome) rounds++;
      if (outcome === 'ended') ended++;
    }
    const idle = await this.ctx.col.pkBattles
      .find(
        {
          $or: [
            { status: 'active', roundState: 'paused', pausedUntil: { $lte: now } },
            // Battles started before rounds existed end at their single deadline.
            { status: 'active', roundState: { $exists: false }, endsAt: { $lte: now } },
          ],
        },
        { projection: { _id: 1 } },
      )
      .limit(200)
      .toArray();
    for (const d of idle) if (await this.end(d._id, 'timeout')) ended++;
    return { expired, rounds, ended };
  }

  /**
   * Opponents for the PK picker: live video hosts other than the caller, excluding blocked
   * pairs. `friends` keeps mutual follows only. Busy hosts are listed but flagged.
   */
  async candidates(uid: string, tab: 'all' | 'friends', limit = 50) {
    const blocks = await this.ctx.col.blocks
      .find({ $or: [{ blockerId: uid }, { blockedId: uid }] })
      .limit(1000)
      .toArray();
    const hidden = blocks.map((b) => (b.blockerId === uid ? b.blockedId : b.blockerId));
    let hostFilter: { $nin: string[] } | { $in: string[] } = { $nin: [uid, ...hidden] };
    if (tab === 'friends') {
      const following = await this.ctx.col.follows
        .find({ followerId: uid }, { projection: { followeeId: 1 } })
        .limit(2000)
        .toArray();
      const mutual = await this.ctx.col.follows
        .find(
          { followerId: { $in: following.map((f) => f.followeeId) }, followeeId: uid },
          { projection: { followerId: 1 } },
        )
        .toArray();
      hostFilter = { $in: mutual.map((m) => m.followerId).filter((h) => !hidden.includes(h)) };
    }
    const rooms = await this.ctx.col.liveRooms
      .find({ status: 'live', type: 'video', hostId: hostFilter })
      .sort({ viewerCount: -1, startedAt: -1 })
      .limit(limit)
      .toArray();
    const busy = new Set<string>(
      await this.ctx.col.pkBattles.distinct('participantUids', {
        pkLive: true,
        participantUids: { $in: rooms.map((r) => r.hostId) },
      }),
    );
    const briefs = await this.ctx.services.users.briefs(rooms.map((r) => r.hostId));
    return rooms.flatMap((r) => {
      const user = briefs.get(r.hostId);
      return user
        ? [{ user, roomId: String(r._id), viewerCount: r.viewerCount, busy: busy.has(r.hostId) }]
        : [];
    });
  }
}
