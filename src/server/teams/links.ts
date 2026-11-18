import { env } from "@/lib/env";
import { chatNotificationsOn, createChatLinkCode, linkView, setChatNotifications, unlinkChat, type ChatLinkView } from "@/server/chat-apps/links";
import { teamsOn } from "./config";

/**
 * Teams links (server/chat-apps/links.ts) as the settings make them: a one-time code the person
 * sends the app as `/link <code>`, in their chat with it.
 */

/** What the settings show: whether the server has a Teams bot, where the app's chat opens, and the person's link. */
export type TeamsStatus = { enabled: boolean; openUrl: string | null; link: ChatLinkView | null };

/** The deep link that opens the person's chat with the app (once their organization has added it to Teams). */
export const teamsOpenUrl = () => (env.teamsAppId ? `https://teams.microsoft.com/l/chat/0/0?users=28:${encodeURIComponent(env.teamsAppId)}` : null);

export async function getTeamsStatus(userId: string): Promise<TeamsStatus> {
  if (!teamsOn()) return { enabled: false, openUrl: null, link: null };
  return { enabled: true, openUrl: teamsOpenUrl(), link: await linkView("teams", userId) };
}

/** Whether the person's notifications go to their chat with the Teams app. */
export const teamsNotificationsOn = (userId: string) => chatNotificationsOn("teams", userId);

export const setTeamsNotifications = (userId: string, on: boolean) => setChatNotifications("teams", userId, on);

/**
 * A new link code for the person (replacing one they had), as the command that sends it. A session
 * a sign-in policy holds back can't make one (createChatLinkCode).
 */
export async function createTeamsLinkCode(userId: string): Promise<{ command: string; expiresAt: Date }> {
  if (!teamsOn()) throw new Error("Teams is not set up on this server");
  const { code, expiresAt } = await createChatLinkCode("teams", userId);
  return { command: `/link ${code}`, expiresAt };
}

/** Unlinks the person's Teams account, telling them there; false when none was linked. */
export const unlinkTeams = (userId: string, notice?: string) => unlinkChat("teams", userId, notice);
