/**
 * Grant or revoke a dashboard role. Run once to create the first superadmin:
 *   npm run set-admin -- <uid|email> superadmin
 *   npm run set-admin -- <uid|email> none
 */
import { ADMIN_ROLES, type AdminRole } from '@bigboss/shared';
import { getAuth } from 'firebase-admin/auth';
import { loadEnv } from '../src/config/env.js';
import { createFirebaseAuth } from '../src/infra/firebase.js';
import { withDb } from './_db.js';

const [who, roleArg] = process.argv.slice(2);
if (!who || !roleArg || (roleArg !== 'none' && !(ADMIN_ROLES as readonly string[]).includes(roleArg))) {
  console.error(`usage: set-admin <uid|email> <${ADMIN_ROLES.join('|')}|none>`);
  process.exit(1);
}
const role = roleArg === 'none' ? null : (roleArg as AdminRole);
const env = loadEnv();
const auth = createFirebaseAuth(env);
const uid = who.includes('@') ? (await getAuth().getUserByEmail(who)).uid : who;

await auth.setAdminRole(uid, role);
await withDb(async (db) => {
  await db.col.users.updateOne({ _id: uid }, { $set: { adminRole: role } });
});
console.log(`${uid} → ${role ?? 'no admin role'} (existing sessions were revoked; sign in again)`);
