import type { Request } from 'express';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { badRequest, unauthorized, validationError } from './errors.js';
import type { AuthUser } from '../middleware/auth.js';

function parseWith<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw validationError(
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

/** Validate `req.body`. Express 5 makes `req.query` read-only, so we parse rather than mutate. */
export const parseBody = <S extends z.ZodType>(req: Request, schema: S) => parseWith(schema, req.body);
export const parseQuery = <S extends z.ZodType>(req: Request, schema: S) =>
  parseWith(schema, req.query);
export const parseParams = <S extends z.ZodType>(req: Request, schema: S) =>
  parseWith(schema, req.params);

/** The authenticated caller. Only call from routes mounted behind `requireAuth`. */
export function currentUser(req: Request): AuthUser {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

export function toObjectId(value: string, what = 'id'): ObjectId {
  if (!ObjectId.isValid(value) || String(new ObjectId(value)) !== value.toLowerCase()) {
    throw badRequest(`Invalid ${what}`);
  }
  return new ObjectId(value);
}

export const objectIdString = z
  .string()
  .regex(/^[a-f0-9]{24}$/i, 'Must be a 24-character hex id');

export const idParam = z.object({ id: objectIdString });
export const uidParam = z.object({ uid: z.string().min(1).max(128) });

export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type PageQuery = z.infer<typeof pageQuery>;

export const cursorQuery = z.object({
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type CursorQuery = z.infer<typeof cursorQuery>;

/** Opaque cursor = base64url("<isoDate>|<id>") for stable `createdAt desc, _id desc` paging. */
export function encodeCursor(date: Date, id: string): string {
  return Buffer.from(`${date.toISOString()}|${id}`).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): { date: Date; id: string } | null {
  if (!cursor) return null;
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const [iso, id] = raw.split('|');
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime()) || !id) throw badRequest('Invalid cursor');
  return { date, id };
}

/** Header-supplied idempotency key, required on every money-moving POST. */
export function idempotencyKey(req: Request): string {
  const key = req.header('idempotency-key');
  if (!key || !/^[A-Za-z0-9_\-:.]{8,128}$/.test(key)) {
    throw badRequest('A valid Idempotency-Key header (8–128 chars) is required');
  }
  return key;
}

export function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}
