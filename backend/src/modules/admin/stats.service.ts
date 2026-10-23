import type { Ctx } from '../../context.js';
import { addDays } from '../../lib/time.js';

/** Aggregates for the admin dashboard. Every query is index-backed and bounded by date. */
export class StatsService {
  constructor(private readonly ctx: Ctx) {}

  async overview() {
    const now = this.ctx.clock.now();
    const dayAgo = addDays(now, -1);
    const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const c = this.ctx.col;
    const sum = async (pipeline: object[], col: 'recharges' | 'giftTransactions') => {
      const coll = col === 'recharges' ? c.recharges : c.giftTransactions;
      const [row] = await coll.aggregate<{ total: number }>(pipeline as never[]).toArray();
      return row?.total ?? 0;
    };
    const [
      totalUsers,
      newToday,
      activeDay,
      liveNow,
      liveViewers,
      rechargedToday,
      giftsToday,
      pendingWithdrawals,
      openReports,
      agents,
      agencies,
    ] = await Promise.all([
      c.users.countDocuments({ status: { $ne: 'deleted' } }),
      c.users.countDocuments({ createdAt: { $gte: startOfToday } }),
      c.users.countDocuments({ lastSeenAt: { $gte: dayAgo } }),
      c.liveRooms.countDocuments({ status: 'live' }),
      c.liveRooms.aggregate<{ total: number }>([{ $match: { status: 'live' } }, { $group: { _id: null, total: { $sum: '$viewerCount' } } }]).toArray(),
      sum([{ $match: { createdAt: { $gte: startOfToday } } }, { $group: { _id: null, total: { $sum: '$diamonds' } } }], 'recharges'),
      sum([{ $match: { createdAt: { $gte: startOfToday } } }, { $group: { _id: null, total: { $sum: '$totalCost' } } }], 'giftTransactions'),
      c.withdrawals.countDocuments({ status: 'pending' }),
      c.reports.countDocuments({ status: 'open' }),
      c.users.countDocuments({ isAgent: true }),
      c.agencies.countDocuments({ status: 'active' }),
    ]);
    return {
      users: { total: totalUsers, newToday, activeDay },
      live: { rooms: liveNow, viewers: liveViewers[0]?.total ?? 0 },
      economy: { rechargedToday, giftsToday },
      queues: { pendingWithdrawals, openReports },
      network: { agents, agencies },
      generatedAt: now.toISOString(),
    };
  }

  /** Daily series for the last `days` days (UTC): signups, recharged diamonds, gift volume, live sessions. */
  async series(days: number) {
    const since = addDays(this.ctx.clock.now(), -days);
    const day = { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } };
    const [signups, recharges, gifts, lives] = await Promise.all([
      this.ctx.col.users.aggregate<{ _id: string; v: number }>([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: day, v: { $sum: 1 } } }]).toArray(),
      this.ctx.col.recharges.aggregate<{ _id: string; v: number }>([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: day, v: { $sum: '$diamonds' } } }]).toArray(),
      this.ctx.col.giftTransactions.aggregate<{ _id: string; v: number }>([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: day, v: { $sum: '$totalCost' } } }]).toArray(),
      this.ctx.col.liveRooms
        .aggregate<{ _id: string; v: number }>([{ $match: { startedAt: { $gte: since } } }, { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$startedAt' } }, v: { $sum: 1 } } }])
        .toArray(),
    ]);
    const index = (rows: { _id: string; v: number }[]) => new Map(rows.map((r) => [r._id, r.v]));
    const [s, r, g, l] = [index(signups), index(recharges), index(gifts), index(lives)];
    const out: { date: string; signups: number; recharged: number; gifts: number; lives: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = addDays(this.ctx.clock.now(), -i).toISOString().slice(0, 10);
      out.push({ date, signups: s.get(date) ?? 0, recharged: r.get(date) ?? 0, gifts: g.get(date) ?? 0, lives: l.get(date) ?? 0 });
    }
    return out;
  }
}
