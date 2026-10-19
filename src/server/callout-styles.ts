import { eq } from "drizzle-orm";
import { db } from "@/db";
import { page, workspace } from "@/db/schema";
import { storedCalloutStyles, type CalloutStyle } from "@/lib/callout-styles";

/**
 * A workspace's callout styles (lib/callout-styles), for drawing its pages: the editor, published
 * pages and the print view. Anyone who reads a page sees its callouts' looks, so this checks nothing.
 */
export async function calloutStylesOf(workspaceId: string): Promise<CalloutStyle[]> {
  const [row] = await db.select({ settings: workspace.settings }).from(workspace).where(eq(workspace.id, workspaceId)).limit(1);
  return storedCalloutStyles(row?.settings.calloutStyles);
}

/** The same for the workspace of a page. */
export async function calloutStylesOfPage(pageId: string): Promise<CalloutStyle[]> {
  const [row] = await db
    .select({ settings: workspace.settings })
    .from(page)
    .innerJoin(workspace, eq(workspace.id, page.workspaceId))
    .where(eq(page.id, pageId))
    .limit(1);
  return storedCalloutStyles(row?.settings.calloutStyles);
}
