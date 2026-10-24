import { createServer } from 'node:http';
import { Redis } from 'ioredis';
import client from 'prom-client';
import { createApp } from './app.js';
import { buildContext } from './bootstrap.js';
import { loadEnv } from './config/env.js';
import { ensureIndexes } from './db/indexes.js';
import { connectMongo } from './db/mongo.js';
import { createFcmGateway, createFirebaseAuth, noopPush } from './infra/firebase.js';
import { createIapGateway } from './infra/iap.js';
import { createLiveKitGateway } from './infra/livekit.js';
import { createS3Storage } from './infra/storage.js';
import { BullJobQueue, InlineJobQueue } from './jobs/queue.js';
import { jobHandlers, TickScheduler } from './jobs/scheduler.js';
import { createLogger } from './lib/logger.js';
import { attachSocketServer } from './realtime/socket.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const log = createLogger({ level: env.LOG_LEVEL, pretty: env.NODE_ENV === 'development' });
  client.collectDefaultMetrics({ prefix: 'bb_' });

  const db = await connectMongo(env.MONGODB_URI, env.MONGODB_DB);
  await ensureIndexes(db);
  log.info('mongo connected, indexes ensured');

  // BullMQ requires maxRetriesPerRequest: null on its connections.
  const redis = env.REDIS_URL
    ? new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: true })
    : null;
  const bullConnection = env.REDIS_URL ? { url: env.REDIS_URL, maxRetriesPerRequest: null } : null;

  const firebaseConfigured = Boolean(env.FIREBASE_PROJECT_ID);
  const jobs = bullConnection ? new BullJobQueue(bullConnection, log) : new InlineJobQueue(log);

  const ctx = buildContext({
    env,
    log,
    db,
    redis,
    auth: firebaseConfigured
      ? createFirebaseAuth(env)
      : {
          verifyIdToken: () => Promise.reject(new Error('Firebase is not configured')),
          setAdminRole: () => Promise.reject(new Error('Firebase is not configured')),
          revokeSessions: async () => undefined,
          deleteUser: async () => undefined,
        },
    livekit: createLiveKitGateway(env),
    push: firebaseConfigured ? createFcmGateway(env) : noopPush,
    storage: createS3Storage(env),
    iap: createIapGateway(env),
    jobs,
  });
  if (!firebaseConfigured)
    log.warn('FIREBASE_PROJECT_ID not set — authentication will reject every request');

  await ctx.services.games.ensureRegistry();

  const handlers = jobHandlers(ctx);
  const scheduler = new TickScheduler(ctx);
  if (env.JOBS_ENABLED) {
    if (jobs instanceof BullJobQueue) jobs.startWorker(handlers);
    await scheduler.start(bullConnection);
  }
  if (jobs instanceof InlineJobQueue) jobs.setHandlers(handlers);

  const app = createApp(ctx);
  const server = createServer(app);
  // Keep-alive longer than typical load-balancer idle timeouts (60s) to avoid 502s.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  const io = attachSocketServer(ctx, server);

  server.listen(env.PORT, () =>
    log.info({ port: env.PORT, env: env.NODE_ENV }, 'BigBoss Live API listening'),
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 25_000);
    force.unref();
    try {
      await new Promise<void>((resolve) => io.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await scheduler.stop();
      await jobs.close();
      await redis?.quit();
      await db.close();
      log.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => log.error({ err }, 'unhandled rejection'));
}

main().catch((err: unknown) => {
  console.error('fatal startup error', err);
  process.exit(1);
});
