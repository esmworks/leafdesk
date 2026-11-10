import { env } from "@/lib/env";
import { chatNotificationsOn, createChatLinkCode, linkView, setChatNotifications, unlinkChat, type ChatLinkView } from "@/server/chat-apps/links";
import { callSlack } from "./api";

/**
 * Slack links (server/chat-apps/links.ts) as the settings make them: a one-time code the person
 * sends the app as `/leafdesk link <code>`, in their direct message with it.
 */

/** The slash command the app's manifest declares (docs/ai.md). */
export const SLASH_COMMAND = "/leafdesk";

/** What the settings show: whether the server has a Slack app, its bot's name, where it opens, and the person's link. */
export type SlackStatus = { enabled: boolean; bot: string | null; openUrl: string | null; link: ChatLinkView | null };

type Identity = { name: string; teamId: string; appId: string | null };

/** The bot's name, workspace and app (auth.test, bots.info), asked of Slack once per process (and again after a failure). */
let identity: Promise<Identity> | null = null;
export function slackIdentity(): Promise<Identity> {
  identity ??= (async () => {
    const me = await callSlack<{ user?: string; team_id?: string; bot_id?: string }>("auth.test");
    const bot = me.bot_id ? await callSlack<{ bot?: { app_id?: string } }>("bots.info", { bot: me.bot_id }).catch(() => null) : null;
    return { name: me.user ?? "", teamId: me.team_id ?? "", appId: bot?.bot?.app_id ?? null };
  })().catch((error) => {
    identity = null;
    throw error;
  });
  return identity;
}

export const slackOn = () => Boolean(env.slackAppToken && env.slackBotToken);

export async function getSlackStatus(userId: string): Promise<SlackStatus> {
  if (!slackOn()) return { enabled: false, bot: null, openUrl: null, link: null };
  const [link, me] = await Promise.all([linkView("slack", userId), slackIdentity().catch(() => null)]);
  const openUrl = me?.appId && me.teamId ? `https://slack.com/app_redirect?app=${encodeURIComponent(me.appId)}&team=${encodeURIComponent(me.teamId)}` : null;
  return { enabled: true, bot: me?.name ?? null, openUrl, link };
}

/** Whether the person's notifications go to their direct message with the Slack app. */
export const slackNotificationsOn = (userId: string) => chatNotificationsOn("slack", userId);

export const setSlackNotifications = (userId: string, on: boolean) => setChatNotifications("slack", userId, on);

/**
 * A new link code for the person (replacing one they had), as the command that sends it. A session
 * a sign-in policy holds back can't make one (createChatLinkCode).
 */
export async function createSlackLinkCode(userId: string): Promise<{ command: string; expiresAt: Date }> {
  if (!slackOn()) throw new Error("Slack is not set up on this server");
  const { code, expiresAt } = await createChatLinkCode("slack", userId);
  return { command: `${SLASH_COMMAND} link ${code}`, expiresAt };
}

/** Unlinks the person's Slack account, telling them there; false when none was linked. */
export const unlinkSlack = (userId: string, notice?: string) => unlinkChat("slack", userId, notice);
