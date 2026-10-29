"use server";

import { getTranslations } from "next-intl/server";
import type { ActionResult } from "@/app/actions/workspaces";
import { BUTTON_STEP_TYPES } from "@/lib/buttons";
import { AccessError } from "@/server/access";
import { PropertyValueError } from "@/lib/properties";
import { ButtonError, buttonSettings, pressButton } from "@/server/buttons";
import { pressRowButton, RowButtonError } from "@/server/row-buttons";
import { requireUserId } from "@/server/session";

// Buttons on pages (server/buttons.ts): a click, and what a button's settings need. Buttons on
// rows (server/row-buttons.ts): a click, which starts the automations made for the button.
// What stopped a button comes back translated: which step, and why.

const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 100;

/** Clicks the button; the browser opens what it says to open once every step is done. */
export async function pressButtonAction(
  pageId: string,
  blockId: string,
  timeZone: string,
): Promise<ActionResult<{ open: { href: string; page: boolean } | null }>> {
  const userId = await requireUserId();
  const t = await getTranslations("page.button.failed");
  if (!isId(pageId) || !isId(blockId)) return { ok: false, error: t("notFound") };
  try {
    const press = await pressButton(userId, pageId, blockId, { timeZone: typeof timeZone === "string" ? timeZone.slice(0, 64) : "UTC" });
    if (press.ok) return { ok: true, data: { open: press.open } };
    const tStep = await getTranslations("page.button.steps");
    // The steps before it stay done: the message says how far it got.
    const type = BUTTON_STEP_TYPES.includes(press.type) ? press.type : "insert";
    return { ok: false, error: t("step", { step: press.step + 1, type: tStep(type), reason: t(press.code) }) };
  } catch (error) {
    if (error instanceof ButtonError) return { ok: false, error: t(error.code) };
    if (error instanceof AccessError) return { ok: false, error: t("noAccess") };
    console.error("[button action]", error);
    const tc = await getTranslations("common");
    return { ok: false, error: tc("genericError") };
  }
}

/** What a button's settings show: its webhooks' signing secret and the people it can notify. Needs edit access to the page. */
export async function buttonSettingsAction(pageId: string, blockId: string): Promise<ActionResult<Awaited<ReturnType<typeof buttonSettings>>>> {
  const userId = await requireUserId();
  const t = await getTranslations("page.button.failed");
  if (!isId(pageId) || !isId(blockId)) return { ok: false, error: t("notFound") };
  try {
    return { ok: true, data: await buttonSettings(userId, pageId, blockId) };
  } catch (error) {
    if (error instanceof ButtonError) return { ok: false, error: t(error.code) };
    if (error instanceof AccessError) return { ok: false, error: t("noAccess") };
    throw error;
  }
}

/** Clicks a button property on a row: its automations run on the row, in the queue. */
export async function pressRowButtonAction(rowId: string, propertyId: string): Promise<ActionResult<{ started: number }>> {
  const userId = await requireUserId();
  const t = await getTranslations("database.rowButton.failed");
  if (!isId(rowId) || !isId(propertyId)) return { ok: false, error: t("notFound") };
  try {
    return { ok: true, data: await pressRowButton(userId, rowId, propertyId) };
  } catch (error) {
    if (error instanceof RowButtonError) return { ok: false, error: t(error.code) };
    // Property access that doesn't let them change the button's values is no access to it.
    if (error instanceof AccessError || error instanceof PropertyValueError) return { ok: false, error: t("noAccess") };
    console.error("[row button action]", error);
    const tc = await getTranslations("common");
    return { ok: false, error: tc("genericError") };
  }
}
