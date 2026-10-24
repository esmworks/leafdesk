import { eq } from "drizzle-orm";
import { db } from "@/db";
import { userPreference } from "@/db/schema";
import { ICON_COLORS, type IconColor } from "@/lib/icon-value";

/**
 * What the icon picker remembers for each person, account-wide: the skin tone emoji with tones are
 * picked in (1, lightest, to 5; null for none) and the color built-in icons are picked in (null for
 * the text color).
 */
export type IconPreferences = { skinTone: number | null; iconColor: IconColor | null };

export const isSkinTone = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5;
export const isIconColor = (value: unknown): value is IconColor => (ICON_COLORS as readonly unknown[]).includes(value);

export async function getIconPreferences(userId: string): Promise<IconPreferences> {
  const [row] = await db
    .select({ skinTone: userPreference.emojiSkinTone, iconColor: userPreference.iconColor })
    .from(userPreference)
    .where(eq(userPreference.userId, userId));
  return { skinTone: isSkinTone(row?.skinTone) ? row.skinTone : null, iconColor: isIconColor(row?.iconColor) ? row.iconColor : null };
}

/** Changes what `patch` names (null clears it); what it leaves out stays. */
export async function setIconPreferences(userId: string, patch: Partial<IconPreferences>) {
  const set = {
    ...(patch.skinTone !== undefined ? { emojiSkinTone: patch.skinTone } : {}),
    ...(patch.iconColor !== undefined ? { iconColor: patch.iconColor } : {}),
  };
  if (!Object.keys(set).length) return;
  await db
    .insert(userPreference)
    .values({ userId, ...set })
    .onConflictDoUpdate({ target: userPreference.userId, set: { ...set, updatedAt: new Date() } });
}
