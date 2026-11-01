import { useState } from 'react';
import axios, { type AxiosError } from 'axios';
import type { ApiErrorBody } from '@bigboss/shared';
import { auth } from './firebase';

export const API_URL = (
  (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3000'
).replace(/\/$/, '');

export const api = axios.create({ baseURL: `${API_URL}/v1`, timeout: 20_000 });

api.interceptors.request.use(async (config) => {
  // getIdToken() refreshes transparently when the token is near expiry.
  const token = await auth.currentUser?.getIdToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

api.interceptors.response.use(
  (res) => res,
  (err: AxiosError<ApiErrorBody>) => {
    const body = err.response?.data?.error;
    if (body) {
      const details = Array.isArray(body.details)
        ? (body.details as { path?: string; message?: string }[])
            .map((d) => (d.path ? `${d.path}: ${d.message}` : d.message))
            .join('; ')
        : '';
      return Promise.reject(
        new ApiError(
          err.response!.status,
          body.code,
          details ? `${body.message} — ${details}` : body.message,
          body.details,
        ),
      );
    }
    return Promise.reject(new ApiError(0, 'network', err.message || 'Network error'));
  },
);

/** Idempotency key for money-moving admin actions. Prefer {@link useIntentKey} in dialogs. */
export const newIdempotencyKey = () => `admin-${crypto.randomUUID()}`;

/**
 * One idempotency key per intent: a fresh key each time `open` turns true (a dialog opens),
 * kept for every retry while it stays open. A request that timed out may still have gone
 * through, and a new key per click would then apply the action twice.
 */
export function useIntentKey(open: boolean): string {
  const [state, setState] = useState(() => ({ open, key: newIdempotencyKey() }));
  if (state.open !== open) {
    const next = { open, key: open ? newIdempotencyKey() : state.key };
    setState(next);
    return next.key;
  }
  return state.key;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export async function get<T>(
  url: string,
  params?: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<T> {
  const clean = params
    ? Object.fromEntries(
        Object.entries(params).filter(([, v]) => v !== undefined && v !== '' && v !== null),
      )
    : undefined;
  return (await api.get<T>(url, { params: clean, headers })).data;
}

export async function send<T>(
  method: 'post' | 'put' | 'patch' | 'delete',
  url: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<T> {
  return (await api.request<T>({ method, url, data: body, headers })).data;
}
