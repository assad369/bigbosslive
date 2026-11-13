import { useEffect } from 'react';
import { App, Button, Space } from 'antd';
import { useRegisterSW } from 'virtual:pwa-register/react';

const UPDATE_CHECK_MS = 60 * 60 * 1000;
const NOTICE_KEY = 'pwa-update';

/**
 * Registers the service worker and offers new versions. An update is applied only when the
 * admin clicks Reload, never on its own, so a half-filled form is never thrown away.
 * Admins keep the dashboard open for days, so it also checks hourly and whenever the tab
 * comes back into view.
 */
export function PwaUpdater() {
  const { notification, message } = App.useApp();
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, reg) {
      if (!reg) return;
      const check = () => {
        // A new worker that is still installing will report itself; don't stack checks.
        if (reg.installing || !navigator.onLine) return;
        void reg.update().catch(() => undefined);
      };
      setInterval(check, UPDATE_CHECK_MS);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
    },
    onRegisterError(err) {
      console.warn('Service worker registration failed', err);
    },
  });

  useEffect(() => {
    if (!offlineReady) return;
    void message.success('The dashboard is ready to open offline.');
    setOfflineReady(false);
  }, [offlineReady, setOfflineReady, message]);

  useEffect(() => {
    if (!needRefresh) return;
    notification.info({
      key: NOTICE_KEY,
      title: 'Update available',
      description: 'A new version of the dashboard is ready. Reload when you have saved your work.',
      duration: 0,
      placement: 'bottomRight',
      onClose: () => setNeedRefresh(false),
      actions: (
        <Space>
          <Button
            size="small"
            onClick={() => {
              notification.destroy(NOTICE_KEY);
              setNeedRefresh(false);
            }}
          >
            Later
          </Button>
          <Button size="small" type="primary" onClick={() => void updateServiceWorker(true)}>
            Reload
          </Button>
        </Space>
      ),
    });
  }, [needRefresh, setNeedRefresh, updateServiceWorker, notification]);

  return null;
}
