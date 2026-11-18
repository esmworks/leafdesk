import { and, eq, isNull, ne, or } from "drizzle-orm";
import { db } from "@/db";
import { channelLink } from "@/db/schema";
import { trustedServiceUrl } from "./config";

/**
 * Where the Bot Connector serves each Teams chat, as `serviceUrl`. Teams names it in every call;
 * the bot keeps it in memory (for chats that aren't linked yet, to answer them) and on the link
 * (`channel_link.service_url`, for the notifications that come with no call of Teams' and must
 * survive a restart). It is never read from anywhere but a verified call (endpoint.ts), and
 * checked against Microsoft's hosts again whenever it is used (api.ts). This module reads the
 * link table itself: server/chat-apps/links.ts reaches the transports, which reach this.
 */

const known = new Map<string, string>();
const MAX_KNOWN = 5_000;

/** Notes the address a chat is served at; false when it isn't one the bot may use. */
export async function rememberServiceUrl(chat: string, serviceUrl: string, person?: string): Promise<boolean> {
  const url = trustedServiceUrl(serviceUrl);
  if (!url) return false;
  known.delete(chat);
  known.set(chat, url);
  if (known.size > MAX_KNOWN) known.delete(known.keys().next().value!);
  // Every call, since a link made by this very call (`/link <code>`) is there only afterwards; a row that has it already isn't touched.
  if (person) {
    await db
      .update(channelLink)
      .set({ serviceUrl: url })
      .where(
        and(
          eq(channelLink.channel, "teams"),
          eq(channelLink.chatId, chat),
          eq(channelLink.externalUserId, person),
          or(isNull(channelLink.serviceUrl), ne(channelLink.serviceUrl, url)),
        ),
      )
      .catch((error) => console.error("[teams] couldn't keep a chat's address", error instanceof Error ? error.message : error));
  }
  return true;
}

/** Where a chat is served: what a call told, else what its link kept; null when neither knows. */
export async function serviceUrlOf(chat: string): Promise<string | null> {
  const here = known.get(chat);
  if (here) return here;
  const [link] = await db
    .select({ serviceUrl: channelLink.serviceUrl })
    .from(channelLink)
    .where(and(eq(channelLink.channel, "teams"), eq(channelLink.chatId, chat)))
    .limit(1);
  const url = link?.serviceUrl ? trustedServiceUrl(link.serviceUrl) : null;
  if (url) known.set(chat, url);
  return url;
}

/** Tests: forgets the addresses held in memory. */
export function forgetServiceUrls() {
  known.clear();
}
