import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Work one user does for another: an agent's run started by a member's change to a row. Inside
 * `runActingFor`, the access checks (accessRank in access.ts, propertyAccessFor) give the agent
 * only what both it and that member may: a page or a value the member can't see stays out of the
 * run, however widely the agent's own access reaches. Checks for anyone else in the same work
 * (who gets notified, who may approve) are their own.
 */
export type ActingFor = { userId: string; forUserId: string };

// One per process: route modules can be loaded more than once in development.
const globalForActing = globalThis as unknown as { __leafdeskActingFor?: AsyncLocalStorage<ActingFor> };
const storage = (globalForActing.__leafdeskActingFor ??= new AsyncLocalStorage<ActingFor>());

/** Runs `fn` with `userId` (an agent) held to what `forUserId` (the member it works for) may as well. */
export function runActingFor<T>(call: ActingFor, fn: () => T): T {
  return storage.run({ ...call }, fn);
}

/** The member whose access also bounds `userId` here, if `userId` is acting for someone. */
export function actingFor(userId: string): string | null {
  const current = storage.getStore();
  return current && current.userId === userId ? current.forUserId : null;
}
