import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { user } from "@/db/schema";
import { fillPlaceholders, preparePlaceholders } from "@/lib/snippets";
import { isTimeZone } from "@/lib/time-zone";
import { markdownToBlocks, serverEditor } from "@/server/blocknote";
import { getSnippet } from "@/server/snippets";
import { editableBody } from "./outgoing";

/**
 * A snippet put into a message in the Mail tab: its Markdown with the placeholders filled in
 * (`{{page}}` is the message's subject; `{{cursor}}` falls away, the caret stays after what was
 * put in), turned into the HTML the mail editor takes, as a draft opens again (outgoing.ts
 * `editableBody`): headings, tables and other blocks a message can't hold become their text.
 * Personal snippets and the workspace's, as the person reads them (server/snippets.ts).
 */
export async function mailTemplate(userId: string, input: { id: string; locale: string; timeZone: string; subject: string }): Promise<{ html: string }> {
  const snippet = await getSnippet(userId, String(input.id));
  const [me] = await db.select({ name: user.name }).from(user).where(eq(user.id, userId));
  const context = {
    now: new Date(),
    locale: typeof input.locale === "string" && input.locale ? input.locale.slice(0, 20) : "en",
    timeZone: isTimeZone(input.timeZone) ? input.timeZone : "UTC",
    me: me?.name ?? "",
    page: typeof input.subject === "string" ? input.subject.slice(0, 300) : "",
  };
  const prepared = preparePlaceholders(snippet.body, context, randomBytes(4).toString("hex"));
  const markdown = prepared.cursor ? prepared.markdown.replace(prepared.cursor, "") : prepared.markdown;
  const blocks = fillPlaceholders(await markdownToBlocks(markdown, [], { carryOver: false }), prepared.tokens);
  // A line break in a paragraph comes with the line's newline, which the editor would show as a space.
  const html = (await serverEditor.blocksToHTMLLossy(blocks)).replace(/<br>\s+/g, "<br>");
  return { html: await editableBody(html, "") };
}
