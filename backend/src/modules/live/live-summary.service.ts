import type { ObjectId } from 'mongodb';
import type {
  LiveHistoryDay,
  LiveHistoryItem,
  LiveHistoryMonth,
  LiveSummary,
} from '@bigboss/shared';
import type { Ctx } from '../../context.js';
import type { LiveRoomDoc, LiveSummaryDoc } from '../../db/schema.js';
import { AppError, badRequest, forbidden } from '../../lib/errors.js';

/**
 * Gifts sent just before a live ends can commit a moment after it. A summary read within this
 * window after the end is computed fresh and marked `final: false`; the first read after it
 * freezes the result on the room.
 */
export const SUMMARY_SETTLE_MS = 60_000;

/** Upper bound on the lives one month of history returns (one every ~45 minutes). */
const MONTH_LIMIT = 1000;

const TZ_PATTERN = /^([+-])(0\d|1[0-4]):([0-5]\d)$/;
const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** `+06:00` → 360. */
export function parseOffset(tz: string): number {
  const m = TZ_PATTERN.exec(tz);
  if (!m) throw badRequest('tz must look like +06:00');
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === '-' ? -minutes : minutes;
}

/** The `YYYY-MM-DD` and `YYYY-MM` of [date] at a fixed UTC offset. */
function localDate(date: Date, offsetMin: number): string {
  return new Date(date.getTime() + offsetMin * 60_000).toISOString().slice(0, 10);
}

function durationSec(r: Pick<LiveRoomDoc, 'startedAt' | 'endedAt'>): number {
  return r.endedAt
    ? Math.max(0, Math.round((r.endedAt.getTime() - r.startedAt.getTime()) / 1000))
    : 0;
}

function historyItem(r: LiveRoomDoc): LiveHistoryItem {
  return {
    id: String(r._id),
    type: r.type,
    title: r.title,
    startedAt: r.startedAt.toISOString(),
    endedAt: r.endedAt?.toISOString() ?? null,
    durationSec: durationSec(r),
    peakViewers: r.peakViewers,
    giftDiamonds: r.giftDiamonds,
    endReason: r.endReason,
  };
}

type Computed = Omit<LiveSummaryDoc, 'finalizedAt'>;

/**
 * A host's broadcasting history by month, and the summary of one ended live. Read-only over
 * `live_rooms`, `gift_transactions` and `follows`, except the one-time freeze of `summary`.
 */
export class LiveSummaryService {
  constructor(private readonly ctx: Ctx) {}

  /**
   * One month of a host's ended lives, grouped by the local day each one started (a live that
   * crosses midnight counts toward its first day). [month] is `YYYY-MM` (default: this month)
   * and [tz] the viewer's UTC offset, `±HH:mm`.
   */
  async monthly(hostId: string, month: string | undefined, tz: string): Promise<LiveHistoryMonth> {
    const offsetMin = parseOffset(tz);
    const key = month ?? localDate(this.ctx.clock.now(), offsetMin).slice(0, 7);
    const m = MONTH_PATTERN.exec(key);
    if (!m) throw badRequest('month must look like 2026-11');
    const [year, mon] = [Number(m[1]), Number(m[2])];
    const shift = offsetMin * 60_000;
    const from = new Date(Date.UTC(year, mon - 1, 1) - shift);
    const to = new Date(Date.UTC(year, mon, 1) - shift);

    const [rooms, first] = await Promise.all([
      this.ctx.col.liveRooms
        .find({ hostId, status: 'ended', startedAt: { $gte: from, $lt: to } })
        .sort({ startedAt: -1, _id: -1 })
        .limit(MONTH_LIMIT)
        .toArray(),
      this.ctx.col.liveRooms.findOne(
        { hostId, status: 'ended' },
        { sort: { startedAt: 1 }, projection: { startedAt: 1 } },
      ),
    ]);

    const days = new Map<string, LiveHistoryDay>();
    for (const r of rooms) {
      const date = localDate(r.startedAt, offsetMin);
      let day = days.get(date);
      if (!day) {
        day = { date, totalSeconds: 0, sessionCount: 0, peakViewers: 0, diamonds: 0, sessions: [] };
        days.set(date, day);
      }
      const item = historyItem(r);
      day.totalSeconds += item.durationSec;
      day.sessionCount += 1;
      day.peakViewers = Math.max(day.peakViewers, item.peakViewers);
      day.diamonds += item.giftDiamonds;
      day.sessions.push(item);
    }
    const list = [...days.values()];
    return {
      month: key,
      totalSeconds: list.reduce((n, d) => n + d.totalSeconds, 0),
      sessionCount: rooms.length,
      liveDays: list.length,
      diamonds: list.reduce((n, d) => n + d.diamonds, 0),
      earliestMonth: first ? localDate(first.startedAt, offsetMin).slice(0, 7) : null,
      days: list,
    };
  }

  /** The summary of an ended live, for its host or staff (`live.read`). */
  async summary(
    roomId: ObjectId,
    viewer: { uid: string; canReadAll: boolean },
  ): Promise<LiveSummary> {
    const room = await this.ctx.services.live.get(roomId);
    if (room.hostId !== viewer.uid && !viewer.canReadAll)
      throw forbidden('Only the host can see this summary');
    if (room.status === 'live' || !room.endedAt)
      throw new AppError(409, 'live_running', 'This live has not ended yet');

    const now = this.ctx.clock.now();
    let snapshot: Computed = room.summary ?? (await this.compute(room));
    const final =
      Boolean(room.summary) || now.getTime() - room.endedAt.getTime() >= SUMMARY_SETTLE_MS;
    if (final && !room.summary) {
      // Freeze once; a concurrent reader that froze first wins and is what we return.
      const frozen: LiveSummaryDoc = { ...snapshot, finalizedAt: now };
      const res = await this.ctx.col.liveRooms.findOneAndUpdate(
        // `summary: null` also matches rooms where the field is absent.
        { _id: room._id, summary: null },
        { $set: { summary: frozen } },
        { returnDocument: 'after', projection: { summary: 1 } },
      );
      if (!res) {
        const winner = await this.ctx.col.liveRooms.findOne(
          { _id: room._id },
          { projection: { summary: 1 } },
        );
        if (winner?.summary) snapshot = winner.summary;
      }
    }
    return this.present(room, snapshot, final);
  }

  /** Gift totals over `gift_transactions` and new followers during the live. */
  private async compute(room: LiveRoomDoc): Promise<Computed> {
    const hostId = room.hostId;
    const isHost = { $eq: ['$receivers.userId', hostId] };
    const [agg, newFollowers] = await Promise.all([
      this.ctx.col.giftTransactions
        .aggregate<{
          totals: {
            roomDiamonds: number;
            giftCount: number;
            gifters: number;
            hostDiamonds: number;
            hostEarnings: number;
          }[];
          topGifters: { _id: string; diamonds: number; gifts: number }[];
          topGifts: { _id: ObjectId; giftName: string; count: number; diamonds: number }[];
        }>([
          { $match: { roomId: room._id } },
          { $unwind: '$receivers' },
          {
            $facet: {
              totals: [
                {
                  $group: {
                    _id: null,
                    roomDiamonds: { $sum: '$receivers.cost' },
                    giftCount: { $sum: '$quantity' },
                    gifters: { $addToSet: '$senderId' },
                    hostDiamonds: { $sum: { $cond: [isHost, '$receivers.cost', 0] } },
                    hostEarnings: { $sum: { $cond: [isHost, '$receivers.diamonds', 0] } },
                  },
                },
                { $set: { gifters: { $size: '$gifters' } } },
              ],
              topGifters: [
                {
                  $group: {
                    _id: '$senderId',
                    diamonds: { $sum: '$receivers.cost' },
                    gifts: { $sum: '$quantity' },
                  },
                },
                { $sort: { diamonds: -1, _id: 1 } },
                { $limit: 10 },
              ],
              topGifts: [
                {
                  $group: {
                    _id: '$giftId',
                    giftName: { $last: '$giftName' },
                    count: { $sum: '$quantity' },
                    diamonds: { $sum: '$receivers.cost' },
                  },
                },
                { $sort: { diamonds: -1, _id: 1 } },
                { $limit: 5 },
              ],
            },
          },
        ])
        .toArray(),
      this.ctx.col.follows.countDocuments({
        followeeId: hostId,
        createdAt: { $gte: room.startedAt, $lte: room.endedAt ?? this.ctx.clock.now() },
      }),
    ]);
    const facet = agg[0];
    const totals = facet?.totals[0];
    return {
      roomDiamonds: totals?.roomDiamonds ?? 0,
      giftCount: totals?.giftCount ?? 0,
      gifters: totals?.gifters ?? 0,
      hostDiamonds: totals?.hostDiamonds ?? 0,
      hostEarnings: totals?.hostEarnings ?? 0,
      newFollowers,
      topGifters: (facet?.topGifters ?? []).map((g) => ({
        userId: g._id,
        diamonds: g.diamonds,
        gifts: g.gifts,
      })),
      topGifts: (facet?.topGifts ?? []).map((g) => ({
        giftId: g._id,
        giftName: g.giftName,
        count: g.count,
        diamonds: g.diamonds,
      })),
    };
  }

  private async present(room: LiveRoomDoc, s: Computed, final: boolean): Promise<LiveSummary> {
    const [briefs, gifts] = await Promise.all([
      this.ctx.services.users.briefs(s.topGifters.map((g) => g.userId)),
      s.topGifts.length
        ? this.ctx.col.gifts
            .find({ _id: { $in: s.topGifts.map((g) => g.giftId) } }, { projection: { iconUrl: 1 } })
            .toArray()
        : Promise.resolve([]),
    ]);
    const icons = new Map(gifts.map((g) => [String(g._id), g.iconUrl]));
    return {
      roomId: String(room._id),
      type: room.type,
      title: room.title,
      coverUrl: room.coverUrl,
      startedAt: room.startedAt.toISOString(),
      endedAt: (room.endedAt ?? room.startedAt).toISOString(),
      endReason: room.endReason,
      durationSec: durationSec(room),
      final,
      audience: {
        peakViewers: room.peakViewers,
        totalJoins: room.totalJoins ?? null,
        uniqueViewers: room.uniqueViewers ?? null,
        newFollowers: s.newFollowers,
      },
      engagement: {
        chatMessages: room.chatMessages ?? null,
        reactions: room.reactions ?? null,
      },
      gifts: {
        hostDiamonds: s.hostDiamonds,
        hostEarnings: s.hostEarnings,
        roomDiamonds: s.roomDiamonds,
        giftCount: s.giftCount,
        gifters: s.gifters,
        topGifters: s.topGifters.map((g, i) => ({
          rank: i + 1,
          user: briefs.get(g.userId) ?? null,
          diamonds: g.diamonds,
          gifts: g.gifts,
        })),
        topGifts: s.topGifts.map((g) => ({
          gift: {
            id: String(g.giftId),
            name: g.giftName,
            iconUrl: icons.get(String(g.giftId)) ?? null,
          },
          count: g.count,
          diamonds: g.diamonds,
        })),
      },
    };
  }
}
