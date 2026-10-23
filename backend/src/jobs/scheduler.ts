import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { ObjectId } from 'mongodb';
import type { Ctx } from '../context.js';
import type { JobHandlers } from './queue.js';

/** Handlers for one-off jobs enqueued by services. */
export function jobHandlers(ctx: Ctx): JobHandlers {
  return {
    'announcement.send': ({ announcementId }) =>
      ctx.services.notifications.sendAnnouncement(new ObjectId(announcementId)),
    'push.user': async ({ userId, title, body, data }) => {
      await ctx.services.notifications.pushToUsers([userId], {
        title,
        body,
        ...(data ? { data } : {}),
      });
    },
    'push.followers': ({ hostId, roomId }) =>
      ctx.services.notifications.pushFollowersGoLive(hostId, roomId),
  };
}

/**
 * Recurring work. With BullMQ, a repeatable job fires once per interval across the whole
 * cluster no matter how many replicas run a worker — the deployment is leader-free.
 */
export const TICKS: { name: string; everyMs: number; run: (ctx: Ctx) => Promise<unknown> }[] = [
  { name: 'games.tick', everyMs: 1_000, run: (ctx) => ctx.services.games.tick() },
  { name: 'pk.sweep', everyMs: 2_000, run: (ctx) => ctx.services.pk.sweep() },
  { name: 'live.sweep', everyMs: 30_000, run: (ctx) => ctx.services.live.sweepStale() },
  { name: 'store.sweep', everyMs: 60 * 60_000, run: (ctx) => ctx.services.store.sweepExpired() },
  // Hourly is enough: members are also rolled lazily on their first earning in a new month.
  {
    name: 'agencies.reset',
    everyMs: 60 * 60_000,
    run: (ctx) => ctx.services.agencies.monthlyReset(),
  },
];

const TICK_QUEUE = 'bb-ticks';

export class TickScheduler {
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly ctx: Ctx) {}

  async start(connection: ConnectionOptions | null): Promise<void> {
    if (!connection) {
      // No Redis (local dev): run ticks in-process. Do not run more than one such replica.
      this.ctx.log.warn('REDIS_URL not set — running scheduled jobs in-process');
      for (const t of TICKS) {
        let running = false;
        this.timers.push(
          setInterval(() => {
            if (running) return;
            running = true;
            t.run(this.ctx)
              .catch((err: unknown) => this.ctx.log.error({ err, job: t.name }, 'tick failed'))
              .finally(() => (running = false));
          }, t.everyMs),
        );
      }
      return;
    }
    this.queue = new Queue(TICK_QUEUE, {
      connection,
      defaultJobOptions: { removeOnComplete: true, removeOnFail: 100 },
    });
    for (const t of TICKS) {
      await this.queue.upsertJobScheduler(t.name, { every: t.everyMs }, { name: t.name });
    }
    const byName = new Map(TICKS.map((t) => [t.name, t]));
    this.worker = new Worker(
      TICK_QUEUE,
      async (job) => {
        await byName.get(job.name)?.run(this.ctx);
      },
      { connection, concurrency: TICKS.length },
    );
    this.worker.on('failed', (job, err) =>
      this.ctx.log.error({ err, job: job?.name }, 'tick failed'),
    );
  }

  async stop(): Promise<void> {
    this.timers.forEach(clearInterval);
    await this.worker?.close();
    await this.queue?.close();
  }
}
