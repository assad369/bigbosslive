import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  onIdTokenChanged,
  signInWithEmailAndPassword,
  signOut as fbSignOut,
  type User,
} from '@firebase/auth';
import { auth } from '../lib/firebase';
import { ApiError, get } from '../lib/api';

import { AuthContext, type AdminMe, type AuthState, type Status } from './useAuth';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<User | null>(null);
  const [me, setMe] = useState<AdminMe | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () =>
      // Fires on sign-in, sign-out and token refresh — the role claim travels in the token.
      onIdTokenChanged(auth, async (u) => {
        setUser(u);
        if (!u) {
          setMe(null);
          setStatus('signed_out');
          return;
        }
        try {
          setMe(await get<AdminMe>('/admin/me'));
          setStatus('ready');
          setError(null);
        } catch (err) {
          setMe(null);
          if (err instanceof ApiError && (err.status === 403 || err.code === 'profile_required')) {
            setStatus('forbidden');
          } else {
            setError(err instanceof Error ? err.message : 'Could not reach the server');
            setStatus('signed_out');
          }
        }
      }),
    [],
  );

  const signIn = useCallback(async (email: string, password: string) => {
    setError(null);
    await signInWithEmailAndPassword(auth, email, password);
  }, []);

  const signOut = useCallback(async () => {
    await fbSignOut(auth);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      status,
      user,
      me,
      error,
      signIn,
      signOut,
      can: (p) => Boolean(me?.permissions.includes(p)),
    }),
    [status, user, me, error, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
