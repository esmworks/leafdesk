import { toCsv } from "@/lib/csv";
import { AccessError, requirePeopleManager } from "@/server/access";
import { groupsByMember } from "@/server/groups";
import { blockedByWorkspacePolicy, getSession, policyRefusal } from "@/server/session";
import { lastEdits, listMembers } from "@/server/workspaces";

/** Members as CSV, for owners and membership admins. Anyone else gets 404 so the workspace's existence doesn't leak. */
export async function GET(_request: Request, { params }: { params: Promise<{ workspaceId: string }> }) {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });
  const { workspaceId } = await params;
  const hold = await blockedByWorkspacePolicy(session, workspaceId);
  if (hold) return new Response(policyRefusal(hold), { status: 403 });
  try {
    await requirePeopleManager(session.user.id, workspaceId);
    const [members, edits, groups] = await Promise.all([
      listMembers(session.user.id, workspaceId),
      lastEdits(session.user.id, workspaceId),
      groupsByMember(session.user.id, workspaceId),
    ]);
    const csv = toCsv([
      ["name", "email", "role", "joined_at", "last_edited_at", "groups"],
      ...members.map((m) => [
        m.name,
        m.email,
        m.role,
        m.joinedAt,
        edits.get(m.userId) ?? null,
        (groups.get(m.userId) ?? []).map((g) => g.name).join(", "),
      ]),
    ]);
    const date = new Date().toISOString().slice(0, 10);
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="members-${date}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof AccessError) return new Response("Not found", { status: 404 });
    throw error;
  }
}
