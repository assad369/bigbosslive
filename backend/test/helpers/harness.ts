import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import supertest from 'supertest';
import { inject } from 'vitest';
import type { AdminRole } from '@bigboss/shared';
import { createApp } from '../../src/app.js';
import { buildContext } from '../../src/bootstrap.js';
import { loadEnv } from '../../src/config/env.js';
import type { Ctx } from '../../src/context.js';
import { ensureIndexes } from '../../src/db/indexes.js';
import { wrapDb } from '../../src/db/mongo.js';
import type { UserDoc } from '../../src/db/schema.js';
import type { AuthProvider, PushGateway, PushMessage } from '../../src/infra/firebase.js';
import type { IapGateway } from '../../src/infra/iap.js';
import type { LiveKitGateway, TokenRequest } from '../../src/infra/livekit.js';
import type { StorageGateway } from '../../src/infra/storage.js';
import { InlineJobQueue } from '../../src/jobs/queue.js';
import { jobHandlers } from '../../src/jobs/scheduler.js';
import { createLogger } from '../../src/lib/logger.js';
import type { Clock } from '../../src/lib/time.js';

/** Controllable clock. Starts at a fixed instant so tests are deterministic. */
export class TestClock implements Clock {
  private t = new Date('2026-03-15T12:00:00.000Z').getTime();
  now() {
    return new Date(this.t);
  }
  advance(seconds: number) {
    this.t += seconds * 1000;
  }
  set(date: Date) {
    this.t = date.getTime();
  }
}

/** Token format understood by the fake verifier: `test:<uid>` or `test:<uid>:<adminRole>`. */
export const tokenFor = (uid: string, role?: AdminRole) => `test:${uid}${role ? `:${role}` : ''}`;

export class FakeAuth implements AuthProvider {
  roles = new Map<string, AdminRole | null>();
  revoked: string[] = [];
  deleted: string[] = [];
  async verifyIdToken(token: string) {
    const [prefix, uid, role] = token.split(':');
    if (prefix !== 'test' || !uid) throw new Error('bad token');
    const claim = this.roles.has(uid) ? this.roles.get(uid)! : ((role as AdminRole | undefined) ?? null);
    return { uid, email: `${uid}@example.com`, phone: null, name: `User ${uid}`, picture: null, adminRole: claim };
  }
  async setAdminRole(uid: string, role: AdminRole | null) {
    this.roles.set(uid, role);
  }
  async revokeSessions(uid: string) {
    this.revoked.push(uid);
  }
  async deleteUser(uid: string) {
    this.deleted.push(uid);
  }
}

export class FakeLiveKit implements LiveKitGateway {
  readonly url = 'wss://livekit.test';
  tokens: TokenRequest[] = [];
  data: { room: string; topic: string; payload: unknown; identities?: string[] }[] = [];
  removed: { room: string; identity: string }[] = [];
  permissions: { room: string; identity: string; canPublish: boolean }[] = [];
  deletedRooms: string[] = [];
  forwards: { src: string; identity: string; dest: string; active: boolean }[] = [];
  webhookEvent: unknown = null;

  async createToken(req: TokenRequest) {
    this.tokens.push(req);
    return `lk-token-${req.identity}-${req.room}`;
  }
  async sendData(room: string, topic: string, payload: unknown, identities?: string[]) {
    this.data.push({ room, topic, payload, ...(identities ? { identities } : {}) });
  }
  async removeParticipant(room: string, identity: string) {
    this.removed.push({ room, identity });
  }
  async updateParticipantPermissions(room: string, identity: string, canPublish: boolean) {
    this.permissions.push({ room, identity, canPublish });
  }
  async deleteRoom(room: string) {
    this.deletedRooms.push(room);
  }
  async forwardParticipant(src: string, identity: string, dest: string) {
    this.forwards.push({ src, identity, dest, active: true });
  }
  async unforwardParticipant(src: string, identity: string, dest: string) {
    this.forwards.push({ src, identity, dest, active: false });
  }
  async receiveWebhook(body: string, auth: string | undefined) {
    if (auth !== 'valid-signature') throw new Error('bad signature');
    return JSON.parse(body);
  }
  topics(topic: string) {
    return this.data.filter((d) => d.topic === topic);
  }
}

export class FakePush implements PushGateway {
  sent: { tokens: string[]; message: PushMessage }[] = [];
  invalid = new Set<string>();
  async sendToTokens(tokens: string[], message: PushMessage) {
    this.sent.push({ tokens, message });
    const invalidTokens = tokens.filter((t) => this.invalid.has(t));
    return { successCount: tokens.length - invalidTokens.length, failureCount: invalidTokens.length, invalidTokens };
  }
}

export const fakeStorage: StorageGateway = {
  async presignUpload({ folder, ownerId, contentType, ext }) {
    const key = `${folder}/${ownerId}/${randomUUID()}.${ext}`;
    return { uploadUrl: `https://s3.test/${key}?sig=1`, publicUrl: `https://cdn.test/${key}`, key, expiresIn: 300, headers: { 'Content-Type': contentType } };
  },
};

export class FakeIap implements IapGateway {
  google = new Map<string, { productId: string; orderId: string }>();
  apple = new Map<string, { productId: string }>();
  consumed: string[] = [];
  async verifyGoogle(productId: string, token: string) {
    const p = this.google.get(token);
    if (!p || p.productId !== productId) throw Object.assign(new Error('invalid'), { status: 402 });
    return { store: 'google' as const, productId, transactionId: p.orderId };
  }
  async consumeGoogle(_productId: string, token: string) {
    this.consumed.push(token);
  }
  async verifyApple(transactionId: string) {
    const p = this.apple.get(transactionId);
    if (!p) throw new Error('invalid');
    return { store: 'apple' as const, productId: p.productId, transactionId };
  }
}

export interface Harness {
  ctx: Ctx;
  api: ReturnType<typeof supertest>;
  clock: TestClock;
  auth: FakeAuth;
  livekit: FakeLiveKit;
  push: FakePush;
  iap: FakeIap;
  jobs: InlineJobQueue;
  client: MongoClient;
  /** Insert a user directly (bypassing the API) with optional overrides. */
  user(uid: string, overrides?: DeepPartial<UserDoc>): Promise<UserDoc>;
  as(uid: string, role?: AdminRole): { Authorization: string };
  close(): Promise<void>;
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends Date ? T[K] : DeepPartial<T[K]>) : T[K] };

let shortIdSeq = 20_000_000;

export async function createHarness(): Promise<Harness> {
  const uri = inject('mongoUri');
  const client = new MongoClient(uri);
  await client.connect();
  const db = wrapDb(client, `bb_test_${randomUUID().replace(/-/g, '').slice(0, 16)}`);
  await ensureIndexes(db);

  const env = loadEnv({ NODE_ENV: 'test', MONGODB_URI: uri, LOG_LEVEL: 'silent', AGENCY_RESET_TIMEZONE: 'UTC' });
  const log = createLogger({ level: process.env.LOG_LEVEL ?? 'silent' });
  const clock = new TestClock();
  const auth = new FakeAuth();
  const livekit = new FakeLiveKit();
  const push = new FakePush();
  const iap = new FakeIap();
  const jobs = new InlineJobQueue(log);

  const ctx = buildContext({ env, log, db, redis: null, auth, livekit, push, storage: fakeStorage, iap, jobs, clock });
  jobs.setHandlers(jobHandlers(ctx));
  const app = createApp(ctx);

  const user = async (uid: string, o: DeepPartial<UserDoc> = {}): Promise<UserDoc> => {
    const now = clock.now();
    const doc: UserDoc = {
      _id: uid,
      shortId: o.shortId ?? String(shortIdSeq++),
      displayName: o.displayName ?? `User ${uid}`,
      displayNameLower: (o.displayName ?? `User ${uid}`).toLowerCase(),
      avatarUrl: null,
      bio: '',
      gender: null,
      birthday: null,
      country: o.country ?? 'BD',
      email: null,
      phone: null,
      status: o.status ?? 'active',
      ban: null,
      adminRole: o.adminRole ?? null,
      isAgent: o.isAgent ?? false,
      wallet: { diamonds: 0, beans: 0, agentStock: 0, ...o.wallet },
      stats: { followers: 0, following: 0, totalRecharged: 0, totalReceived: 0, totalSent: 0, liveSeconds: 0, ...o.stats },
      level: { level: 0, points: 0, ...o.level },
      vip: { tier: 0, expiresAt: null, ...o.vip } as UserDoc['vip'],
      equipped: { frameId: null, entryAnimationId: null, frameUrl: null },
      agencyId: null,
      liveRoomId: null,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
      deletedAt: null,
    };
    await db.col.users.insertOne(doc);
    return doc;
  };

  return {
    ctx,
    api: supertest(app),
    clock,
    auth,
    livekit,
    push,
    iap,
    jobs,
    client,
    user,
    as: (uid, role) => ({ Authorization: `Bearer ${tokenFor(uid, role)}` }),
    async close() {
      await jobs.drain();
      await db.db.dropDatabase();
      await client.close();
    },
  };
}

let keySeq = 0;
/** Fresh idempotency key. */
export const key = () => `test-key-${Date.now()}-${keySeq++}`;
