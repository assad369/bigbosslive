import { randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
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

export interface StorageGateway {
  presignUpload(opts: {
    folder: string;
    ownerId: string;
    contentType: string;
    ext: string;
  }): Promise<PresignedUpload>;
}

/**
 * Clients upload straight to R2/S3 with a short-lived presigned PUT; the API never proxies bytes.
 * Object keys are server-generated (`<folder>/<owner>/<uuid>.<ext>`), so a client cannot
 * overwrite someone else's object.
 */
export function createS3Storage(env: Env): StorageGateway {
  const configured = env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY;
  const client = configured
    ? new S3Client({
        region: env.S3_REGION,
        ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
        credentials: {
          accessKeyId: env.S3_ACCESS_KEY_ID!,
          secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
        },
      })
    : null;

  return {
    async presignUpload({ folder, ownerId, contentType, ext }) {
      if (!client || !env.S3_BUCKET) throw serviceUnavailable('Object storage is not configured');
      const key = `${folder}/${ownerId}/${randomUUID()}.${ext}`;
      const expiresIn = 300;
      const uploadUrl = await getSignedUrl(
        client,
        new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, ContentType: contentType }),
        { expiresIn },
      );
      const base = (env.S3_PUBLIC_BASE_URL ?? '').replace(/\/$/, '');
      return {
        uploadUrl,
        publicUrl: `${base}/${key}`,
        key,
        expiresIn,
        headers: { 'Content-Type': contentType },
      };
    },
  };
}
