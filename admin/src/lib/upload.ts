import axios, { isAxiosError, isCancel } from 'axios';
import {
  ADMIN_UPLOAD_KINDS,
  MEDIA_EXTENSIONS,
  MEDIA_TYPES,
  type AdminUploadKind,
  type MediaType,
} from '@bigboss/shared';
import { send } from './api';

interface Presigned {
  uploadUrl: string;
  publicUrl: string;
  key: string;
  expiresIn: number;
  headers: Record<string, string>;
}

/**
 * Talks to the bucket only. Deliberately not the `api` instance: that one attaches the admin's
 * Firebase token, which must never be sent to object storage.
 */
const bucket = axios.create();

const extOf = (name: string) => name.split('.').pop()?.toLowerCase() ?? '';

/**
 * The upload's content type. A known extension wins, because browsers report `''` or
 * `application/octet-stream` for `.svga` and vary on `.json`.
 */
export function mediaTypeOf(file: File): MediaType | null {
  const byExt = MEDIA_EXTENSIONS[extOf(file.name)];
  if (byExt) return byExt;
  return file.type in MEDIA_TYPES ? (file.type as MediaType) : null;
}

/** What a URL most likely points at, for previews. */
export function mediaTypeOfUrl(url: string): MediaType | null {
  try {
    return MEDIA_EXTENSIONS[extOf(new URL(url).pathname)] ?? null;
  } catch {
    return null;
  }
}

export const isImage = (t: MediaType | null) => !!t && t.startsWith('image/');

const mb = (bytes: number) => `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;

/** Types a slot accepts: the kind's, narrowed to `only` when given (one rendition per field). */
function typesFor(kind: AdminUploadKind, only?: readonly MediaType[]): readonly MediaType[] {
  const all = ADMIN_UPLOAD_KINDS[kind].types as readonly MediaType[];
  return only ? all.filter((t) => only.includes(t)) : all;
}

/** Human list of accepted formats, e.g. "PNG, WEBP, SVGA". */
export function describeAccepted(kind: AdminUploadKind, only?: readonly MediaType[]): string {
  const exts = [...new Set(typesFor(kind, only).map((t) => MEDIA_TYPES[t].ext))];
  return `${exts.map((e) => e.toUpperCase()).join(', ')} up to ${mb(ADMIN_UPLOAD_KINDS[kind].maxBytes)}`;
}

/** The `accept` attribute for the file picker: MIME types plus extensions. */
export function acceptAttr(kind: AdminUploadKind, only?: readonly MediaType[]): string {
  const types = typesFor(kind, only);
  return [...types, ...types.map((t) => `.${MEDIA_TYPES[t].ext}`)].join(',');
}

/** Client-side check mirroring the server's; returns an error message or null. */
export function checkFile(
  kind: AdminUploadKind,
  file: File,
  only?: readonly MediaType[],
): string | null {
  const spec = ADMIN_UPLOAD_KINDS[kind];
  const type = mediaTypeOf(file);
  if (!type || !typesFor(kind, only).includes(type))
    return `${file.name}: unsupported file type. Use ${describeAccepted(kind, only)}.`;
  if (file.size === 0) return `${file.name} is empty.`;
  if (file.size > spec.maxBytes)
    return `${file.name} is ${mb(file.size)}; the limit is ${mb(spec.maxBytes)}.`;
  return null;
}

export class UploadError extends Error {}

/**
 * Presigns with the API, then PUTs the bytes straight to the bucket. The signed URL fixes the
 * type, size and cache headers, so the PUT must send exactly what the API returned.
 */
export async function uploadAsset(
  kind: AdminUploadKind,
  file: File,
  opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<{ url: string; type: MediaType }> {
  const problem = checkFile(kind, file);
  if (problem) throw new UploadError(problem);
  const type = mediaTypeOf(file)!;
  const p = await send<Presigned>('post', '/admin/uploads/presign', {
    kind,
    contentType: type,
    size: file.size,
  });
  try {
    await bucket.put(p.uploadUrl, file, {
      headers: p.headers,
      signal: opts.signal,
      onUploadProgress: (e) => opts.onProgress?.(e.total ? e.loaded / e.total : 0),
    });
  } catch (err) {
    if (isCancel(err)) throw err;
    if (isAxiosError(err) && !err.response)
      throw new UploadError(
        'Could not reach file storage. The bucket CORS rule must allow PUT from this dashboard: ' +
          'use "Apply CORS rule" in Settings → Storage (R2).',
      );
    throw new UploadError(
      `File storage rejected the upload (${isAxiosError(err) ? err.response?.status : 'error'}).`,
    );
  }
  return { url: p.publicUrl, type };
}
