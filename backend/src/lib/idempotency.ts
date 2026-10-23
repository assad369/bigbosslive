import type { ClientSession } from 'mongodb';
import type { Ctx } from '../context.js';
import { isDuplicateKeyError } from './errors.js';

/**
 * Run a money-moving operation exactly once per (scope, user, client key).
 *
 * The idempotency record is inserted inside the same transaction as the operation, so either
 * both commit or neither does. A retry finds the record and gets the original result back.
 */
export async function once<T>(
  ctx: Ctx,
  scope: string,
  uid: string,
  key: string,
  fn: (session: ClientSession) => Promise<T>,
): Promise<{ result: T; replayed: boolean }> {
  const id = `${scope}:${uid}:${key}`;
  const existing = await ctx.col.idempotency.findOne({ _id: id });
  if (existing) return { result: existing.result as T, replayed: true };
  try {
    const result = await ctx.db.withTransaction(async (session) => {
      const value = await fn(session);
      await ctx.col.idempotency.insertOne({ _id: id, result: value, createdAt: ctx.clock.now() }, { session });
      return value;
    });
    return { result, replayed: false };
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      const raced = await ctx.col.idempotency.findOne({ _id: id });
      if (raced) return { result: raced.result as T, replayed: true };
    }
    throw err;
  }
}
