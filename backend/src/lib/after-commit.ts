import type { ClientSession } from 'mongodb';

/**
 * Work to run once a transaction has committed: broadcasts and other side effects that must
 * never run for a write that rolled back, and must never fail the write itself.
 *
 * `Database.withTransaction` calls `beginAttempt` before every attempt (the driver retries the
 * body on transient errors, so callbacks from a failed attempt are discarded) and `flush` after
 * the commit.
 */
type Callback = () => void | Promise<void>;

const pending = new WeakMap<ClientSession, Map<string, Callback>>();

/**
 * Queue `fn` to run after `session` commits. A `key` deduplicates: registering the same key
 * twice in one transaction runs it once (the last registration wins). Outside a transaction
 * wrapper the callback is simply dropped, so call it only with a `withTransaction` session.
 */
export function onCommit(session: ClientSession, fn: Callback, key?: string): void {
  const queue = pending.get(session);
  if (!queue) return;
  queue.set(key ?? `#${queue.size}:${Math.random()}`, fn);
}

export function beginAttempt(session: ClientSession): void {
  pending.set(session, new Map());
}

export function discard(session: ClientSession): void {
  pending.delete(session);
}

/** Run the queued callbacks. Errors go to `onError`, never to the caller. */
export async function flush(
  session: ClientSession,
  onError: (err: unknown) => void,
): Promise<void> {
  const queue = pending.get(session);
  pending.delete(session);
  if (!queue) return;
  for (const fn of queue.values()) {
    try {
      await fn();
    } catch (err) {
      onError(err);
    }
  }
}
