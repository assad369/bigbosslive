import { useSyncExternalStore } from 'react';

/** Chromium's install prompt event (not in lib.dom). */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

// Module scope, so an event that fires before the layout mounts is not lost.
let deferred: BeforeInstallPromptEvent | null = null;
const installListeners = new Set<() => void>();
const notifyInstall = () => installListeners.forEach((l) => l());

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // We offer it from the profile menu instead of the mini-infobar.
    deferred = e as BeforeInstallPromptEvent;
    notifyInstall();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    notifyInstall();
  });
}

function subscribeInstall(cb: () => void) {
  installListeners.add(cb);
  return () => installListeners.delete(cb);
}

/**
 * Whether the browser offers to install the dashboard (Chromium only; iOS uses
 * Share → Add to Home Screen), and the action that shows its prompt.
 */
export function useInstallPrompt(): { canInstall: boolean; install: () => Promise<void> } {
  const canInstall = useSyncExternalStore(
    subscribeInstall,
    () => deferred !== null,
    () => false,
  );
  const install = async () => {
    const e = deferred;
    if (!e) return;
    // A prompt event can be used once, whatever the answer.
    deferred = null;
    notifyInstall();
    await e.prompt();
    await e.userChoice.catch(() => undefined);
  };
  return { canInstall, install };
}

function subscribeOnline(cb: () => void) {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
}

/** The browser's view of connectivity, updated on `online` / `offline`. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}
