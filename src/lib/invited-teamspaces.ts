import type { InvitedTeamspace } from "@/db/schema";

/** The teamspaces an invitation carries, as stored (jsonb): well-formed entries only, one per teamspace (owner wins). */
export function invitedTeamspaces(value: unknown): InvitedTeamspace[] {
  const out = new Map<string, InvitedTeamspace["role"]>();
  for (const entry of Array.isArray(value) ? value : []) {
    if (!entry || typeof entry !== "object") continue;
    const { id, role } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !id) continue;
    out.set(id, out.get(id) === "owner" || role === "owner" ? "owner" : "member");
  }
  return [...out].map(([id, role]) => ({ id, role }));
}
