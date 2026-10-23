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

/** Idempotency key for money-moving admin actions (one per user click). */
export const newIdempotencyKey = () => `admin-${crypto.randomUUID()}`;

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export async function get<T>(url: string, params?: Record<string, unknown>): Promise<T> {
  const clean = params
    ? Object.fromEntries(
        Object.entries(params).filter(([, v]) => v !== undefined && v !== '' && v !== null),
      )
    : undefined;
  return (await api.get<T>(url, { params: clean })).data;
}

export async function send<T>(
  method: 'post' | 'put' | 'patch' | 'delete',
  url: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<T> {
  return (await api.request<T>({ method, url, data: body, headers })).data;
}
