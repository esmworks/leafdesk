/**
 * Differences between two versions of a page body, for the page history. Pure: the server flattens
 * both versions' BlockNote blocks and diffs them here, the history panel renders the result and
 * MCP prints it as text.
 *
 * Blocks are compared whole (type, props and styled text); a block removed and another added in
 * the same place are shown as one changed block when their words are alike, with word-level
 * changes inside it.
 */

export type DiffOp = "eq" | "add" | "del";

/** Largest table the LCS fills before falling back to "all removed, all added" for the middle. */
const MAX_CELLS = 4_000_000;

/**
 * Longest-common-subsequence diff of two sequences. Common ends are matched first, so the table
 * only covers the part that changed. Deletions come before additions within a change.
 */
export function diffSequence<T>(a: readonly T[], b: readonly T[], same: (x: T, y: T) => boolean) {
  const out: { op: DiffOp; a: number; b: number }[] = [];
  let start = 0;
  while (start < a.length && start < b.length && same(a[start], b[start])) {
    out.push({ op: "eq", a: start, b: start });
    start++;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && same(a[endA - 1], b[endB - 1])) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  if (n * m > MAX_CELLS) {
    for (let i = start; i < endA; i++) out.push({ op: "del", a: i, b: -1 });
    for (let j = start; j < endB; j++) out.push({ op: "add", a: -1, b: j });
  } else {
    // lcs[i * (m + 1) + j]: length of the LCS of a[start + i..endA) and b[start + j..endB).
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = same(a[start + i], b[start + j])
          ? lcs[(i + 1) * w + j + 1] + 1
          : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && same(a[start + i], b[start + j])) {
        out.push({ op: "eq", a: start + i++, b: start + j++ });
      } else if (j >= m || (i < n && lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) {
        out.push({ op: "del", a: start + i++, b: -1 });
      } else {
        out.push({ op: "add", a: -1, b: start + j++ });
      }
    }
  }
  for (let i = endA, j = endB; i < a.length; i++, j++) out.push({ op: "eq", a: i, b: j });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Words

export type WordSegment = { op: DiffOp; text: string };

const TOKEN = /\s+|[\p{L}\p{N}\p{M}_]+|[^\s\p{L}\p{N}\p{M}_]/gu;

export const tokenize = (text: string) => text.match(TOKEN) ?? [];

const isSpace = (token: string) => /^\s+$/.test(token);

/**
 * Word-level changes from `before` to `after`. Within one change the removed words come first,
 * then the added ones, and spaces between changed words belong to the change, so "quick brown"
 * → "slow red" reads as one replacement instead of two.
 */
export function diffWords(before: string, after: string): WordSegment[] {
  const a = tokenize(before);
  const b = tokenize(after);
  const edits = diffSequence(a, b, (x, y) => x === y);
  const segments: WordSegment[] = [];
  const push = (op: DiffOp, text: string) => {
    if (!text) return;
    const last = segments.at(-1);
    if (last?.op === op) last.text += text;
    else segments.push({ op, text });
  };
  let del = "";
  let add = "";
  const flush = () => {
    // A joined space on a side with nothing else changed is shared, not removed or added.
    if (add && isSpace(add) && del.endsWith(add)) {
      push("del", del.slice(0, -add.length));
      push("eq", add);
    } else if (del && isSpace(del) && add.endsWith(del)) {
      push("add", add.slice(0, -del.length));
      push("eq", del);
    } else {
      push("del", del);
      push("add", add);
    }
    del = add = "";
  };
  for (let k = 0; k < edits.length; k++) {
    const e = edits[k];
    if (e.op === "eq") {
      const token = a[e.a];
      if ((del || add) && isSpace(token) && edits[k + 1] && edits[k + 1].op !== "eq") {
        del += token;
        add += token;
        continue;
      }
      flush();
      push("eq", token);
    } else if (e.op === "del") {
      del += a[e.a];
    } else {
      add += b[e.b];
    }
  }
  flush();
  return segments;
}

/** How alike two texts are by their words, from 0 (nothing shared) to 1 (the same words). */
export function similarity(before: string, after: string) {
  const a = tokenize(before).filter((t) => !isSpace(t));
  const b = tokenize(after).filter((t) => !isSpace(t));
  if (!a.length && !b.length) return 1;
  const common = diffSequence(a, b, (x, y) => x === y).filter((e) => e.op === "eq").length;
  return (2 * common) / (a.length + b.length);
}

// ---------------------------------------------------------------------------------------------
// Blocks

/** One block of a page body, without its children (they follow it with a larger depth). */
export type DiffBlock = {
  type: string;
  depth: number;
  /** Visible text: inline text, table cells, a file's caption or name. */
  text: string;
  /** Everything that makes two blocks equal: type, props and styled content. */
  key: string;
  level?: number;
  checked?: boolean;
  /** Number shown before a numbered list item. */
  ordinal?: number;
  language?: string;
  url?: string;
  /** A callout's icon. */
  icon?: string;
};

type InlineNode = { type?: string; text?: string; href?: string; content?: InlineNode[] | string; styles?: unknown };
type TableCell = InlineNode[] | { content?: InlineNode[] };
type Content = InlineNode[] | string | { type?: string; rows?: { cells: TableCell[] }[] } | undefined;
/** Structural view of a BlockNote block; enough to compare and show it. */
export type BlockInput = {
  type: string;
  props?: Record<string, unknown>;
  content?: Content;
  children?: BlockInput[];
};

function inlineText(nodes: InlineNode[] | string | undefined): string {
  if (!nodes) return "";
  if (typeof nodes === "string") return nodes;
  return nodes.map((n) => (typeof n.text === "string" ? n.text : inlineText(n.content))).join("");
}

function contentText(content: Content): string {
  if (!content) return "";
  if (typeof content === "string" || Array.isArray(content)) return inlineText(content);
  if (content.type === "tableContent" && content.rows) {
    return content.rows
      .map((row) => row.cells.map((cell) => inlineText(Array.isArray(cell) ? cell : cell.content)).join(" | "))
      .join("\n");
  }
  return "";
}

const MEDIA = new Set(["image", "video", "audio", "file"]);

/** Flattens BlockNote blocks (children after their parent, one level deeper) for diffing. */
export function flattenBlocks(blocks: readonly BlockInput[]): DiffBlock[] {
  const out: DiffBlock[] = [];
  const walk = (list: readonly BlockInput[], depth: number) => {
    let run = 0;
    for (const block of list) {
      // Columns (lib/columns) only lay blocks out: their blocks are compared as if they followed
      // one another.
      if (block.type === "columnList" || block.type === "column") {
        if (block.children?.length) walk(block.children, depth);
        run = 0;
        continue;
      }
      const props = block.props ?? {};
      const str = (name: string) => (typeof props[name] === "string" ? (props[name] as string) : "");
      let text = contentText(block.content);
      if (MEDIA.has(block.type)) text = str("caption") || str("name") || str("url");
      if (block.type === "bookmark" || block.type === "webEmbed") text = str("title") || str("url");
      const diffBlock: DiffBlock = {
        type: block.type,
        depth,
        text,
        key: JSON.stringify([block.type, props, block.content ?? null]),
      };
      if (typeof props.level === "number") diffBlock.level = props.level;
      if (typeof props.checked === "boolean") diffBlock.checked = props.checked;
      if (str("language")) diffBlock.language = str("language");
      if ((MEDIA.has(block.type) || block.type === "bookmark" || block.type === "webEmbed") && str("url")) diffBlock.url = str("url");
      if (block.type === "callout" && str("icon")) diffBlock.icon = str("icon");
      if (block.type === "numberedListItem") {
        const start = Number(props.start);
        run = run === 0 && Number.isInteger(start) && start > 0 ? start : run + 1;
        diffBlock.ordinal = run;
      } else {
        run = 0;
      }
      out.push(diffBlock);
      if (block.children?.length) walk(block.children, depth + 1);
    }
  };
  walk(blocks, 0);
  return out;
}

export type BlockChange =
  | { op: "same" | "added" | "removed"; block: DiffBlock }
  /** `block` is the newer block; `words` turn the older text into it. */
  | { op: "changed"; block: DiffBlock; before: DiffBlock; words: WordSegment[] };

/** Whether a removed and an added block read as one block edited in place. */
function alike(before: DiffBlock, after: DiffBlock) {
  if (before.depth !== after.depth && before.type !== after.type) return false;
  return similarity(before.text, after.text) >= (before.type === after.type ? 0.4 : 0.6);
}

export function diffBlocks(before: readonly DiffBlock[], after: readonly DiffBlock[]): BlockChange[] {
  const edits = diffSequence(before, after, (x, y) => x.key === y.key && x.depth === y.depth);
  const out: BlockChange[] = [];
  let removed: DiffBlock[] = [];
  let added: DiffBlock[] = [];
  const flush = () => {
    if (removed.length && added.length) {
      for (const e of diffSequence(removed, added, alike)) {
        if (e.op === "eq") {
          const [b, a] = [removed[e.a], added[e.b]];
          out.push({ op: "changed", block: a, before: b, words: diffWords(b.text, a.text) });
        } else if (e.op === "del") {
          out.push({ op: "removed", block: removed[e.a] });
        } else {
          out.push({ op: "added", block: added[e.b] });
        }
      }
    } else {
      for (const block of removed) out.push({ op: "removed", block });
      for (const block of added) out.push({ op: "added", block });
    }
    removed = [];
    added = [];
  };
  for (const e of edits) {
    if (e.op === "eq") {
      flush();
      out.push({ op: "same", block: after[e.b] });
    } else if (e.op === "del") {
      removed.push(before[e.a]);
    } else {
      added.push(after[e.b]);
    }
  }
  flush();
  return out;
}

/** A changed block whose text stayed the same: only its type, formatting or settings changed. */
export function onlyFormatChanged(change: BlockChange): boolean {
  return change.op === "changed" && change.words.every((w) => w.op === "eq");
}

export type DiffItem = BlockChange | { op: "hidden"; blocks: DiffBlock[] };

/**
 * Folds runs of unchanged blocks, keeping `context` blocks next to each change so an edit can be
 * placed. Runs shorter than what folding would save stay as they are.
 */
export function foldUnchanged(changes: readonly BlockChange[], context = 1): DiffItem[] {
  const out: DiffItem[] = [];
  let i = 0;
  while (i < changes.length) {
    if (changes[i].op !== "same") {
      out.push(changes[i++]);
      continue;
    }
    let end = i;
    while (end < changes.length && changes[end].op === "same") end++;
    const keepBefore = i === 0 ? 0 : context;
    const keepAfter = end === changes.length ? 0 : context;
    const run = changes.slice(i, end);
    if (run.length > keepBefore + keepAfter + 1) {
      out.push(...run.slice(0, keepBefore));
      out.push({ op: "hidden", blocks: run.slice(keepBefore, run.length - keepAfter).map((c) => c.block) });
      out.push(...run.slice(run.length - keepAfter));
    } else {
      out.push(...run);
    }
    i = end;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Who made the changes

export type VersionReason = "auto" | "before_mcp_write" | "before_restore" | "before_ai_edit" | "manual" | "current";
/** `isAgent`: the user is an agent's (see server/agents), shown as an agent. */
export type VersionActor = { reason: VersionReason; userName: string | null; clientName: string | null; isAgent?: boolean };
export type ChangeActor = { name: string | null; client: string | null; isAgent?: true };

/**
 * Who changed the page between the first and the last of `versions` (oldest first). A snapshot
 * taken before a change ("before_…") names who made the change right after it: the person, and
 * for MCP writes the AI app. An autosave, and the current page, name who saved last before it;
 * right after an AI app's write for the same person that save is taken to be the write itself.
 * Edits by others in the same stretch are not recorded, so this can leave people out.
 */
export function changeActors(versions: readonly VersionActor[]): ChangeActor[] {
  const found = new Map<string, ChangeActor>();
  const add = (v: VersionActor) => {
    if (!v.userName && !v.clientName) return;
    const actor: ChangeActor = { name: v.userName, client: v.reason === "before_mcp_write" ? v.clientName : null, ...(v.isAgent ? { isAgent: true } : {}) };
    found.set(`${actor.name}\u0000${actor.client}`, actor);
  };
  versions.forEach((v, i) => {
    const before = v.reason === "before_mcp_write" || v.reason === "before_restore" || v.reason === "before_ai_edit";
    if (before) {
      if (i < versions.length - 1) add(v);
    } else if (i > 0) {
      const prev = versions[i - 1];
      if (!(prev.reason === "before_mcp_write" && prev.userName === v.userName)) add(v);
    }
  });
  return [...found.values()];
}

// ---------------------------------------------------------------------------------------------
// Text form (MCP)

/** Word changes as text: [-removed-] and {+added+}. */
export function wordsToText(words: readonly WordSegment[]) {
  return words.map((w) => (w.op === "eq" ? w.text : w.op === "del" ? `[-${w.text}-]` : `{+${w.text}+}`)).join("");
}

function blockLabel(block: DiffBlock) {
  const indent = "  ".repeat(block.depth);
  const marker =
    block.type === "heading"
      ? `${"#".repeat(block.level ?? 1)} `
      : block.type === "bulletListItem" || block.type === "toggleListItem"
        ? "* "
        : block.type === "numberedListItem"
          ? `${block.ordinal ?? 1}. `
          : block.type === "checkListItem"
            ? `[${block.checked ? "x" : " "}] `
            : block.type === "paragraph"
              ? ""
              : `(${block.type}) `;
  return `${indent}${marker}`;
}

/**
 * The changes as plain text, one line per block: "+" added, "-" removed, "~" changed with
 * [-removed-] and {+added+} words inside, unchanged blocks folded into "… N unchanged blocks".
 */
export function diffToText(changes: readonly BlockChange[], context = 1): string {
  const lines: string[] = [];
  for (const item of foldUnchanged(changes, context)) {
    if (item.op === "hidden") {
      lines.push(`  … ${item.blocks.length} unchanged block${item.blocks.length === 1 ? "" : "s"}`);
      continue;
    }
    const { block } = item;
    const text = (s: string) => s.replace(/\n/g, " ⏎ ");
    if (item.op === "same") lines.push(`  ${blockLabel(block)}${text(block.text)}`);
    else if (item.op === "added") lines.push(`+ ${blockLabel(block)}${text(block.text)}`);
    else if (item.op === "removed") lines.push(`- ${blockLabel(block)}${text(block.text)}`);
    else if (item.op === "changed") {
      const note = onlyFormatChanged(item) ? `  (formatting or block type changed)` : "";
      lines.push(`~ ${blockLabel(block)}${text(wordsToText(item.words))}${note}`);
    }
  }
  return lines.join("\n");
}
