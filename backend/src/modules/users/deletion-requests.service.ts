import { ObjectId, type Filter } from 'mongodb';
import { z } from 'zod';
import { SHORT_ID_PATTERN, type DeletionRequestStatus } from '@bigboss/shared';
import type { Ctx } from '../../context.js';
import type { AccountDeletionRequestDoc, UserDoc } from '../../db/schema.js';
import { conflict, notFound } from '../../lib/errors.js';

export const deletionRequestInput = z.object({
  /** Email, phone number or short id: what the visitor knows about their account. */
  contact: z.string().trim().min(3).max(120),
  reason: z.string().trim().max(500).default(''),
});

export const resolveDeletionInput = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('delete'),
    /** The account staff matched to the request (uid or short id). */
    user: z.string().trim().min(1).max(128),
    note: z.string().trim().max(500).nullable().default(null),
  }),
  z.object({
    action: z.literal('reject'),
    note: z.string().trim().min(3).max(500),
  }),
]);

/**
 * Account deletion requested on the public web page (Play's deletion URL), for people who
 * can't or won't open the app. Anonymous, so staff match the contact to an account and
 * delete it with the same `UsersService.deleteAccount` the app uses.
 */
export class DeletionRequestsService {
  constructor(private readonly ctx: Ctx) {}

  async create(
    input: z.infer<typeof deletionRequestInput>,
    ip: string | null,
  ): Promise<AccountDeletionRequestDoc> {
    const doc: AccountDeletionRequestDoc = {
      _id: new ObjectId(),
      contact: input.contact,
      reason: input.reason,
      status: 'pending',
      resolvedUid: null,
      note: null,
      reviewedBy: null,
      reviewedAt: null,
      ip,
      createdAt: this.ctx.clock.now(),
    };
    await this.ctx.col.accountDeletionRequests.insertOne(doc);
    return doc;
  }

  async list(filter: { status?: DeletionRequestStatus }, page: number, pageSize: number) {
    const q: Filter<AccountDeletionRequestDoc> = filter.status ? { status: filter.status } : {};
    const [items, total] = await Promise.all([
      this.ctx.col.accountDeletionRequests
        .find(q)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
      this.ctx.col.accountDeletionRequests.countDocuments(q),
    ]);
    return { items, total, page, pageSize };
  }

  async resolve(
    id: ObjectId,
    by: string,
    input: z.infer<typeof resolveDeletionInput>,
  ): Promise<AccountDeletionRequestDoc> {
    const req = await this.ctx.col.accountDeletionRequests.findOne({ _id: id });
    if (!req) throw notFound('Deletion request');
    if (req.status !== 'pending') throw conflict('This request is already closed');
    let resolvedUid: string | null = null;
    if (input.action === 'delete') {
      const uid = await this.match(input.user);
      await this.ctx.services.users.deleteAccount(uid);
      resolvedUid = uid;
    }
    const res = await this.ctx.col.accountDeletionRequests.findOneAndUpdate(
      { _id: id, status: 'pending' },
      {
        $set: {
          status: input.action === 'delete' ? 'done' : 'rejected',
          resolvedUid,
          note: input.note,
          reviewedBy: by,
          reviewedAt: this.ctx.clock.now(),
        },
      },
      { returnDocument: 'after' },
    );
    if (!res) throw conflict('This request is already closed');
    return res;
  }

  /**
   * The account behind what staff typed: short id, uid, email or phone. Banned accounts
   * count (they may delete too); a deleted one doesn't.
   */
  private async match(identifier: string): Promise<string> {
    const id = identifier.trim();
    const or: Filter<UserDoc>[] = [{ _id: id }, { email: id.toLowerCase() }, { phone: id }];
    if (SHORT_ID_PATTERN.test(id)) or.unshift({ shortId: id });
    const users = await this.ctx.col.users
      .find({ $or: or, status: { $ne: 'deleted' } }, { projection: { _id: 1 } })
      .limit(2)
      .toArray();
    if (!users.length) throw notFound('User');
    if (users.length > 1) throw conflict('That matches more than one account: use the uid');
    return users[0]!._id;
  }
}
