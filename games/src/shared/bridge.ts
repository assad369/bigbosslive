/**
 * Bridge between a game page and the native app hosting it in a WebView.
 *
 * The app opens `…/golden-wheel/#token=<firebase id token>&api=<api origin>` — the fragment is
 * never sent to any server. When the token expires the game asks the app for a new one over
 * the `BigBossBridge` JavaScript channel and the app answers by calling `window.bbSetToken()`.
 */

type NativeMessage =
  | { type: 'ready'; game: string }
  | { type: 'token_expired' }
  | { type: 'close' }
  | { type: 'recharge' }
  | { type: 'balance'; diamonds: number };

declare global {
  interface Window {
    BigBossBridge?: { postMessage(message: string): void };
    bbSetToken?: (token: string) => void;
  }
}

const params = new URLSearchParams(location.hash.slice(1));
let token =
  params.get('token') ??
  (import.meta.env.DEV ? new URLSearchParams(location.search).get('devToken') : null) ??
  '';
const listeners = new Set<(t: string) => void>();
let pendingRefresh: Promise<string> | null = null;

// Scrub the token from the address bar so it cannot leak via screenshots or history.
if (params.has('token')) history.replaceState(null, '', location.pathname + location.search);

window.bbSetToken = (next: string) => {
  token = next;
  listeners.forEach((l) => l(next));
};

export const apiOrigin = (
  params.get('api') ??
  (import.meta.env.VITE_API_URL as string | undefined) ??
  'http://localhost:3000'
).replace(/\/$/, '');

export function currentToken(): string {
  return token;
}

export function onTokenChange(listener: (t: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function postToApp(message: NativeMessage): void {
  window.BigBossBridge?.postMessage(JSON.stringify(message));
}

/** Ask the host app for a fresh token; resolves when `bbSetToken` is called (or after 8s). */
export function refreshToken(): Promise<string> {
  if (!window.BigBossBridge) return Promise.resolve(token);
  pendingRefresh ??= new Promise<string>((resolve) => {
    const timeout = setTimeout(() => done(token), 8000);
    const off = onTokenChange((t) => done(t));
    function done(t: string) {
      clearTimeout(timeout);
      off();
      pendingRefresh = null;
      resolve(t);
    }
    postToApp({ type: 'token_expired' });
  });
  return pendingRefresh;
}

export const embedded = Boolean(window.BigBossBridge);
