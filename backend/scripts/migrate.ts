/**
 * Versioned data migrations. Each runs once, in order, and is recorded in `migrations`.
 * Indexes are (re)ensured first. Usage: npm run migrate [-- --dry-run]
 */
import type { Database } from '../src/db/mongo.js';
import { withDb } from './_db.js';

interface Migration {
  id: string;
  up(db: Database): Promise<void>;
}

const MIGRATIONS: Migration[] = [
  {
    id: '2026-01-01-initial',
    async up() {
      // Baseline: the schema is created by ensureIndexes(). Kept as the first entry so later
      // migrations have a known starting point.
    },
  },
];

const dryRun = process.argv.includes('--dry-run');

await withDb(async (db) => {
  const applied = new Set((await db.col.migrations.find().toArray()).map((m) => m._id));
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    console.log(`${dryRun ? '[dry-run] would apply' : 'applying'} ${m.id}`);
    if (dryRun) continue;
    await m.up(db);
    await db.col.migrations.insertOne({ _id: m.id, appliedAt: new Date() });
  }
  console.log('migrations up to date');
});
