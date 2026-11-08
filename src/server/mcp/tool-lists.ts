import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { connectedAppTools, oauthClient, oauthConsent } from "@/db/schema";
import type { ToolList } from "./catalog";

/**
 * Which tools a person's MCP app lists (catalog.ts): every one, or the core ones and the gates to
 * the rest. Most apps send every listed tool's definition to the model at the start of each
 * conversation, so they get the core list; an app that loads a definition only when it needs one
 * lists them all, each asked about on its own. The person changes it per app in Settings >
 * Connected apps (table connected_app_tools); without a choice, the app's name decides.
 */

/** Claude Code registers itself as "Claude Code (<the server's name in its settings>)" and loads tools as it needs them. */
export const listsAllByDefault = (clientName: string | null | undefined) => typeof clientName === "string" && clientName.startsWith("Claude Code (");

/** The list `clientId` shows `userId`: their choice, else as the app's name says. */
export async function toolListOf(userId: string, clientId: string): Promise<ToolList> {
  const [row] = await db
    .select({ allTools: connectedAppTools.allTools, name: oauthClient.name })
    .from(oauthClient)
    .leftJoin(connectedAppTools, and(eq(connectedAppTools.clientId, oauthClient.clientId), eq(connectedAppTools.userId, userId)))
    .where(eq(oauthClient.clientId, clientId))
    .limit(1);
  return (row?.allTools ?? listsAllByDefault(row?.name)) ? "all" : "core";
}

/** Sets whether an app the person connected lists every tool; false when they haven't connected it. */
export async function setAllTools(userId: string, clientId: string, all: boolean): Promise<boolean> {
  const [consent] = await db
    .select({ clientId: oauthConsent.clientId })
    .from(oauthConsent)
    .where(and(eq(oauthConsent.userId, userId), eq(oauthConsent.clientId, clientId)))
    .limit(1);
  if (!consent) return false;
  const now = new Date();
  await db
    .insert(connectedAppTools)
    .values({ userId, clientId, allTools: all, updatedAt: now })
    .onConflictDoUpdate({ target: [connectedAppTools.userId, connectedAppTools.clientId], set: { allTools: all, updatedAt: now } });
  return true;
}
