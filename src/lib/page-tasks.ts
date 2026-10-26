/**
 * To-dos written in page bodies that are someone's task: an unticked to-do (`checkListItem`) whose
 * own text mentions a person. Each person it mentions finds it in My tasks and on the home page
 * (server/page-tasks.ts keeps the index, server/assigned.ts lists it). Group mentions don't make
 * one (a group's members would each get it without being named), and neither do mentions of agents
 * (left out where the index is written, since only the server knows who is one).
 *
 * Pure: the server indexes what this finds on every save.
 */

import { parseDateValue } from "./date-value";
import { mentionPlainText, mentionProps, MENTION, type AnyBlock } from "./mentions";

export const TODO_BLOCK = "checkListItem";

/** How much of a to-do's text is kept for the list. */
export const PAGE_TASK_TEXT_MAX = 300;

/** One person's to-do: the block, who it mentions, its text without the mentions, its first date. */
export type PageTaskEntry = {
  blockId: string;
  userId: string;
  /** The to-do's text without its mentions of people, groups, pages and dates, at most PAGE_TASK_TEXT_MAX long. */
  text: string;
  /** The first date mentioned in the to-do as the mention stores it (a day, or a time), or null. */
  date: string | null;
};

type Inline = { type?: string; text?: unknown; props?: unknown; content?: unknown };

/** Whether a to-do is ticked (BlockNote keeps a boolean; stored data may hold its text). */
export const isTicked = (props: unknown) => {
  const checked = (props as { checked?: unknown } | null | undefined)?.checked;
  return checked === true || checked === "true";
};

/**
 * The to-do's own line as people and dates aside: plain text and links' text, link mentions by
 * their title. Separators left where a mention was taken out ("@Ada: send it") go too.
 */
function todoText(content: unknown): string {
  const parts: string[] = [];
  const walk = (nodes: unknown) => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes as Inline[]) {
      if (!node || typeof node !== "object") continue;
      if (node.type === "text" && typeof node.text === "string") parts.push(node.text);
      else if (node.type === "link") walk(node.content);
      else if (node.type === MENTION) {
        const props = mentionProps(node.props);
        // A gap where the mention was, so the words around it stay apart.
        parts.push(props.kind === "link" ? mentionPlainText(props) : " ");
      }
    }
  };
  walk(content);
  const text = parts
    .join("")
    .replace(/\s+/g, " ")
    .replace(/^[\s:,;.\-–—]+/u, "")
    .replace(/[\s:,;\-–—]+$/u, "")
    .trim();
  return text.length > PAGE_TASK_TEXT_MAX ? `${text.slice(0, PAGE_TASK_TEXT_MAX - 1).trimEnd()}…` : text;
}

/**
 * Every person's unticked to-do in a body, in document order: one entry per to-do and person it
 * mentions (a person mentioned twice counts once). To-dos inside others (and in columns, toggles
 * and the like) count on their own: a nested one's text and mentions are its own, not its
 * parent's, and it counts though its parent is ticked. A to-do without an id is left out.
 */
export function pageTasksIn(blocks: unknown[]): PageTaskEntry[] {
  const out: PageTaskEntry[] = [];
  const seen = new Set<string>();
  const walk = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const block of list as (AnyBlock & { id?: unknown })[]) {
      if (!block || typeof block !== "object") continue;
      if (block.type === TODO_BLOCK && typeof block.id === "string" && block.id && !isTicked(block.props) && Array.isArray(block.content)) {
        const people: string[] = [];
        let date: string | null = null;
        const visit = (nodes: unknown) => {
          if (!Array.isArray(nodes)) return;
          for (const node of nodes as Inline[]) {
            if (!node || typeof node !== "object") continue;
            if (node.type === "link") visit(node.content);
            if (node.type !== MENTION) continue;
            const m = mentionProps(node.props);
            if (m.kind === "user" && m.userId && !people.includes(m.userId)) people.push(m.userId);
            if (m.kind === "date" && date === null && parseDateValue(m.date)) date = m.date;
          }
        };
        visit(block.content);
        if (people.length) {
          const text = todoText(block.content);
          for (const userId of people) {
            const key = `${block.id}\n${userId}`;
            // A block copied within the page can keep its id: the first one counts.
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ blockId: block.id, userId, text, date });
          }
        }
      }
      walk(block.children);
    }
  };
  walk(blocks);
  return out;
}
