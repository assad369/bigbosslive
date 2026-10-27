import { createContext, useMemo, useState } from 'react';

export interface Tracker {
  /** Marks an upload in flight; call the returned function when it settles. */
  begin(): () => void;
}

/** Lets a form know uploads are in flight, so it can block saving a stale URL. */
export const UploadTracker = createContext<Tracker | null>(null);

/** `[inFlight, Provider value]` for a form that hosts `MediaUpload`s. */
export function useUploadTracker(): [number, Tracker] {
  const [count, setCount] = useState(0);
  const tracker = useMemo<Tracker>(
    () => ({
      begin() {
        setCount((n) => n + 1);
        let done = false;
        return () => {
          if (done) return;
          done = true;
          setCount((n) => n - 1);
        };
      },
    }),
    [],
  );
  return [count, tracker];
}

export const UploadTrackerProvider = UploadTracker.Provider;
