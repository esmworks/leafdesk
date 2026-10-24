import { eq } from "drizzle-orm";
import { db } from "@/db";
import { userPreference } from "@/db/schema";
import { isDesktopLinks, type DesktopLinks } from "@/lib/desktop-links";

/** Whether the person's links opened in a browser go on to the desktop app (lib/desktop-links.ts); account-wide. */
export async function getDesktopLinks(userId: string): Promise<DesktopLinks> {
  const [row] = await db.select({ desktopLinks: userPreference.desktopLinks }).from(userPreference).where(eq(userPreference.userId, userId));
  return isDesktopLinks(row?.desktopLinks) ? row.desktopLinks : "off";
}

export async function setDesktopLinks(userId: string, value: DesktopLinks) {
  await db
    .insert(userPreference)
    .values({ userId, desktopLinks: value })
    .onConflictDoUpdate({ target: userPreference.userId, set: { desktopLinks: value, updatedAt: new Date() } });
}
