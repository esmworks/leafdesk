import { LOCALES } from "@/i18n/config";
import { telegramMessages } from "@/i18n/messages/telegram";
import { env } from "@/lib/env";
import { callApi, POLL_SECONDS, TelegramApiError, type TelegramUpdate } from "./api";
import { handleUpdate } from "./bot";
import { botUsername } from "./links";

/**
 * Starts the Telegram bot when TELEGRAM_BOT_TOKEN is set (see bot.ts): the server asks Telegram for
 * new messages itself (long polling), so it needs no public address. Each update is handled on its
 * own, so a button pressed while an answer is written (an approval, /stop) is handled at once.
 */
export function startTelegram() {
  if (!env.telegramBotToken) {
    console.log("telegram: off (TELEGRAM_BOT_TOKEN)");
    return;
  }
  void run();
}

const COMMANDS = ["new", "workspace", "mode", "stop", "unlink", "help"] as const;

async function run() {
  try {
    console.log(`telegram: on as @${await botUsername()}`);
  } catch (error) {
    // A wrong token never starts working: say so once and stop.
    if (error instanceof TelegramApiError && (error.code === 401 || error.code === 404)) {
      console.error("telegram: the bot token was refused; check TELEGRAM_BOT_TOKEN");
      return;
    }
    console.error("telegram: couldn't reach Telegram yet, retrying", error instanceof Error ? error.message : error);
  }
  // A webhook set for this bot elsewhere keeps getUpdates from answering.
  await callApi("deleteWebhook", { drop_pending_updates: false }).catch(() => {});
  await setCommands().catch((error) => console.error("telegram: couldn't set the command list", error instanceof Error ? error.message : error));
  await poll();
}

/** The command list Telegram shows in its menu, in each language Leafdesk has. */
async function setCommands() {
  const commands = (locale: (typeof LOCALES)[number]) => COMMANDS.map((command) => ({ command, description: telegramMessages[locale].commands[command] }));
  await callApi("setMyCommands", { commands: commands("en") });
  for (const locale of LOCALES) {
    if (locale !== "en" && /^[a-z]{2}$/.test(locale)) await callApi("setMyCommands", { commands: commands(locale), language_code: locale });
  }
}

async function poll() {
  let offset = 0;
  let failures = 0;
  for (;;) {
    try {
      const updates = await callApi<TelegramUpdate[]>("getUpdates", { offset, timeout: POLL_SECONDS, allowed_updates: ["message", "callback_query"] });
      failures = 0;
      for (const update of updates) {
        offset = update.update_id + 1;
        void handleUpdate(update);
      }
    } catch (error) {
      failures += 1;
      if (error instanceof TelegramApiError && error.code === 401) {
        console.error("telegram: the bot token was refused; check TELEGRAM_BOT_TOKEN");
        return;
      }
      // 409: another server polls with the same token; each takes some of the messages.
      if (failures === 1 || failures % 20 === 0) {
        console.error(
          error instanceof TelegramApiError && error.code === 409
            ? "telegram: another server is reading this bot's messages; give each server its own bot"
            : `telegram: couldn't get messages (${error instanceof Error ? error.message : "error"}), retrying`,
        );
      }
      const wait = error instanceof TelegramApiError && error.retryAfter ? error.retryAfter * 1000 : Math.min(60_000, 1_000 * 2 ** Math.min(failures, 6));
      await new Promise((resolve) => setTimeout(resolve, wait).unref?.());
    }
  }
}
