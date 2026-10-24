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
  /** Mirrors the server's permission matrix (from GET /admin/me). The server still enforces it. */
  can(permission: string): boolean;
}

export const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
