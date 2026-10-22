import { LOCALES, type Locale } from "../config";
import en from "./en/telegram.json";
import { loadLocaleFile, withFallback } from "./index";

/**
 * The Telegram bot's texts (`messages/<locale>/telegram.json`, see server/telegram). Kept out of
 * the app messages like the emails' since only the server sends them; all languages are loaded up
 * front.
 */
export const telegramMessages: Record<Locale, typeof en> = Object.fromEntries(
  await Promise.all(LOCALES.map(async (locale) => [locale, withFallback(en, await loadLocaleFile(locale, "telegram"))])),
);
