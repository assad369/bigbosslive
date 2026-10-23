import { createSign } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';
import type { Env } from '../config/env.js';
import { AppError, serviceUnavailable } from '../lib/errors.js';

export interface VerifiedPurchase {
  store: 'google' | 'apple';
  productId: string;
  /** Globally unique per purchase — used as the recharge idempotency key. */
  transactionId: string;
}

/** Server-side receipt verification. Diamonds are only ever credited after the store confirms. */
export interface IapGateway {
  verifyGoogle(productId: string, purchaseToken: string): Promise<VerifiedPurchase>;
  /** Mark a consumable as consumed so it can be bought again. Call after crediting. */
  consumeGoogle(productId: string, purchaseToken: string): Promise<void>;
  verifyApple(transactionId: string): Promise<VerifiedPurchase>;
}

const invalidPurchase = (msg: string) => new AppError(402, 'purchase_invalid', msg);

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export function createIapGateway(env: Env): IapGateway {
  const googleAuth = env.GOOGLE_PLAY_PACKAGE_NAME
    ? new GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/androidpublisher'],
        ...(env.FIREBASE_SERVICE_ACCOUNT_BASE64
          ? {
              credentials: JSON.parse(
                Buffer.from(env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8'),
              ),
            }
          : {}),
      })
    : null;

  const googleUrl = (productId: string, token: string) =>
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(env.GOOGLE_PLAY_PACKAGE_NAME ?? '')}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}`;

  /** App Store Server API bearer token: ES256 JWT, valid ≤ 60 minutes. */
  function appleJwt(): string {
    if (
      !env.APPLE_ISSUER_ID ||
      !env.APPLE_KEY_ID ||
      !env.APPLE_PRIVATE_KEY_BASE64 ||
      !env.APPLE_BUNDLE_ID
    ) {
      throw serviceUnavailable('Apple in-app purchases are not configured');
    }
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'ES256', kid: env.APPLE_KEY_ID, typ: 'JWT' }));
    const payload = b64url(
      JSON.stringify({
        iss: env.APPLE_ISSUER_ID,
        iat: now,
        exp: now + 1800,
        aud: 'appstoreconnect-v1',
        bid: env.APPLE_BUNDLE_ID,
      }),
    );
    const key = Buffer.from(env.APPLE_PRIVATE_KEY_BASE64, 'base64').toString('utf8');
    const signature = createSign('SHA256')
      .update(`${header}.${payload}`)
      .sign({ key, dsaEncoding: 'ieee-p1363' });
    return `${header}.${payload}.${b64url(signature)}`;
  }

  return {
    async verifyGoogle(productId, purchaseToken) {
      if (!googleAuth) throw serviceUnavailable('Google Play purchases are not configured');
      const client = await googleAuth.getClient();
      const res = await client
        .request<{
          purchaseState?: number;
          consumptionState?: number;
          orderId?: string;
          acknowledgementState?: number;
        }>({ url: googleUrl(productId, purchaseToken) })
        .catch(() => {
          throw invalidPurchase('Google Play could not verify this purchase');
        });
      // purchaseState: 0 purchased, 1 cancelled, 2 pending. consumptionState: 0 not yet consumed.
      if (res.data.purchaseState !== 0) throw invalidPurchase('Purchase is not completed');
      if (res.data.consumptionState !== 0) throw invalidPurchase('Purchase was already consumed');
      return { store: 'google', productId, transactionId: res.data.orderId ?? purchaseToken };
    },
    async consumeGoogle(productId, purchaseToken) {
      if (!googleAuth) return;
      const client = await googleAuth.getClient();
      await client.request({
        url: `${googleUrl(productId, purchaseToken)}:consume`,
        method: 'POST',
      });
    },
    async verifyApple(transactionId) {
      const host =
        env.APPLE_ENVIRONMENT === 'sandbox'
          ? 'api.storekit-sandbox.itunes.apple.com'
          : 'api.storekit.itunes.apple.com';
      const res = await fetch(
        `https://${host}/inApps/v1/transactions/${encodeURIComponent(transactionId)}`,
        {
          headers: { Authorization: `Bearer ${appleJwt()}` },
        },
      );
      if (!res.ok) throw invalidPurchase('The App Store could not verify this purchase');
      const body = (await res.json()) as { signedTransactionInfo?: string };
      const part = body.signedTransactionInfo?.split('.')[1];
      if (!part) throw invalidPurchase('Malformed App Store response');
      // The JWS came straight from Apple over an authenticated TLS call, so the payload is trusted.
      const info = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as {
        bundleId?: string;
        productId?: string;
        transactionId?: string;
        type?: string;
        revocationDate?: number;
      };
      if (info.bundleId !== env.APPLE_BUNDLE_ID)
        throw invalidPurchase('Purchase belongs to another app');
      if (info.type !== 'Consumable') throw invalidPurchase('Not a consumable purchase');
      if (info.revocationDate) throw invalidPurchase('Purchase was refunded');
      if (!info.productId || !info.transactionId)
        throw invalidPurchase('Malformed App Store transaction');
      return { store: 'apple', productId: info.productId, transactionId: info.transactionId };
    },
  };
}
