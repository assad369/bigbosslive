import { cert, getApps, initializeApp, applicationDefault, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getMessaging } from 'firebase-admin/messaging';
import type { AdminRole } from '@bigboss/shared';
import type { Env } from '../config/env.js';

export interface VerifiedToken {
  uid: string;
  email: string | null;
  phone: string | null;
  name: string | null;
  picture: string | null;
  adminRole: AdminRole | null;
}

/** Verifies end-user and admin identities. Firebase in production; a fake in tests. */
export interface AuthProvider {
  verifyIdToken(token: string): Promise<VerifiedToken>;
  setAdminRole(uid: string, role: AdminRole | null): Promise<void>;
  revokeSessions(uid: string): Promise<void>;
  deleteUser(uid: string): Promise<void>;
}

export interface PushMessage {
  title: string;
  body: string;
  imageUrl?: string | null;
  data?: Record<string, string>;
}

export interface PushResult {
  successCount: number;
  failureCount: number;
  /** Tokens FCM reported as permanently invalid — callers delete them. */
  invalidTokens: string[];
}

export interface PushGateway {
  sendToTokens(tokens: string[], message: PushMessage): Promise<PushResult>;
}

let app: App | null = null;

function firebaseApp(env: Env): App {
  if (app) return app;
  const existing = getApps()[0];
  if (existing) return (app = existing);
  const credential = env.FIREBASE_SERVICE_ACCOUNT_BASE64
    ? cert(JSON.parse(Buffer.from(env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8')))
    : applicationDefault();
  app = initializeApp({ credential, projectId: env.FIREBASE_PROJECT_ID });
  return app;
}

const ROLE_SET = new Set<string>(['support', 'moderator', 'finance', 'admin', 'superadmin']);

export function createFirebaseAuth(env: Env): AuthProvider {
  const auth = getAuth(firebaseApp(env));
  return {
    async verifyIdToken(token) {
      // checkRevoked=true: banned or signed-out users lose access immediately.
      const decoded = await auth.verifyIdToken(token, true);
      const role =
        typeof decoded.adminRole === 'string' && ROLE_SET.has(decoded.adminRole)
          ? (decoded.adminRole as AdminRole)
          : null;
      return {
        uid: decoded.uid,
        email: decoded.email ?? null,
        phone: decoded.phone_number ?? null,
        name: (decoded.name as string | undefined) ?? null,
        picture: decoded.picture ?? null,
        adminRole: role,
      };
    },
    async setAdminRole(uid, role) {
      const user = await auth.getUser(uid);
      const claims = { ...(user.customClaims ?? {}) };
      if (role) claims.adminRole = role;
      else delete claims.adminRole;
      await auth.setCustomUserClaims(uid, claims);
      await auth.revokeRefreshTokens(uid);
    },
    revokeSessions: (uid) => auth.revokeRefreshTokens(uid),
    deleteUser: (uid) => auth.deleteUser(uid),
  };
}

const INVALID_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

export function createFcmGateway(env: Env): PushGateway {
  const messaging = getMessaging(firebaseApp(env));
  return {
    async sendToTokens(tokens, message) {
      const result: PushResult = { successCount: 0, failureCount: 0, invalidTokens: [] };
      // FCM multicast accepts at most 500 tokens per call.
      for (let i = 0; i < tokens.length; i += 500) {
        const batch = tokens.slice(i, i + 500);
        const res = await messaging.sendEachForMulticast({
          tokens: batch,
          notification: {
            title: message.title,
            body: message.body,
            ...(message.imageUrl ? { imageUrl: message.imageUrl } : {}),
          },
          data: message.data ?? {},
          android: { priority: 'high', notification: { channelId: 'bigboss_default' } },
          apns: { payload: { aps: { sound: 'default' } } },
        });
        result.successCount += res.successCount;
        result.failureCount += res.failureCount;
        res.responses.forEach((r, idx) => {
          const code = r.error?.code;
          if (code && INVALID_TOKEN_CODES.has(code)) result.invalidTokens.push(batch[idx]!);
        });
      }
      return result;
    },
  };
}

/** Used when Firebase is not configured (local dev without credentials). Push is a no-op. */
export const noopPush: PushGateway = {
  sendToTokens: async (tokens) => ({
    successCount: 0,
    failureCount: tokens.length,
    invalidTokens: [],
  }),
};
