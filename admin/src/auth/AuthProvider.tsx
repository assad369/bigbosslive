import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  EmailAuthProvider,
  onIdTokenChanged,
  reauthenticateWithCredential,
  signInWithEmailAndPassword,
  signOut as fbSignOut,
  updatePassword,
  type User,
} from '@firebase/auth';
import { auth } from '../lib/firebase';
import { ApiError, get, send } from '../lib/api';

import {
  AuthContext,
  PasswordChangeError,
  type AdminMe,
  type AuthState,
  type Status,
} from './useAuth';

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
          try {
            setMe(await get<AdminMe>('/admin/me'));
          } catch (err) {
            // An admin who has never opened the app has no profile yet; bootstrap it once.
            if (!(err instanceof ApiError && err.code === 'profile_required')) throw err;
            await send('post', '/auth/session', {});
            setMe(await get<AdminMe>('/admin/me'));
          }
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

  const changePassword = useCallback(async (current: string, next: string) => {
    const u = auth.currentUser;
    if (!u?.email) throw new PasswordChangeError('no_email', 'This account has no email sign-in');
    try {
      // Firebase only lets a recently signed-in user change the password, and the current
      // password proves it is really them.
      await reauthenticateWithCredential(u, EmailAuthProvider.credential(u.email, current));
    } catch (err) {
      throw passwordError(err, true);
    }
    try {
      await updatePassword(u, next);
    } catch (err) {
      throw passwordError(err, false);
    }
  }, []);

  const hasPasswordLogin = Boolean(
    user?.email && user.providerData.some((p) => p.providerId === 'password'),
  );

  const value = useMemo<AuthState>(
    () => ({
      status,
      user,
      me,
      error,
      signIn,
      signOut,
      hasPasswordLogin,
      changePassword,
      can: (p) => Boolean(me?.permissions.includes(p)),
    }),
    [status, user, me, error, signIn, signOut, hasPasswordLogin, changePassword],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function passwordError(err: unknown, reauth: boolean): PasswordChangeError {
  const code = (err as { code?: unknown } | null)?.code;
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/invalid-login-credentials':
      return new PasswordChangeError('current', 'Current password is incorrect');
    case 'auth/too-many-requests':
      return new PasswordChangeError(
        'other',
        'Too many attempts. Wait a few minutes and try again',
      );
    case 'auth/weak-password':
    case 'auth/password-does-not-meet-requirements':
      return new PasswordChangeError(
        'next',
        (err as Error).message.replace(/^Firebase: /, '') || 'Choose a stronger password',
      );
    case 'auth/requires-recent-login':
    case 'auth/user-token-expired':
      return new PasswordChangeError('other', 'Your session expired. Sign out and sign in again');
    case 'auth/network-request-failed':
      return new PasswordChangeError('other', 'Network error. Check your connection');
    default:
      return new PasswordChangeError(
        'other',
        reauth ? 'Could not verify your current password' : 'Could not change the password',
      );
  }
}
