/**
 * Populate a LOCAL database with realistic demo activity (users, recharges, gifts, live rooms,
 * reports, withdrawals, game rounds) so the dashboard and app have something to show.
 * Refuses to run when NODE_ENV=production. Run `npm run seed` first.
 *   npm run seed:demo
 */
import { ObjectId } from 'mongodb';
import { loadEnv } from '../src/config/env.js';
import type { UserDoc } from '../src/db/schema.js';
import { withDb } from './_db.js';

const env = loadEnv();
if (env.NODE_ENV === 'production') {
  console.error('demo-data refuses to run in production');
  process.exit(1);
}

const NAMES = ['Amira', 'Rafi', 'Nadia', 'Zayan', 'Tahsin', 'Lamia', 'Arif', 'Mehjabin', 'Sabbir', 'Farzana', 'Imran', 'Tania', 'Shuvo', 'Puja', 'Rakib', 'Nusrat', 'Fahim', 'Sadia', 'Tanvir', 'Mim'];
const COUNTRIES = ['BD', 'IN', 'AE', 'SA', 'MY', 'PK'];
const rand = (n: number) => Math.floor(Math.random() * n);
const pick = <T>(xs: readonly T[]) => xs[rand(xs.length)]!;
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000 - rand(86_400_000));

await withDb(async (db) => {
  const gifts = await db.col.gifts.find({ active: true }).toArray();
  if (!gifts.length) throw new Error('Run `npm run seed` first');
  const now = new Date();

  const users: UserDoc[] = NAMES.map((name, i) => {
    const recharged = rand(200_000);
    const received = rand(400_000);
    const createdAt = daysAgo(rand(60));
    return {
      _id: `demo_${i}`,
      shortId: String(30_000_000 + i),
      displayName: name,
      displayNameLower: name.toLowerCase(),
      avatarUrl: `https://i.pravatar.cc/200?u=bigboss${i}`,
      bio: 'Living the golden life ✨',
      gender: i % 2 ? 'male' : 'female',
      birthday: null,
      country: pick(COUNTRIES),
      email: `${name.toLowerCase()}@demo.bigboss`,
      phone: null,
      status: i === 7 ? 'banned' : 'active',
      ban: i === 7 ? { reason: 'Spam in live chat', until: null, by: 'demo', at: daysAgo(1) } : null,
      adminRole: null,
      isAgent: i % 6 === 0,
      wallet: { diamonds: rand(50_000), beans: rand(300_000), agentStock: i % 6 === 0 ? 500_000 + rand(500_000) : 0 },
      stats: { followers: rand(5000), following: rand(300), totalRecharged: recharged, totalReceived: received, totalSent: rand(100_000), liveSeconds: rand(400_000) },
      level: { level: Math.min(100, Math.floor((recharged + received) / 6000)), points: recharged + received },
      vip: i % 4 === 0 ? { tier: 1 + (i % 3), expiresAt: new Date(now.getTime() + 20 * 86_400_000) } : { tier: 0, expiresAt: null },
      equipped: { frameId: null, entryAnimationId: null, frameUrl: null },
      agencyId: null,
      liveRoomId: null,
      createdAt,
      updatedAt: createdAt,
      lastSeenAt: daysAgo(rand(3)),
      deletedAt: null,
    };
  });
  for (const u of users) await db.col.users.updateOne({ _id: u._id }, { $setOnInsert: u }, { upsert: true });

  // Live rooms: 6 live now, 30 ended.
  for (let i = 0; i < 36; i++) {
    const host = users[i % users.length]!;
    const live = i < 6 && host.status === 'active';
    const startedAt = live ? new Date(now.getTime() - rand(7200_000)) : daysAgo(rand(30));
    const id = new ObjectId();
    await db.col.liveRooms.insertOne({
      _id: id,
      hostId: host._id,
      type: i % 5 === 0 ? 'audio' : 'video',
      status: live ? 'live' : 'ended',
      title: pick(['Golden hour chat 🌅', 'Music night 🎶', 'Ask me anything', 'Late night vibes', 'PK tonight! ⚔️', 'Cooking live 🍲']),
      coverUrl: `https://picsum.photos/seed/bb${i}/400/600`,
      tags: [],
      country: host.country,
      livekitRoom: `bb_${host._id}_${startedAt.getTime()}_${i}`,
      viewerCount: live ? 20 + rand(900) : 0,
      peakViewers: 50 + rand(2000),
      giftBeans: rand(80_000),
      giftCount: rand(400),
      moderatorIds: [],
      seats: [{ index: 0, userId: host._id, muted: false, locked: false }],
      pkBattleId: null,
      backgroundUrl: null,
      startedAt,
      lastHeartbeatAt: live ? now : startedAt,
      endedAt: live ? null : new Date(startedAt.getTime() + 600_000 + rand(7200_000)),
      endReason: live ? null : pick(['host', 'stale', 'host', 'host'] as const),
      endedBy: null,
    }).catch(() => undefined);
    if (live) await db.col.users.updateOne({ _id: host._id }, { $set: { liveRoomId: id } });
  }

  // Recharges + gifts spread over 30 days.
  for (let i = 0; i < 300; i++) {
    const u = pick(users);
    const createdAt = daysAgo(rand(30));
    await db.col.recharges.insertOne({ userId: u._id, diamonds: pick([100, 520, 1100, 5800, 12000]), source: pick(['agent', 'iap', 'admin'] as const), agentId: null, adminId: null, note: null, idempotencyKey: `demo-r-${new ObjectId()}`, createdAt });
    const gift = pick(gifts);
    const receiver = pick(users.filter((x) => x._id !== u._id));
    const qty = 1 + rand(10);
    const cost = gift.price * qty;
    await db.col.giftTransactions.insertOne({
      _id: new ObjectId(),
      senderId: u._id,
      idempotencyKey: `demo-g-${new ObjectId()}`,
      giftId: gift._id,
      giftName: gift.name,
      unitPrice: gift.price,
      quantity: qty,
      receivers: [{ userId: receiver._id, cost, beans: Math.floor(cost * 0.7), platformFee: Math.floor(cost * 0.3), agencyFee: 0, agencyId: null }],
      totalCost: cost,
      roomId: null,
      pkBattleId: null,
      createdAt,
    });
  }

  // Reports & withdrawals.
  for (let i = 0; i < 8; i++) {
    await db.col.reports.insertOne({ _id: new ObjectId(), reporterId: users[i]!._id, targetType: 'user', targetId: users[(i + 3) % users.length]!._id, reason: pick(['spam', 'harassment', 'scam', 'nudity']), details: 'Reported from live chat', status: 'open', resolution: null, createdAt: daysAgo(rand(5)) }).catch(() => undefined);
  }
  for (let i = 0; i < 5; i++) {
    const u = users[i + 2]!;
    await db.col.withdrawals.insertOne({ _id: new ObjectId(), userId: u._id, beans: 50_000 + rand(200_000), amountUsd: 5 + rand(20), method: 'mobile_wallet', account: { provider: 'bKash', number: `017${10000000 + rand(89999999)}` }, status: 'pending', idempotencyKey: `demo-w-${new ObjectId()}`, note: null, reviewedBy: null, reviewedAt: null, createdAt: daysAgo(rand(4)) }).catch(() => undefined);
  }

  // An agency with a few hosts.
  const owner = users[1]!;
  if (!(await db.col.agencies.findOne({ ownerId: owner._id }))) {
    const agencyId = new ObjectId();
    await db.col.agencies.insertOne({ _id: agencyId, name: 'Golden Crown Agency', ownerId: owner._id, logoUrl: null, commissionRate: 0.05, status: 'active', memberCount: 4, createdAt: daysAgo(40), updatedAt: now });
    const period = new Intl.DateTimeFormat('en-CA', { timeZone: env.AGENCY_RESET_TIMEZONE, year: 'numeric', month: '2-digit' }).format(now).slice(0, 7);
    for (const u of users.slice(2, 6)) {
      await db.col.agencyMembers.insertOne({ agencyId, userId: u._id, joinedAt: daysAgo(30), periodKey: period, periodBeans: rand(200_000), periodLiveSeconds: rand(200_000) }).catch(() => undefined);
      await db.col.users.updateOne({ _id: u._id }, { $set: { agencyId } });
    }
  }

  await db.col.games.updateMany({}, { $set: { enabled: true } });
  console.log(`demo data ready: ${users.length} users, rooms, 300 recharges/gifts, reports, withdrawals, an agency; games enabled`);
});
