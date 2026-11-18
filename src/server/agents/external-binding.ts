/**
 * What ties an outside agent (kind `external`, see external.ts) to the app or token it is reached
 * through. A leaf module, so archiving an agent (manage.ts) can cut it off without a cycle.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { apiToken, externalAgentBinding } from "@/db/schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Removes the agent's binding and, when it was bound to a token of its own, the token (the token's
 * row goes with the binding's, as the foreign key says). Returns whether there was one.
 */
export async function dropExternalBinding(tx: Tx | typeof db, agentId: string): Promise<boolean> {
  const [binding] = await tx.select({ tokenId: externalAgentBinding.tokenId }).from(externalAgentBinding).where(eq(externalAgentBinding.agentId, agentId));
  if (!binding) return false;
  await tx.delete(externalAgentBinding).where(eq(externalAgentBinding.agentId, agentId));
  if (binding.tokenId) await tx.delete(apiToken).where(eq(apiToken.id, binding.tokenId));
  return true;
}
