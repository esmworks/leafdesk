// Client-safe and small: the HTML block's config, its Markdown form and the rules of its frame,
// shared by the editor's schema (components/page/html-block.tsx), the server's (server/blocknote.ts),
// Markdown (lib/content-markdown.ts), published pages, print and the frame's route
// (app/api/html-block/frame). The frame's own document is lib/html-frame.ts.

/**
 * The HTML block: a small self-contained web page (a calculator, a quiz, a chart, an org chart)
 * that runs inside a page. Everything is in the block's props, so it syncs, versions and copies
 * with the page; whoever can read the page uses it, whoever can edit the page changes its source.
 * It always runs in a sandboxed frame that can reach neither the app nor the network (see
 * lib/html-frame.ts).
 */
export const HTML_BLOCK = "html";

/** The longest source a block keeps (characters): longer text is cut where it is read. */
export const MAX_HTML_SOURCE = 200_000;
export const MAX_HTML_TITLE = 120;
/** A frame's height (pixels): set by the editor, or followed from the content, always within these. */
export const MIN_HTML_HEIGHT = 40;
export const MAX_HTML_HEIGHT = 2_000;
/** The height a frame has before its content reports one. */
export const DEFAULT_HTML_HEIGHT = 200;

export const htmlBlockConfig = {
  type: HTML_BLOCK,
  propSchema: {
    /** The HTML document or fragment, scripts and styles inline. */
    source: { default: "" },
    /** Pixels; 0 follows the content. */
    height: { default: 0 },
    /** Names the block for readers who can't run it (print, search, the frame's title). */
    title: { default: "" },
  },
  content: "none",
} as const;

export const cleanHtmlSource = (value: unknown): string => (typeof value === "string" ? value.slice(0, MAX_HTML_SOURCE) : "");
export const cleanHtmlTitle = (value: unknown): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, MAX_HTML_TITLE) : "");

/** A fixed height within the limits, or 0 (follow the content). */
export function cleanHtmlHeight(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
  return Number.isFinite(n) && n > 0 ? Math.min(MAX_HTML_HEIGHT, Math.max(MIN_HTML_HEIGHT, Math.round(n))) : 0;
}

/** A height the frame reported, kept within the limits (anything else is not a height). */
export function clampReportedHeight(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(MAX_HTML_HEIGHT, Math.max(MIN_HTML_HEIGHT, Math.ceil(value))) : null;
}

/**
 * In Markdown (stored for search and history, read and written by MCP, the AI chat and agents) the
 * block is a fenced code block with a marker line before it; the marker may carry the title and
 * the fixed height as JSON (`>` is written `>`, so no title can end the comment):
 *
 *   <!-- leafdesk:html {"title":"Loan calculator","height":320} -->
 *   ```html
 *   <input id="a"> …
 *   ```
 */
const MARKER = /^ {0,3}<!--\s*leafdesk:html(?:\s+(\{.*\}))?\s*-->\s*$/;

export function htmlBlockMarker(props: { title?: unknown; height?: unknown }): string {
  const title = cleanHtmlTitle(props.title);
  const height = cleanHtmlHeight(props.height);
  const options = { ...(title ? { title } : {}), ...(height ? { height } : {}) };
  const json = Object.keys(options).length ? ` ${JSON.stringify(options).replaceAll(">", "\\u003e")}` : "";
  return `<!-- leafdesk:html${json} -->`;
}

/** The title and height a marker line carries, or null for any other line. Options that don't read are left out. */
export function parseHtmlBlockMarker(line: string): { title: string; height: number } | null {
  const match = MARKER.exec(line);
  if (!match) return null;
  let options: unknown = {};
  if (match[1]) {
    try {
      options = JSON.parse(match[1]);
    } catch {
      options = {};
    }
  }
  const o = typeof options === "object" && options !== null ? (options as Record<string, unknown>) : {};
  return { title: cleanHtmlTitle(o.title), height: cleanHtmlHeight(o.height) };
}

/** The block as Markdown: the marker, then the source in a fence longer than any run of backticks in it. */
export function htmlBlockMarkdown(props: { source?: unknown; title?: unknown; height?: unknown }): string {
  const source = cleanHtmlSource(props.source).replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  const longest = Math.max(0, ...(source.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${htmlBlockMarker(props)}\n${fence}html\n${source}\n${fence}`;
}

/**
 * The HTML in a model's answer: what a ```html fence holds, or the whole answer. Null when the
 * answer holds no markup or doesn't fit the block.
 */
export function htmlAnswer(text: string): string | null {
  const fenced = /```(?:html)?[ \t]*\n([\s\S]*?)\n```/i.exec(text);
  const body = (fenced ? fenced[1] : text).trim();
  if (!/<[a-z!][^>]*>/i.test(body) || body.length > MAX_HTML_SOURCE) return null;
  return body;
}

/** What the block says on paper and wherever its app can't run. */
export const htmlBlockLabel = (title: unknown) => cleanHtmlTitle(title);
