/**
 * Who could reach a page when an audit event happened (server/page-audience.ts reads it), the widest
 * that applies:
 * - `web`: it or a page above it is published, and the link still works;
 * - `workspace`: everyone in the workspace (an "everyone" entry on a private page, or a teamspace
 *   every member is in, named in `teamspace`);
 * - `teamspace`: the members of the teamspace named in `teamspace`;
 * - `people`: only the people and groups it is shared with (`people` and `groups` count them);
 * - `private`: one person at most.
 */
export type PageAudience =
  | { kind: "web" }
  | { kind: "workspace"; teamspace?: string }
  | { kind: "teamspace"; teamspace: string }
  | { kind: "people"; people: number; groups: number }
  | { kind: "private" };

/**
 * The audience of a page from what decides it: whether it is on the web, its teamspace (null for
 * the private pages; `everyoneIn` for one every member is in), its nearest "everyone" level (null
 * when no entry sets it), and how many people and groups it is shared with (an access other than none).
 */
export function pageAudienceOf(input: {
  published: boolean;
  teamspace: { name: string; everyoneIn: boolean } | null;
  everyone: string | null;
  people: number;
  groups: number;
}): PageAudience {
  if (input.published) return { kind: "web" };
  const closed = input.everyone === "none";
  if (input.teamspace && !closed) {
    return input.teamspace.everyoneIn
      ? { kind: "workspace", teamspace: input.teamspace.name }
      : { kind: "teamspace", teamspace: input.teamspace.name };
  }
  // A private page reaches everyone only through an "everyone" entry.
  if (!input.teamspace && input.everyone !== null && !closed) return { kind: "workspace" };
  if (input.groups > 0 || input.people > 1) return { kind: "people", people: input.people, groups: input.groups };
  return { kind: "private" };
}

/** A stored audience (an event's `details.audience`), or null for anything else. */
export function parseAudience(value: unknown): PageAudience | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  switch (v.kind) {
    case "web":
    case "private":
      return { kind: v.kind };
    case "workspace":
      return typeof v.teamspace === "string" ? { kind: "workspace", teamspace: v.teamspace } : { kind: "workspace" };
    case "teamspace":
      return { kind: "teamspace", teamspace: typeof v.teamspace === "string" ? v.teamspace : "" };
    case "people":
      return { kind: "people", people: Number(v.people) || 0, groups: Number(v.groups) || 0 };
    default:
      return null;
  }
}
