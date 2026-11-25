import type { ServerResponse } from "node:http";

const MAX_WAITERS = 1024;
const MAX_OWNER_WAITERS = 2;

// SQLite is the queue. This process-local signal only shortens an idle request.
export function agentInboxWake() {
  const pending = new Map<string, Set<() => void>>();
  let waiting = 0;
  let closing = false;

  function wait(owner: string, ms: number, response: ServerResponse) {
    const callbacks = pending.get(owner) ?? new Set<() => void>();
    if (closing || waiting >= MAX_WAITERS || callbacks.size >= MAX_OWNER_WAITERS || response.destroyed) return null;
    pending.set(owner, callbacks);
    waiting += 1;
    return new Promise<void>(resolve => {
      const timer = setTimeout(finish, ms);
      function finish() {
        if (!callbacks.delete(finish)) return;
        clearTimeout(timer);
        response.off("close", finish);
        waiting -= 1;
        if (!callbacks.size) pending.delete(owner);
        if (closing && !response.destroyed) response.setHeader("connection", "close");
        resolve();
      }
      callbacks.add(finish);
      response.once("close", finish);
    });
  }

  function notify(owner: string) {
    for (const finish of pending.get(owner) ?? []) finish();
  }

  function close() {
    closing = true;
    for (const owner of pending.keys()) notify(owner);
  }

  return { wait, notify, close, hasWaiters: () => waiting > 0 };
}
