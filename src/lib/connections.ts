/**
 * Connections: services outside Leafdesk that a workspace's agents use, each a remote MCP server
 * (Slack, GitHub, Linear, a CRM…). Not to be confused with connected apps, which are programs that
 * use Leafdesk. Owners of the workspace add them; the credentials belong to the workspace, not to
 * whoever added them, and never leave the server.
 *
 * An agent uses only the tools an owner allowed it on each connection. A tool that only reads runs
 * at once; any other waits for an owner's approval, and nothing is sent if no one answers in a day.
 * Each connection also has an address that takes signed events (a new Slack message, a GitHub
 * issue…), and a trigger can run an agent on them.
 */

export const MAX_CONNECTIONS = 20;
export const MAX_CONNECTION_NAME = 80;
export const MAX_CONNECTION_URL = 2_000;
export const MAX_CONNECTION_TOKEN = 4_000;
/** The most tools of a connection that are kept (and offered to agents). */
export const MAX_CONNECTION_TOOLS = 200;
/** The most triggers a connection has. */
export const MAX_CONNECTION_TRIGGERS = 20;
export const MAX_TRIGGER_EVENT = 100;

/** How long one call to a connection's tool may take. */
export const CONNECTION_CALL_TIMEOUT_MS = 30_000;
/** The most of one tool's answer an agent reads. */
export const MAX_TOOL_RESULT_CHARS = 8_000;
/** The most of all tools' answers one run reads from connections. */
export const MAX_RUN_EXTERNAL_CHARS = 40_000;
/** How long a call waits for approval before it fails, sending nothing. */
export const APPROVAL_TIMEOUT_MS = 24 * 60 * 60_000;
/** The most of a note sent back with "Redo". */
export const MAX_REDO_NOTE = 1_000;

/** The largest event body taken. */
export const MAX_EVENT_BYTES = 256 * 1024;
/** How far an event's timestamp may be from now. */
export const EVENT_TOLERANCE_SECONDS = 5 * 60;
/** How long received events are kept (for the settings' list and against replays). */
export const CONNECTION_EVENT_DAYS = 7;

export const CONNECTION_AUTH_TYPES = ["oauth", "token", "none"] as const;
export type ConnectionAuthType = (typeof CONNECTION_AUTH_TYPES)[number];

export const isConnectionAuthType = (value: unknown): value is ConnectionAuthType =>
  typeof value === "string" && (CONNECTION_AUTH_TYPES as readonly string[]).includes(value);

/**
 * How a connection's events are signed:
 * - `hmac`: Leafdesk's own scheme, as its outgoing webhooks sign (Zapier, Make, n8n, your CRM);
 * - `slack`: Slack's Events API (`X-Slack-Signature`, and its URL check answered);
 * - `github`: GitHub webhooks (`X-Hub-Signature-256`, `X-GitHub-Event`, `X-GitHub-Delivery`).
 */
export const EVENT_PRESETS = ["hmac", "slack", "github"] as const;
export type EventPreset = (typeof EVENT_PRESETS)[number];

export const isEventPreset = (value: unknown): value is EventPreset =>
  typeof value === "string" && (EVENT_PRESETS as readonly string[]).includes(value);

/** Where a connection stands: usable, waiting for someone to sign in to the service, or failing. */
export const CONNECTION_STATUSES = ["ready", "needsAuth", "error"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/** Whether a tool only reads (runs at once) or may change something (waits for approval). */
export type ToolKind = "read" | "write";

/** A tool of a connection, as listed by its server and classed. */
export type ConnectionTool = {
  name: string;
  title: string | null;
  description: string;
  /** JSON Schema of its input. */
  inputSchema: Record<string, unknown>;
  /** How the server marked it: read-only, or not (no mark counts as writing). */
  hinted: ToolKind;
  /** An owner's override of the server's mark, if any. */
  kind: ToolKind;
};

/** A connection as the settings show it: never its secrets, only whether it has them. */
export type ConnectionView = {
  id: string;
  name: string;
  icon: string | null;
  url: string;
  authType: ConnectionAuthType;
  hasToken: boolean;
  status: ConnectionStatus;
  statusError: string | null;
  tools: ConnectionTool[];
  toolsAt: string | null;
  eventPreset: EventPreset;
  /** The address its events go to. */
  eventUrl: string;
  createdBy: string | null;
  createdAt: string;
};

/** What a trigger runs: an agent, with a task, on a connection's events of one type (or any). */
export type ConnectionTriggerView = {
  id: string;
  connectionId: string;
  agentId: string;
  eventType: string | null;
  prompt: string;
  enabled: boolean;
  createdAt: string;
};

/** What became of a received event. */
export type ConnectionEventStatus = "queued" | "ignored" | "rejected";

export type ConnectionEventView = {
  id: string;
  eventType: string;
  status: ConnectionEventStatus;
  /** Why it was rejected or ignored, or how many runs it queued. */
  note: string;
  receivedAt: string;
};

/** The tools an agent may use on a connection. */
export type AgentGrantView = { connectionId: string; tools: string[] };

/**
 * Codes for errors the settings and MCP show in the person's language (`connections.errors.<code>`).
 */
export const CONNECTION_ERROR_CODES = [
  "invalidName",
  "invalidUrl",
  "blocked",
  "unreachable",
  "notMcp",
  "unauthorized",
  "tooMany",
  "notFound",
  "invalidToken",
  "invalidTrigger",
  "unknownTool",
  "oauthFailed",
] as const;
export type ConnectionErrorCode = (typeof CONNECTION_ERROR_CODES)[number];

/** A name for the model: the connection's slug and the tool's name, within 64 characters. */
export function namespacedTool(slug: string, tool: string) {
  const safe = tool.replace(/[^A-Za-z0-9_-]/g, "_");
  return `${slug}__${safe}`.slice(0, 64);
}

/**
 * The slug of a connection's tools for the model, from its name: lower-case letters and digits,
 * at most 12, never empty; `taken` holds the slugs of the workspace's other connections.
 */
export function connectionSlug(name: string, taken: ReadonlySet<string>) {
  const base =
    name
      .normalize("NFKD")
      .toLowerCase()
      // Letters that don't decompose to a Latin one.
      .replace(/[ıłøđßæœ]/g, (c) => ({ ı: "i", ł: "l", ø: "o", đ: "d", ß: "ss", æ: "ae", œ: "oe" })[c] ?? "")
      .replace(/[^a-z0-9]+/g, "")
      .slice(0, 10) || "conn";
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const slug = `${base.slice(0, 10)}${i}`;
    if (!taken.has(slug)) return slug;
  }
  return `${base.slice(0, 6)}${Math.random().toString(36).slice(2, 6)}`;
}
