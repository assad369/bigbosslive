import { randomUUID } from 'node:crypto';
import { HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Env } from '../config/env.js';
import { serviceUnavailable } from '../lib/errors.js';

export interface PresignedUpload {
  uploadUrl: string;
  publicUrl: string;
  key: string;
  expiresIn: number;
  headers: Record<string, string>;
}

export interface PresignUploadOptions {
  folder: string;
  ownerId: string;
  contentType: string;
  ext: string;
  /** Exact byte size. When set it is signed, so the bucket rejects any other size. */
  contentLength?: number;
  /** Stored on the object and served by the CDN. Signed, so the client must send it. */
  cacheControl?: string;
}

export interface StorageGateway {
  presignUpload(opts: PresignUploadOptions): Promise<PresignedUpload>;
  /** True when `url` is the public URL of an object this user uploaded into `folder`. */
  isOwnUpload(url: string, folder: string, ownerId: string): Promise<boolean>;
  /** Throws when the bucket is unreachable with the current credentials. */
  verify(): Promise<void>;
}

/** Resolved bucket settings: from the admin dashboard (`app_config.storage`) or env `S3_*`. */
export interface S3Settings {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl: string;
}

export function s3SettingsFromEnv(env: Env): S3Settings | null {
  if (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) return null;
  return {
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    publicBaseUrl: env.S3_PUBLIC_BASE_URL ?? '',
  };
}

/** Shared by real and fake storage: keys are `<folder>/<owner>/<uuid>.<ext>` under the CDN base. */
export function isOwnUploadUrl(
  base: string,
  url: string,
  folder: string,
  ownerId: string,
): boolean {
  if (!base) return false;
  const prefix = `${base.replace(/\/$/, '')}/${folder}/${ownerId}/`;
  return url.startsWith(prefix) && /^[\w-]+\.[a-z0-9]+$/.test(url.slice(prefix.length));
}

/** Headers the client must send with the PUT, exactly as signed. */
export function uploadHeaders(o: PresignUploadOptions): Record<string, string> {
  return {
    'Content-Type': o.contentType,
    ...(o.cacheControl ? { 'Cache-Control': o.cacheControl } : {}),
  };
}

/**
 * Clients upload straight to R2/S3 with a short-lived presigned PUT; the API never proxies bytes.
 * Object keys are server-generated (`<folder>/<owner>/<uuid>.<ext>`), so a client cannot
 * overwrite someone else's object. Content type, length and cache control are signed headers:
 * presigned POST policies would be the usual way to cap size, but R2 doesn't support them.
 */
export function createS3Storage(settings: () => Promise<S3Settings | null>): StorageGateway {
  // Settings are editable at runtime, so the client is rebuilt whenever they change.
  let cached: { key: string; client: S3Client } | null = null;
  const resolve = async () => {
    const cfg = await settings();
    if (!cfg) throw serviceUnavailable('Object storage is not configured');
    const key = JSON.stringify(cfg);
    if (cached?.key !== key) {
      cached?.client.destroy();
      cached = {
        key,
        client: new S3Client({
          region: cfg.region,
          ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
          credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
        }),
      };
    }
    return { cfg, client: cached.client };
  };

  return {
    async presignUpload(opts) {
      const { cfg, client } = await resolve();
      const { folder, ownerId, contentType, ext, contentLength, cacheControl } = opts;
      const key = `${folder}/${ownerId}/${randomUUID()}.${ext}`;
      const expiresIn = 300;
      const uploadUrl = await getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: cfg.bucket,
          Key: key,
          ContentType: contentType,
          ...(contentLength !== undefined ? { ContentLength: contentLength } : {}),
          ...(cacheControl ? { CacheControl: cacheControl } : {}),
        }),
        {
          expiresIn,
          signableHeaders: new Set(['content-type', 'content-length', 'cache-control']),
        },
      );
      const base = cfg.publicBaseUrl.replace(/\/$/, '');
      return {
        uploadUrl,
        publicUrl: `${base}/${key}`,
        key,
        expiresIn,
        headers: uploadHeaders(opts),
      };
    },
    async isOwnUpload(url, folder, ownerId) {
      const cfg = await settings();
      return isOwnUploadUrl(cfg?.publicBaseUrl ?? '', url, folder, ownerId);
    },
    async verify() {
      const { cfg, client } = await resolve();
      await client.send(new HeadBucketCommand({ Bucket: cfg.bucket }));
    },
  };
}
