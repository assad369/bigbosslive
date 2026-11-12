import { createContext, useContext } from 'react';
import type { User } from '@firebase/auth';
import type { AdminRole } from '@bigboss/shared';

export interface AdminMe {
  uid: string;
  displayName: string;
  avatarUrl: string | null;
  role: AdminRole;
  permissions: string[];
}

export type Status = 'loading' | 'signed_out' | 'forbidden' | 'ready';

export interface AuthState {
  status: Status;
  user: User | null;
  me: AdminMe | null;
  error: string | null;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  /** True when the signed-in account has an email + password sign-in. */
  hasPasswordLogin: boolean;
  /**
   * Re-authenticates with `current`, then sets `next`. Firebase signs out the account's other
   * sessions; this one keeps going on a fresh token. Throws an `Error` with a readable message.
   */
  changePassword(current: string, next: string): Promise<void>;
  /** Mirrors the server's permission matrix (from GET /admin/me). The server still enforces it. */
  can(permission: string): boolean;
}

/** `field` says which form field the message belongs to. */
export class PasswordChangeError extends Error {
  constructor(
    readonly field: 'current' | 'next' | 'no_email' | 'other',
    message: string,
  ) {
    super(message);
    this.name = 'PasswordChangeError';
  }
}

export const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
