import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Requests from connected apps: MCP clients a user authorized over OAuth (/mcp) and programs with a
 * REST API token (/api/v1). Each workspace's owners decide what those may do there
 * (`connectedApps` in WorkspaceSettings): whatever their user may ("full"), only read ("read"), or
 * nothing, the workspace then being hidden from them ("off").
 * They may also let in only the MCP apps they approved (`onlyApprovedApps`, see appModeHere).
 *
 * The two endpoints run each request inside `runAsConnectedApp`, and the access checks (access.ts)
 * hold it to the policy the way they hold browser sessions to the sign-in policies: a hidden
 * workspace reads as one the user isn't in, and in a read-only one any access check made while
 * `writing` is refused. Writing is decided by the endpoint (a write tool, an endpoint needing
 * pages:write), not by the check, so writes that only ask for membership (a top-level page, say)
 * are refused as well.
 *
 * Only the user the app acts for is held to it: checks on someone else's behalf in the same request
 * (who gets notified, a form's publisher) are not.
 */

export type ConnectedAppsMode = "full" | "read" | "off";

export const CONNECTED_APPS_MODES: readonly ConnectedAppsMode[] = ["full", "read", "off"];

/**
 * Which program the request comes from, for the audit log (server/audit.ts): an MCP client (its
 * OAuth client id) or a REST API token (its id), with the request's address and user agent.
 */
export type ConnectedAppIdentity = {
  kind: "connected_app" | "api_token";
  id: string;
  ip?: string | null;
  userAgent?: string | null;
};

export type ConnectedAppCall = {
  userId: string;
  app: ConnectedAppIdentity | null;
  /** The request changes something: refused in workspaces where connected apps may only read. */
  writing: boolean;
  /** Per workspace id: its setting, asked once per request. Filled by access.ts. */
  modes: Map<string, Promise<ConnectedAppsMode>>;
};

// One per process: route modules can be loaded more than once in development.
const globalForApps = globalThis as unknown as { __leafdeskConnectedApps?: AsyncLocalStorage<ConnectedAppCall> };
const storage = (globalForApps.__leafdeskConnectedApps ??= new AsyncLocalStorage<ConnectedAppCall>());

/** Runs `fn` (an MCP request, a REST API call) as a connected app acting for `userId`. */
export function runAsConnectedApp<T>(call: { userId: string; writing?: boolean; app?: ConnectedAppIdentity }, fn: () => T): T {
  return storage.run({ userId: call.userId, app: call.app ?? null, writing: call.writing ?? false, modes: new Map() }, fn);
}

/**
 * Runs `fn` as a write of the connected app serving this request (an MCP write tool), or just runs
 * it outside one. The workspace settings already asked for stay cached.
 */
export function asWrite<T>(fn: () => T): T {
  const current = storage.getStore();
  return current ? storage.run({ ...current, writing: true }, fn) : fn();
}

/** The connected-app request being served, when it acts for `userId`; null otherwise. */
export function connectedAppCall(userId: string): ConnectedAppCall | null {
  const current = storage.getStore();
  return current && current.userId === userId ? current : null;
}

/** A stored setting as a mode: anything unknown (or unset) is the default, "full". */
export function connectedAppsMode(value: unknown): ConnectedAppsMode {
  return value === "read" || value === "off" ? value : "full";
}

/**
 * Pure: the setting as it holds for one app. Where only approved apps may come
 * (`onlyApprovedApps`), an MCP app owners haven't approved finds the workspace off; REST API tokens
 * and the server's own clients count as approved (`approved` true).
 */
export function appModeHere(mode: ConnectedAppsMode, onlyApproved: boolean, approved: boolean): ConnectedAppsMode {
  return onlyApproved && !approved ? "off" : mode;
}

/**
 * Pure: what the workspace's setting does to a connected-app request. "hidden": the workspace reads
 * as one the user isn't in. "readOnly": the request is a write and apps may only read there.
 */
export function connectedAppRefusal(mode: ConnectedAppsMode, writing: boolean): "hidden" | "readOnly" | null {
  if (mode === "off") return "hidden";
  if (mode === "read" && writing) return "readOnly";
  return null;
}
