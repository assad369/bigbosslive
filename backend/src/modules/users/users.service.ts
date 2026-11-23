import { z } from 'zod';
import {
  ASSIGNABLE_SHORT_ID_PATTERN,
  CURRENT_TERMS_VERSION,
  FIRST_SHORT_ID,
  SHORT_ID_PATTERN,
} from '@bigboss/shared';
import type { Filter } from 'mongodb';
import type { Ctx } from '../../context.js';
import type { UserDoc } from '../../db/schema.js';
import type { VerifiedToken } from '../../infra/firebase.js';
import { AppError, badRequest, conflict, isDuplicateKeyError, notFound } from '../../lib/errors.js';
import { AGENCY_LOGO_FOLDER } from '../agencies/agencies.service.js';
import { CHAT_MEDIA_FOLDER } from '../chat/chat.service.js';
import { VOICE_FOLDER } from '../live/live.service.js';
import { invalidBirthday, plausibleBirthday } from './age.js';
import { BRIEF_PROJECTION, toPublicUser, toUserBrief, type UserBrief } from './users.presenter.js';

export const profileInput = z.object({
  displayName: z.string().trim().min(2).max(30),
  avatarUrl: z.url().max(2048).nullable(),
  bio: z.string().trim().max(160),
  gender: z.enum(['male', 'female', 'other']).nullable(),
  birthday: z.coerce.date().nullable(),
  country: z.string().trim().length(2).toUpperCase().nullable(),
});
export type ProfileInput = z.infer<typeof profileInput>;

export const consentInput = z.object({
  /** Optional (older apps): a first date of birth, checked like `PATCH /me`. Calendar date. */
  birthday: z.coerce.date().nullable().default(null),
  termsVersion: z.string().min(1).max(32),
});

/** Every folder a user's own uploads live in (`<folder>/<uid>/…`), erased on deletion. */
const USER_UPLOAD_FOLDERS = [
  'avatars',
  'covers',
  'posts',
  CHAT_MEDIA_FOLDER,
  'reports',
  VOICE_FOLDER,
  AGENCY_LOGO_FOLDER,
];

/** Stored dates of birth are UTC midnight of the calendar day the user picked. */
const dayOnly = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/**
 * Accounts are numbered from FIRST_SHORT_ID on their own counter. The pre-switch counter
 * (`user_short_id`, based at 10,000,000) is left untouched, so old and new ids never overlap.
 */
const SHORT_ID_COUNTER = 'user_short_id_v2';

export class UsersService {
  constructor(private readonly ctx: Ctx) {}

  private get col() {
    return this.ctx.col.users;
  }

  async get(uid: string): Promise<UserDoc> {
    const user = await this.col.findOne({ _id: uid });
    if (!user || user.status === 'deleted') throw notFound('User');
    return user;
  }

  /**
   * Find an active user by the public short id people type, or by uid. Short ids are tried
   * first for all-digit input; the uid is the fallback either way.
   */
  async resolve(identifier: string): Promise<UserDoc> {
    const id = identifier.trim();
    const byShortId = SHORT_ID_PATTERN.test(id)
      ? await this.col.findOne({ shortId: id, status: 'active' })
      : null;
    const user = byShortId ?? (await this.col.findOne({ _id: id, status: 'active' }));
    if (!user) throw notFound('User');
    return user;
  }

  async briefs(uids: string[]): Promise<Map<string, UserBrief>> {
    const unique = [...new Set(uids)];
    if (!unique.length) return new Map();
    const docs = await this.col
      .find({ _id: { $in: unique } }, { projection: BRIEF_PROJECTION })
      .toArray();
    const now = this.ctx.clock.now();
    return new Map(docs.map((d) => [d._id, toUserBrief(d as UserDoc, now)]));
  }

  private async nextShortId(): Promise<string> {
    const res = await this.ctx.col.counters.findOneAndUpdate(
      { _id: SHORT_ID_COUNTER },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: 'after' },
    );
    return String(FIRST_SHORT_ID + (res?.seq ?? 1) - 1);
  }

  /**
   * Idempotent session bootstrap: creates the profile on first sign-in, otherwise refreshes
   * identity fields from the verified token. Safe to call on every app launch.
   */
  async ensureProfile(
    token: VerifiedToken,
    input: Partial<ProfileInput> = {},
  ): Promise<{ user: UserDoc; created: boolean }> {
    const existing = await this.col.findOne({ _id: token.uid });
    const now = this.ctx.clock.now();
    if (existing) {
      if (existing.status === 'deleted')
        throw conflict('This account was deleted', 'account_deleted');
      const $set: Partial<UserDoc> = { lastSeenAt: now, adminRole: token.adminRole };
      if (token.email && token.email !== existing.email) $set.email = token.email;
      if (token.phone && token.phone !== existing.phone) $set.phone = token.phone;
      await this.col.updateOne({ _id: token.uid }, { $set });
      return { user: { ...existing, ...$set }, created: false };
    }

    if (input.birthday && !plausibleBirthday(input.birthday, now)) throw invalidBirthday();
    const displayName = await this.ctx.services.moderation.cleanText(
      input.displayName ?? token.name ?? `Boss${Math.floor(Math.random() * 1e6)}`,
    );
    // Signup fields get the same checks as later edits (`updateProfile`).
    const bio = input.bio ? await this.ctx.services.moderation.assertClean(input.bio, 'bio') : '';
    const sightguard = this.ctx.services.sightguard;
    if (input.bio)
      await sightguard.assertText('bio', input.bio, token.uid, {
        type: 'profile',
        uid: token.uid,
        field: 'bio',
      });
    if (input.avatarUrl)
      await sightguard.assertImageUrl('avatar', input.avatarUrl, token.uid, {
        type: 'avatar',
        uid: token.uid,
        url: input.avatarUrl,
      });
    for (let attempt = 0; attempt < 3; attempt++) {
      const doc: UserDoc = {
        _id: token.uid,
        shortId: await this.nextShortId(),
        displayName: displayName.slice(0, 30),
        displayNameLower: displayName.slice(0, 30).toLowerCase(),
        avatarUrl: input.avatarUrl ?? token.picture ?? null,
        bio,
        gender: input.gender ?? null,
        birthday: input.birthday ? dayOnly(input.birthday) : null,
        country: input.country ?? null,
        email: token.email,
        phone: token.phone,
        status: 'active',
        ban: null,
        adminRole: token.adminRole,
        isAgent: false,
        wallet: { diamonds: 0, agentStock: 0 },
        stats: {
          followers: 0,
          following: 0,
          totalRecharged: 0,
          totalReceived: 0,
          totalSent: 0,
          liveSeconds: 0,
        },
        level: { level: 0, points: 0 },
        vip: { tier: 0, expiresAt: null, packageId: null, badge: null },
        equipped: {
          frameId: null,
          entryAnimationId: null,
          frameUrl: null,
          frameFormat: 'none',
        },
        agencyId: null,
        liveRoomId: null,
        createdAt: now,
        updatedAt: now,
        lastSeenAt: now,
        deletedAt: null,
      };
      try {
        await this.col.insertOne(doc);
        await this.ctx.services.levels.recalculate(doc._id);
        return { user: doc, created: true };
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        // Lost a race with a concurrent first launch: the other request created the profile.
        const raced = await this.col.findOne({ _id: token.uid });
        if (raced) return { user: raced, created: false };
        // Otherwise a shortId collision (manually assigned id) — retry with the next sequence.
      }
    }
    throw conflict('Could not allocate a user id, retry');
  }

  async updateProfile(uid: string, patch: Partial<ProfileInput>): Promise<UserDoc> {
    const $set: Partial<UserDoc> = { updatedAt: this.ctx.clock.now() };
    const sightguard = this.ctx.services.sightguard;
    // Only what changed is sent to SightGuard: re-saving a profile with an unchanged avatar
    // must not fail while moderation is down (avatars fail closed).
    const current =
      sightguard.enabled &&
      (patch.displayName !== undefined || patch.bio !== undefined || patch.avatarUrl)
        ? await this.get(uid)
        : null;
    if (patch.displayName !== undefined) {
      const name = await this.ctx.services.moderation.assertClean(patch.displayName, 'displayName');
      if (current && patch.displayName !== current.displayName)
        await sightguard.assertText('username', patch.displayName, uid, {
          type: 'profile',
          uid,
          field: 'displayName',
        });
      $set.displayName = name;
      $set.displayNameLower = name.toLowerCase();
    }
    if (patch.bio !== undefined) {
      $set.bio = await this.ctx.services.moderation.assertClean(patch.bio, 'bio');
      if (current && patch.bio !== current.bio)
        await sightguard.assertText('bio', patch.bio, uid, { type: 'profile', uid, field: 'bio' });
    }
    if (patch.avatarUrl !== undefined) {
      if (current && patch.avatarUrl && patch.avatarUrl !== current.avatarUrl)
        await sightguard.assertImageUrl('avatar', patch.avatarUrl, uid, {
          type: 'avatar',
          uid,
          url: patch.avatarUrl,
        });
      $set.avatarUrl = patch.avatarUrl;
    }
    if (patch.gender !== undefined) $set.gender = patch.gender;
    if (patch.birthday !== undefined) {
      // The date of birth is given once, from Edit profile, and can't be changed after.
      // An under-18 date locks the account, as the consent screen used to.
      const existing = current ?? (await this.get(uid));
      if (existing.birthday) {
        const same =
          patch.birthday && dayOnly(patch.birthday).getTime() === existing.birthday.getTime();
        if (!same)
          throw new AppError(409, 'birthday_locked', 'Your date of birth can’t be changed');
      } else if (patch.birthday) {
        $set.birthday = this.checkNewBirthday(dayOnly(patch.birthday));
      }
    }
    if (patch.country !== undefined) $set.country = patch.country;
    const updated = await this.col.findOneAndUpdate(
      { _id: uid, status: { $ne: 'deleted' } },
      { $set },
      { returnDocument: 'after' },
    );
    if (!updated) throw notFound('User');
    return updated;
  }

  async publicProfile(uid: string, viewerUid: string | null) {
    const user = await this.get(uid);
    const [isFollowing, isBlocked] =
      viewerUid && viewerUid !== uid
        ? await Promise.all([
            this.ctx.col.follows.countDocuments(
              { followerId: viewerUid, followeeId: uid },
              { limit: 1 },
            ),
            this.ctx.col.blocks.countDocuments(
              { blockerId: viewerUid, blockedId: uid },
              { limit: 1 },
            ),
          ])
        : [0, 0];
    return {
      ...toPublicUser(user, this.ctx.clock.now()),
      // Wallet balances are public on profiles (stars are derived from it client-side).
      diamonds: user.wallet?.diamonds ?? 0,
      isFollowing: isFollowing > 0,
      isBlocked: isBlocked > 0,
    };
  }

  /** Search by exact short id or display-name prefix. */
  async search(q: string, limit: number): Promise<UserBrief[]> {
    const term = q.trim();
    if (!term) return [];
    const escaped = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const filter: Filter<UserDoc> = SHORT_ID_PATTERN.test(term)
      ? {
          status: 'active',
          $or: [{ shortId: term }, { displayNameLower: { $regex: `^${escaped}` } }],
        }
      : { status: 'active', displayNameLower: { $regex: `^${escaped}` } };
    const docs = await this.col
      .find(filter, { projection: BRIEF_PROJECTION })
      .sort({ 'level.level': -1 })
      .limit(limit)
      .toArray();
    const now = this.ctx.clock.now();
    return docs.map((d) => toUserBrief(d as UserDoc, now));
  }

  async block(uid: string, target: string): Promise<void> {
    if (uid === target) throw badRequest('You cannot block yourself');
    await this.get(target);
    await this.ctx.col.blocks.updateOne(
      { blockerId: uid, blockedId: target },
      { $setOnInsert: { blockerId: uid, blockedId: target, createdAt: this.ctx.clock.now() } },
      { upsert: true },
    );
    // Blocking also removes follow edges in both directions.
    await Promise.all([
      this.ctx.services.follows.unfollow(uid, target).catch(() => undefined),
      this.ctx.services.follows.unfollow(target, uid).catch(() => undefined),
    ]);
  }

  async unblock(uid: string, target: string): Promise<void> {
    await this.ctx.col.blocks.deleteOne({ blockerId: uid, blockedId: target });
  }

  async isBlockedEitherWay(a: string, b: string): Promise<boolean> {
    const n = await this.ctx.col.blocks.countDocuments(
      {
        $or: [
          { blockerId: a, blockedId: b },
          { blockerId: b, blockedId: a },
        ],
      },
      { limit: 1 },
    );
    return n > 0;
  }

  async blockedList(uid: string): Promise<UserBrief[]> {
    const rows = await this.ctx.col.blocks
      .find({ blockerId: uid })
      .sort({ createdAt: -1 })
      .limit(500)
      .toArray();
    const briefs = await this.briefs(rows.map((r) => r.blockedId));
    return rows.map((r) => briefs.get(r.blockedId)).filter((b): b is UserBrief => Boolean(b));
  }

  async touch(uid: string, deviceId: string | null, platform: string | null): Promise<void> {
    const now = this.ctx.clock.now();
    await this.col.updateOne({ _id: uid }, { $set: { lastSeenAt: now } });
    if (deviceId) {
      await this.ctx.col.devices.updateOne(
        { userId: uid, deviceId },
        {
          $set: { lastSeenAt: now, platform },
          $setOnInsert: { userId: uid, deviceId, firstSeenAt: now },
        },
        { upsert: true },
      );
    }
  }

  async liftExpiredBan(uid: string): Promise<void> {
    await this.col.updateOne(
      { _id: uid, status: 'banned', 'ban.until': { $lte: this.ctx.clock.now() } },
      { $set: { status: 'active', ban: null } },
    );
  }

  async ban(uid: string, opts: { reason: string; until: Date | null; by: string }): Promise<void> {
    const now = this.ctx.clock.now();
    const res = await this.col.updateOne(
      { _id: uid, status: { $ne: 'deleted' } },
      {
        $set: {
          status: 'banned',
          ban: { reason: opts.reason, until: opts.until, by: opts.by, at: now },
          updatedAt: now,
        },
      },
    );
    if (!res.matchedCount) throw notFound('User');
    await this.ctx.auth
      .revokeSessions(uid)
      .catch((err: unknown) => this.ctx.log.warn({ err, uid }, 'revoke failed'));
    await this.ctx.services.live.endActiveRoomFor(uid, 'banned', opts.by);
  }

  async unban(uid: string): Promise<void> {
    const res = await this.col.updateOne(
      { _id: uid, status: 'banned' },
      { $set: { status: 'active', ban: null, updatedAt: this.ctx.clock.now() } },
    );
    if (!res.matchedCount) throw notFound('Banned user');
  }

  /** Admin: give a user a specific (e.g. vanity) short id, or swap ids between two users. */
  async setShortId(uid: string, shortId: string): Promise<void> {
    if (!ASSIGNABLE_SHORT_ID_PATTERN.test(shortId))
      throw badRequest('Short id must be 1–12 digits, starting from 1');
    const holder = await this.col.findOne({ shortId }, { projection: { _id: 1 } });
    if (holder && holder._id !== uid) {
      // Swap inside a transaction so neither user is ever left without an id.
      const target = await this.get(uid);
      await this.ctx.db.withTransaction(async (session) => {
        await this.col.updateOne(
          { _id: holder._id },
          { $set: { shortId: `tmp-${holder._id}` } },
          { session },
        );
        await this.col.updateOne({ _id: uid }, { $set: { shortId } }, { session });
        await this.col.updateOne(
          { _id: holder._id },
          { $set: { shortId: target.shortId } },
          { session },
        );
      });
      return;
    }
    try {
      const res = await this.col.updateOne({ _id: uid }, { $set: { shortId } });
      if (!res.matchedCount) throw notFound('User');
    } catch (err) {
      if (isDuplicateKeyError(err)) throw conflict('Short id is taken');
      throw err;
    }
  }

  /**
   * A first date of birth (calendar day). Implausible → 400. Any plausible date is kept: the
   * date of birth is a plain profile field and gates nothing.
   */
  private checkNewBirthday(birthday: Date): Date {
    if (!plausibleBirthday(birthday, this.ctx.clock.now())) throw invalidBirthday();
    return birthday;
  }

  /**
   * The consent screen: acceptance of the current Terms. The date of birth is given from
   * Edit profile instead; one passed here (by an older app) is checked like that one.
   */
  async recordConsent(uid: string, input: z.infer<typeof consentInput>): Promise<UserDoc> {
    const user = await this.get(uid);
    const now = this.ctx.clock.now();
    if (input.termsVersion !== CURRENT_TERMS_VERSION)
      throw new AppError(409, 'terms_outdated', 'Please update the app to accept the new terms');
    const birthday =
      !user.birthday && input.birthday ? this.checkNewBirthday(dayOnly(input.birthday)) : null;
    const updated = await this.col.findOneAndUpdate(
      { _id: uid, status: { $ne: 'deleted' } },
      {
        $set: {
          ...(birthday ? { birthday } : {}),
          termsAcceptedVersion: CURRENT_TERMS_VERSION,
          termsAcceptedAt: now,
          updatedAt: now,
        },
      },
      { returnDocument: 'after' },
    );
    if (!updated) throw notFound('User');
    return updated;
  }

  /**
   * Account deletion (store-policy requirement). What goes:
   * - Profile fields (name, photo, bio, email, phone, date of birth, gender, country).
   * - Follows, blocks, push tokens, agency membership, open game sessions.
   * - Feed posts, comments and likes; inbox messages they sent (cleared for both sides).
   * - Devices, unless the account was banned (kept against ban evasion).
   * - Their uploads and the sign-in identity, in the retried `users.erase` job, except media
   *   that an urgent (child-safety) report holds as evidence.
   *
   * What stays, as the privacy policy says: the ledger, gift transactions and withdrawal
   * records (financial law), reports and audit rows. Remaining diamonds are forfeited, and a
   * pending withdrawal must be settled first (409 `withdrawal_pending`).
   */
  async deleteAccount(uid: string): Promise<void> {
    const now = this.ctx.clock.now();
    const user = await this.col.findOne({ _id: uid, status: { $ne: 'deleted' } });
    if (!user) throw notFound('User');
    const pending = await this.ctx.col.withdrawals.countDocuments(
      { userId: uid, status: 'pending' },
      { limit: 1 },
    );
    if (pending)
      throw conflict(
        'You have a withdrawal under review. Wait for it to finish, then delete your account.',
        'withdrawal_pending',
      );
    await this.ctx.services.live.endActiveRoomFor(uid, 'host', uid);
    const res = await this.col.updateOne(
      { _id: uid, status: { $ne: 'deleted' } },
      {
        $set: {
          status: 'deleted',
          deletedAt: now,
          displayName: 'Deleted user',
          displayNameLower: 'deleted user',
          avatarUrl: null,
          bio: '',
          email: null,
          phone: null,
          birthday: null,
          gender: null,
          country: null,
          updatedAt: now,
        },
      },
    );
    if (!res.matchedCount) throw notFound('User');
    await Promise.all([
      this.ctx.services.follows.removeAllFor(uid),
      this.ctx.col.pushTokens.deleteMany({ userId: uid }),
      this.ctx.col.blocks.deleteMany({ $or: [{ blockerId: uid }, { blockedId: uid }] }),
      this.ctx.services.agencies.removeMember(uid).catch(() => undefined),
      this.ctx.services.games.endSessions({ uid }),
      this.ctx.services.feed.eraseAuthor(uid),
      this.eraseSentMessages(uid, now),
      user.status === 'banned'
        ? Promise.resolve()
        : this.ctx.col.devices.deleteMany({ userId: uid }).then(() => undefined),
    ]);
    await this.ctx.jobs
      .enqueue('users.erase', { uid })
      .catch((err: unknown) => this.ctx.log.error({ err, uid }, 'users.erase not queued'));
  }

  /** Clears the text and media of every inbox message the user sent, for both sides. */
  private async eraseSentMessages(uid: string, now: Date): Promise<void> {
    await this.ctx.col.messages.updateMany(
      { senderId: uid },
      { $set: { text: null, mediaUrl: null, removedAt: now } },
    );
    await this.ctx.col.conversations.updateMany(
      { participants: uid, 'lastMessage.senderId': uid },
      { $set: { 'lastMessage.text': '' } },
    );
  }

  /**
   * The `users.erase` job: the Firebase identity and the user's uploads. Throws so the queue
   * retries; both steps are safe to repeat.
   */
  async eraseExternal(uid: string): Promise<void> {
    await this.ctx.auth.deleteUser(uid);
    const evidence = await this.ctx.col.reports
      .find(
        { priority: 'urgent', 'snapshot.authorId': uid, 'snapshot.mediaUrl': { $ne: null } },
        { projection: { 'snapshot.mediaUrl': 1 } },
      )
      .toArray();
    const keep = new Set(evidence.map((r) => r.snapshot?.mediaUrl).filter((u): u is string => !!u));
    const erased = await this.ctx.storage.deleteOwnerUploads(uid, USER_UPLOAD_FOLDERS, keep);
    this.ctx.log.info({ uid, erased, kept: keep.size }, 'account uploads erased');
  }
}
