import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { Logger } from '../lib/logger.js';

/** One-off background jobs. Recurring "tick" jobs are registered in `jobs/scheduler.ts`. */
export interface JobPayloads {
  'announcement.send': { announcementId: string };
  'push.user': { userId: string; title: string; body: string; data?: Record<string, string> };
  'push.followers': { hostId: string; roomId: string };
}
export type JobName = keyof JobPayloads;
export type JobHandlers = { [K in JobName]: (data: JobPayloads[K]) => Promise<void> };

export interface JobQueue {
  enqueue<K extends JobName>(name: K, data: JobPayloads[K]): Promise<void>;
  close(): Promise<void>;
}

const QUEUE = 'bb-tasks';

/** BullMQ-backed queue: retries with exponential backoff, survives restarts. */
export class BullJobQueue implements JobQueue {
  private queue: Queue;
  private worker: Worker | null = null;

  constructor(
    private readonly connection: ConnectionOptions,
    private readonly log: Logger,
  ) {
    this.queue = new Queue(QUEUE, {
      connection,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 7 * 86400 },
      },
    });
  }

  async enqueue<K extends JobName>(name: K, data: JobPayloads[K]): Promise<void> {
    await this.queue.add(name, data);
  }

  startWorker(handlers: JobHandlers): void {
    this.worker = new Worker(
      QUEUE,
      async (job) => {
        const handler = handlers[job.name as JobName] as ((d: unknown) => Promise<void>) | undefined;
        if (!handler) throw new Error(`No handler for job ${job.name}`);
        await handler(job.data);
      },
      { connection: this.connection, concurrency: 8 },
    );
    this.worker.on('failed', (job, err) =>
      this.log.error({ err, job: job?.name, id: job?.id }, 'background job failed'),
    );
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
  }
}

/**
 * Runs jobs in-process, after the current tick. Used when Redis is not configured (local dev)
 * and in tests, where `drain()` awaits everything enqueued so far.
 */
export class InlineJobQueue implements JobQueue {
  private handlers: JobHandlers | null = null;
  private pending: Promise<void>[] = [];

  constructor(private readonly log: Logger) {}

  setHandlers(handlers: JobHandlers): void {
    this.handlers = handlers;
  }

  async enqueue<K extends JobName>(name: K, data: JobPayloads[K]): Promise<void> {
    const handler = this.handlers?.[name] as ((d: JobPayloads[K]) => Promise<void>) | undefined;
    if (!handler) return;
    const p = Promise.resolve()
      .then(() => handler(data))
      .catch((err: unknown) => this.log.error({ err, job: name }, 'inline job failed'));
    this.pending.push(p);
  }

  async drain(): Promise<void> {
    while (this.pending.length) {
      const batch = this.pending.splice(0);
      await Promise.all(batch);
    }
  }

  async close(): Promise<void> {
    await this.drain();
  }
}
