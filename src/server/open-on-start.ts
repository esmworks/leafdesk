import { eq } from "drizzle-orm";
import { db } from "@/db";
import { userPreference } from "@/db/schema";
import { isOpenOnStart, type OpenOnStart } from "@/lib/open-on-start";

/** What the app opens on when the person starts it (lib/open-on-start.ts); account-wide. */
export async function getOpenOnStart(userId: string): Promise<OpenOnStart> {
  const [row] = await db.select({ openOnStart: userPreference.openOnStart }).from(userPreference).where(eq(userPreference.userId, userId));
  return isOpenOnStart(row?.openOnStart) ? row.openOnStart : "home";
}

export async function setOpenOnStart(userId: string, value: OpenOnStart) {
  await db
    .insert(userPreference)
    .values({ userId, openOnStart: value })
    .onConflictDoUpdate({ target: userPreference.userId, set: { openOnStart: value, updatedAt: new Date() } });
}
