import { and, asc, eq, isNull, ne } from "drizzle-orm";
import { db } from "@/db";
import { channel, channelMember } from "@/db/schema";
import { requireChannel } from "./core";

/**
 * The channels an automation's "Post in a channel" step may pick (server/automations): those of the
 * workspace its person is in and may write in, never direct conversations or archived channels.
 * Whether they still may is asked again when the step runs (sendMessage).
 */

export type ChannelChoice = { id: string; name: string; kind: "public" | "private" };

/** The channels `userId` is in and can post in, by name. */
export async function writableChannels(userId: string, workspaceId: string): Promise<ChannelChoice[]> {
  const rows = await db
    .select({ id: channel.id, name: channel.name, kind: channel.kind, posting: channel.posting, role: channelMember.role })
    .from(channel)
    .innerJoin(channelMember, and(eq(channelMember.channelId, channel.id), eq(channelMember.userId, userId)))
    .where(and(eq(channel.workspaceId, workspaceId), ne(channel.kind, "direct"), isNull(channel.archivedAt)))
    .orderBy(asc(channel.name));
  return rows.filter((r) => r.posting !== "admins" || r.role === "admin").map((r) => ({ id: r.id, name: r.name ?? "", kind: r.kind === "private" ? "private" : "public" }));
}

/** The channel `ref` names (its id, or its name with or without `#`) when `userId` can post in it; null otherwise. */
export async function writableChannel(userId: string, workspaceId: string, ref: string): Promise<string | null> {
  const wanted = ref.trim();
  if (!wanted) return null;
  const choices = await writableChannels(userId, workspaceId);
  const name = wanted.replace(/^#/, "").toLowerCase();
  const found = choices.find((c) => c.id === wanted) ?? choices.find((c) => c.name.toLowerCase() === name);
  if (!found) return null;
  try {
    await requireChannel(userId, found.id, "write");
    return found.id;
  } catch {
    return null;
  }
}
