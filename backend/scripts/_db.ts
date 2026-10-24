import { loadEnv } from '../src/config/env.js';
import { ensureIndexes } from '../src/db/indexes.js';
import { connectMongo, type Database } from '../src/db/mongo.js';

/** Connect with the app's env and indexes, run `fn`, always close. */
export async function withDb(fn: (db: Database) => Promise<void>): Promise<void> {
  const env = loadEnv();
  const db = await connectMongo(env.MONGODB_URI, env.MONGODB_DB);
  try {
    await ensureIndexes(db);
    await fn(db);
  } finally {
    await db.close();
  }
}
