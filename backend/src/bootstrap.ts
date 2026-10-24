import type { Redis } from 'ioredis';
import type { Env } from './config/env.js';
import type { Ctx } from './context.js';
import type { Database } from './db/mongo.js';
import type { AuthProvider, PushGateway } from './infra/firebase.js';
import type { IapGateway } from './infra/iap.js';
import type { LiveKitGateway } from './infra/livekit.js';
import type { StorageGateway } from './infra/storage.js';
import type { JobQueue } from './jobs/queue.js';
import type { Logger } from './lib/logger.js';
import { systemClock, type Clock } from './lib/time.js';
import { RealtimeBus } from './realtime/bus.js';
import { createServices } from './services.js';

export interface ContextDeps {
  env: Env;
  log: Logger;
  db: Database;
  redis: Redis | null;
  auth: AuthProvider;
  livekit: LiveKitGateway;
  push: PushGateway;
  storage: StorageGateway;
  iap: IapGateway;
  jobs: JobQueue;
  clock?: Clock;
}

/** Assemble the dependency container. Shared by the server entry point and the test harness. */
export function buildContext(deps: ContextDeps): Ctx {
  const ctx = {
    ...deps,
    col: deps.db.col,
    clock: deps.clock ?? systemClock,
    realtime: new RealtimeBus(),
  } as Omit<Ctx, 'services'> as Ctx;
  ctx.services = createServices(ctx);
  return ctx;
}
