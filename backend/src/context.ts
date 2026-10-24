import type { Redis } from 'ioredis';
import type { Env } from './config/env.js';
import type { Collections, Database } from './db/mongo.js';
import type { AuthProvider, PushGateway } from './infra/firebase.js';
import type { IapGateway } from './infra/iap.js';
import type { LiveKitGateway } from './infra/livekit.js';
import type { StorageGateway } from './infra/storage.js';
import type { Logger } from './lib/logger.js';
import type { Clock } from './lib/time.js';
import type { RealtimeBus } from './realtime/bus.js';
import type { JobQueue } from './jobs/queue.js';
import type { Services } from './services.js';

/**
 * The dependency container handed to every service and router. Infrastructure is behind
 * interfaces so tests can swap Firebase, LiveKit, FCM and S3 for in-memory fakes.
 */
export interface Ctx {
  env: Env;
  log: Logger;
  db: Database;
  col: Collections;
  clock: Clock;
  redis: Redis | null;
  auth: AuthProvider;
  livekit: LiveKitGateway;
  push: PushGateway;
  storage: StorageGateway;
  iap: IapGateway;
  realtime: RealtimeBus;
  jobs: JobQueue;
  services: Services;
}
