import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { automationRun, databaseAutomation, databaseProperty } from "@/db/schema";
import { ROW_BUTTON_CLICKS_PER_MINUTE } from "@/lib/row-buttons";
import { sharedLimiter, takeAll } from "@/lib/rate-limit";
import { requirePageAccess } from "@/server/access";
import { kickAutomations } from "@/server/automations/queue";
import { propertyAccessFor } from "@/server/property-access";

/**
 * Buttons on rows (lib/row-buttons.ts): a click queues a run of each of the database's published,
 * turned-on automations made for that button, about the row, with whoever clicked as its actor.
 * The runs go as the automation's person, as row triggers' do, and the worker is woken at once.
 *
 * Clicking is a change to the row: it takes edit access to the row's content and, where the
 * property has access rules, the right to change its values. What a button does is the database's
 * automations, read from the database when it is clicked, never from the browser.
 */

/** Why a click did nothing. */
export type RowButtonErrorCode = "notFound" | "inTrash" | "noAutomation" | "rateLimited";

export class RowButtonError extends Error {
  constructor(
    readonly code: RowButtonErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RowButtonError";
  }
}

/**
 * Clicks the button property `propertyId` on row `rowId` for `userId`: returns how many automation
 * runs it queued. Throws AccessError when they may not change the row or the property, and
 * RowButtonError when the click can do nothing.
 */
export async function pressRowButton(userId: string, rowId: string, propertyId: string): Promise<{ started: number }> {
  const row = await requirePageAccess(userId, rowId, "content");
  if (!row.parentId || row.isTemplate) throw new RowButtonError("notFound", "This page isn't a row of a database");
  if (row.archivedAt) throw new RowButtonError("inTrash", "Buttons on rows in the trash do nothing");
  const [prop] = await db
    .select({ id: databaseProperty.id })
    .from(databaseProperty)
    .where(
      and(
        eq(databaseProperty.id, propertyId),
        eq(databaseProperty.databaseId, row.parentId),
        eq(databaseProperty.type, "button"),
        isNull(databaseProperty.deletedAt),
      ),
    );
  if (!prop) throw new RowButtonError("notFound", "The database has no such button");
  (await propertyAccessFor(userId, row.parentId)).requireValues({ properties: row.properties, createdBy: row.createdBy }, [prop.id]);
  if (takeAll([[sharedLimiter("row-button", ROW_BUTTON_CLICKS_PER_MINUTE, 60_000), `${userId}:${rowId}:${prop.id}`]]) > 0) {
    throw new RowButtonError("rateLimited", "This button was clicked too often; wait a moment");
  }
  const automations = await db
    .select({ id: databaseAutomation.id, version: databaseAutomation.version })
    .from(databaseAutomation)
    .where(
      and(
        eq(databaseAutomation.databaseId, row.parentId),
        eq(databaseAutomation.enabled, true),
        // A draft (version 0) waits until it is published.
        gt(databaseAutomation.version, 0),
        sql`${databaseAutomation.trigger}->>'type' = 'button_clicked'`,
        sql`${databaseAutomation.trigger}->>'propertyId' = ${prop.id}`,
      ),
    );
  if (!automations.length) throw new RowButtonError("noAutomation", "This button does nothing yet");
  await db.insert(automationRun).values(
    automations.map((a) => ({ automationId: a.id, rowId, actorId: userId, created: false, changed: [], origin: "button" as const, version: a.version })),
  );
  kickAutomations();
  return { started: automations.length };
}
