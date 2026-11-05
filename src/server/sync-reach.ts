import { AsyncLocalStorage } from "node:async_hooks";
import { findMembership } from "@/server/access";
import type { FetchReach } from "@/server/connections/fetch";

/**
 * Whether a synced database's calls may reach the hosts in CONNECTOR_ALLOWED_HOSTS (servers on the
 * same machine or network, plain http included). That list is for what owners set up, while any
 * member may set up a sync where they may make a database: so only a sync set up, changed or run
 * by an owner of its workspace reaches those hosts; anyone else's is held to public addresses (and
 * WEB_FETCH_ALLOWED_HOSTS, which every member reaches anyway). The role is read each time, as the
 * person a sync runs as is checked again on every run.
 *
 * Outside `withSyncReach` a sync's calls get the member's reach, so a path that forgets it stays
 * on public addresses.
 */

const g = globalThis as unknown as { __leafdeskSyncReach?: AsyncLocalStorage<boolean> };
const storage = (g.__leafdeskSyncReach ??= new AsyncLocalStorage<boolean>());

/** Runs `fn` with the reach of a sync set up, changed or run by `userId` in `workspaceId`. */
export async function withSyncReach<T>(userId: string, workspaceId: string, fn: () => Promise<T>): Promise<T> {
  const membership = await findMembership(userId, workspaceId);
  return storage.run(membership?.role === "owner", fn);
}

/** Whether the sync under way may reach CONNECTOR_ALLOWED_HOSTS (see above). */
export const syncReachesAllowedHosts = () => storage.getStore() === true;

/** What the sync under way's fetches may reach (connections/fetch.ts). */
export const syncFetchReach = (web = false): FetchReach => ({ web, untrusted: !syncReachesAllowedHosts() });
