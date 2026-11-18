/**
 * Outside agents (Claude Code, Cursor, any MCP client) as teammates (server/agents/external.ts).
 * Pure: which agent a caller is, the work it is given and the setup text people copy.
 */

/** The most work items one list returns. */
export const MAX_ASSIGNED_WORK = 50;
/** The longest comment an agent leaves with an update. */
export const MAX_WORK_COMMENT = 4000;
/** How much of a comment that mentions an agent is kept for it. */
export const MENTION_EXCERPT_CHARS = 1000;

/** What a binding is: a person's connected MCP app, or one of their API tokens. */
export type BindingKind = "app" | "token";

/** A binding as the resolver sees it: the agent and what it is bound to. */
export type BindingRef = { agentId: string };

export type BindingChoice<T extends BindingRef> =
  | { ok: true; binding: T }
  /** The caller is bound to no agent. */
  | { ok: false; reason: "none" }
  /** Bound to several and named none of them. */
  | { ok: false; reason: "ambiguous" }
  /** Named an agent it isn't bound to (it reads like an agent that doesn't exist). */
  | { ok: false; reason: "notBound" };

/**
 * The agent a caller acts as, from the bindings of the caller as the server verified it (never from
 * anything the caller says): an agent id the caller names only picks among those bindings.
 */
export function chooseBinding<T extends BindingRef>(bindings: readonly T[], requested?: string | null): BindingChoice<T> {
  if (!bindings.length) return { ok: false, reason: "none" };
  if (requested) {
    const match = bindings.find((b) => b.agentId === requested);
    return match ? { ok: true, binding: match } : { ok: false, reason: "notBound" };
  }
  return bindings.length === 1 ? { ok: true, binding: bindings[0] } : { ok: false, reason: "ambiguous" };
}

/**
 * Whether a binding to a connected app still holds: the person's consent for the client predates it
 * (second precision, as consents are stored), so revoking the app and connecting it again ends it.
 */
export function consentHolds(boundAt: Date, consentCreatedAt: Date | null): boolean {
  return consentCreatedAt !== null && consentCreatedAt.getTime() <= boundAt.getTime() + 1000;
}

/** What a mention keeps of the comment's text. */
export const mentionExcerpt = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, MENTION_EXCERPT_CHARS);

/** A short word for the app's name in `claude mcp add`: letters, digits and dashes. */
export function mcpServerName(agentName: string): string {
  const slug = agentName
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  return `leafdesk${slug ? `-${slug}` : ""}`;
}

/** The command that adds Leafdesk's MCP server to Claude Code. */
export const claudeCodeAddCommand = (agentName: string, mcpUrl: string) => `claude mcp add --transport http ${mcpServerName(agentName)} ${mcpUrl}`;

/** The curl line that asks the REST API for the bound agent's work. */
export const workCurl = (apiUrl: string) => `curl -H "Authorization: Bearer $LEAFDESK_TOKEN" ${apiUrl}/assigned-work`;
