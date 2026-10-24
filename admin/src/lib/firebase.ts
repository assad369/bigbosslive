import { initializeApp } from '@firebase/app';
import {
  browserLocalPersistence,
  connectAuthEmulator,
  getAuth,
  setPersistence,
} from '@firebase/auth';

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string | undefined,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined,
  appId: import.meta.env.VITE_FIREBASE_APP_ID as string | undefined,
};

export const firebaseConfigured = Boolean(config.apiKey && config.projectId);

const emulatorUrl = import.meta.env.VITE_FIREBASE_AUTH_EMULATOR_URL as string | undefined;

const app = initializeApp(
  firebaseConfigured ? config : { apiKey: 'unset', projectId: 'demo-bigboss', appId: 'unset' },
);
export const auth = getAuth(app);
// Local development / E2E tests against the Firebase Auth emulator.
if (emulatorUrl) connectAuthEmulator(auth, emulatorUrl, { disableWarnings: true });
void setPersistence(auth, browserLocalPersistence).catch(() => undefined);
