/**
 * 2026-11 agency lock: members now join locked (`AgenciesService.addMemberIn`), so members who
 * joined before that are locked too, each with a `system` `host_locked` audit row.
 *
 * Safe to re-run: only unlocked members are touched, one conditional update each, and the
 * audit row is written only when that update changed the member.
 */
import { ObjectId } from 'mongodb';
import type { Database } from '../src/db/mongo.js';
import { SYSTEM_ACTOR } from '../src/modules/agencies/agencies.service.js';

export async function lockAgencyMembers(
  db: Database,
  now: () => Date = () => new Date(),
): Promise<{ locked: number }> {
  let locked = 0;
  for await (const member of db.col.agencyMembers.find(
    { locked: { $ne: true } },
    { projection: { _id: 1, agencyId: 1, userId: 1 } },
  )) {
    await db.withTransaction(async (session) => {
      const res = await db.col.agencyMembers.updateOne(
        { _id: member._id, locked: { $ne: true } },
        { $set: { locked: true } },
        { session },
      );
      if (!res.modifiedCount) return;
      await db.col.agencyAudit.insertOne(
        {
          _id: new ObjectId(),
          agencyId: member.agencyId,
          actorId: SYSTEM_ACTOR,
          action: 'host_locked',
          targetUserId: member.userId,
          meta: { auto: true, migration: '2026-11-10-agency-members-locked' },
          createdAt: now(),
        },
        { session },
      );
      locked++;
    });
  }
  return { locked };
}
