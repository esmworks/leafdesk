import { eq } from "drizzle-orm";
import { db } from "@/db";
import { workspace } from "@/db/schema";
import { formatIpAddress, ipAllowed, parseAllowedNetworks, storedAllowedNetworks, type AllowedNetwork } from "@/lib/ip-allowlist";
import { requireMember, requireMembership } from "@/server/access";
import { recordAudit } from "@/server/audit";
import { getCollab } from "@/server/collab/bridge";
import { refuseInLocalMode } from "@/server/local-mode";
import { WorkspaceError } from "@/server/workspaces";

/**
 * A workspace's approved networks (lib/ip-allowlist, `workspace.allowed_networks`): owners set them
 * in Settings > Security, and while there are any, browser sessions from other addresses are held
 * back from the workspace like the other sign-in policies hold them back (policyHold in access.ts).
 * MCP's OAuth tokens, REST API tokens and SCIM tokens stay outside: they answer to the
 * connected-apps setting. Instance administrators clear a list on /admin (instance-admin.ts).
 */

/** The list as it is, for owners: it maps where people work from, so members only get its length. */
export async function getAllowedNetworks(userId: string, workspaceId: string): Promise<AllowedNetwork[]> {
  await requireMembership(userId, workspaceId, "owner");
  return storedNetworks(workspaceId);
}

/** How many approved networks there are (0: any network), for members (guests don't see workspace settings). */
export async function allowedNetworkCount(userId: string, workspaceId: string): Promise<number> {
  await requireMember(userId, workspaceId);
  return (await storedNetworks(workspaceId)).length;
}

async function storedNetworks(workspaceId: string) {
  const [row] = await db.select({ networks: workspace.allowedNetworks }).from(workspace).where(eq(workspace.id, workspaceId)).limit(1);
  return storedAllowedNetworks(row?.networks);
}

/**
 * Replaces the list. Owners only. `clientIp` is the address of the owner's request (never anything
 * the browser says about itself): a list it isn't on would shut them out the moment it is saved,
 * so it is refused (`ipLocksYouOut`, with the address as the detail); an empty list always goes.
 * Open connections the new list holds back are closed. Returns the list as saved (canonical).
 */
export async function setAllowedNetworks(
  actorId: string,
  workspaceId: string,
  input: unknown,
  { clientIp }: { clientIp: string | null },
): Promise<AllowedNetwork[]> {
  refuseInLocalMode();
  await requireMembership(actorId, workspaceId, "owner");
  const parsed = parseAllowedNetworks(input);
  if (!parsed.ok) {
    if (parsed.problem === "tooMany") throw new WorkspaceError("tooManyNetworks", "Too many approved networks");
    if (parsed.problem === "label") throw new WorkspaceError("invalidNetworkLabel", "A label is too long", parsed.entry);
    throw new WorkspaceError("invalidNetwork", `Can't read ${parsed.entry || "that"} as an address or range`, parsed.entry);
  }
  const { networks } = parsed;
  if (networks.length > 0 && !ipAllowed(clientIp, networks)) {
    const shown = formatIpAddress(clientIp) ?? "";
    throw new WorkspaceError("ipLocksYouOut", `Your own address (${shown || "unknown"}) isn't on the list`, shown);
  }
  await writeNetworks(workspaceId, networks, actorId, "workspace.networks_changed");
  return networks;
}

/**
 * Writes the list with its audit event, in one transaction, and closes the connections it now
 * holds back. For setAllowedNetworks and the instance administrators' clearing (instance-admin.ts).
 */
export async function writeNetworks(
  workspaceId: string,
  networks: AllowedNetwork[],
  actorId: string,
  action: "workspace.networks_changed" | "workspace.networks_cleared",
) {
  const changed = await db.transaction(async (tx) => {
    const [before] = await tx
      .select({ networks: workspace.allowedNetworks })
      .from(workspace)
      .where(eq(workspace.id, workspaceId))
      .for("update");
    if (!before) return false;
    const previous = storedAllowedNetworks(before.networks);
    if (JSON.stringify(previous) === JSON.stringify(networks)) return false;
    await tx.update(workspace).set({ allowedNetworks: networks }).where(eq(workspace.id, workspaceId));
    await recordAudit(
      {
        workspaceId,
        actorId,
        action,
        target: { type: "workspace", id: workspaceId },
        details: { names: networks.map((n) => (n.label ? `${n.range} (${n.label})` : n.range)), count: networks.length, previous: previous.length },
      },
      tx,
    );
    return true;
  });
  // Open editors were let in before; the ones the new list holds back reconnect and are refused.
  if (changed && networks.length > 0) await getCollab().disconnectHeldBack(workspaceId);
}
