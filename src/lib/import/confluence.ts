/**
 * The pure part of importing a Confluence space exported as HTML (Space settings → Export space →
 * HTML, a ZIP; server/import/confluence.ts reads it). The export holds one HTML file per page, an
 * `index.html` listing the pages as a tree under "Available Pages", the pages' attachments under
 * `attachments/<page id>/` and the site's own icons and styles. Its markup differs a little between
 * Confluence versions and between Cloud and Data Center, so everything here takes what it finds and
 * falls back rather than insisting on one shape.
 */

/** A page file of the export: `Page-Title_123456.html` or `123456.html`; not the space's index. */
export function isPageFile(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return /\.html?$/i.test(name) && !/^index\.html?$/i.test(name);
}

/**
 * A page's title from its heading or the document's `<title>`, which Confluence writes as
 * "Space name : Page title": the part after the first " : ". Empty when there is none.
 */
export function pageTitle(heading: string | null | undefined, documentTitle: string | null | undefined): string {
  const clean = (text: string) => text.replace(/\s+/g, " ").trim();
  for (const raw of [heading, documentTitle]) {
    const text = clean(raw ?? "");
    if (!text) continue;
    const at = text.indexOf(" : ");
    const title = clean(at >= 0 ? text.slice(at + 3) : text);
    if (title) return title.slice(0, 200);
  }
  return "";
}

/** The space's name from `index.html`'s title ("Space name : Home" or "Space name"), or "". */
export function spaceName(documentTitle: string | null | undefined): string {
  const text = (documentTitle ?? "").replace(/\s+/g, " ").trim();
  const at = text.indexOf(" : ");
  return (at >= 0 ? text.slice(0, at) : text).trim().slice(0, 200);
}

/** The path a link or image source in the file at `from` points at inside the export, or null (another site, an anchor). */
export function exportPath(from: string, href: string | null | undefined): string | null {
  const value = (href ?? "").trim();
  if (!value || value.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//")) return null;
  let path = value.replace(/[?#].*$/, "");
  try {
    path = decodeURIComponent(path);
  } catch {}
  if (!path) return null;
  const parts = path.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(segment);
  }
  return parts.length ? parts.join("/") : null;
}

/** Info, note, tip and warning panels as callout colors; other panels are gray. */
const PANEL_COLORS: Record<string, string> = { information: "blue", info: "blue", note: "yellow", tip: "green", warning: "red", success: "green", error: "red" };

/** The callout color of a panel by its classes (`confluence-information-macro-note`, …). */
export function panelColor(className: string): string {
  const kind = /confluence-information-macro-(\w+)/.exec(className)?.[1]?.toLowerCase();
  return (kind && PANEL_COLORS[kind]) || "gray";
}

/** Names of the code macro's languages that differ from the editor's. */
const LANGUAGES: Record<string, string> = {
  js: "javascript",
  jscript: "javascript",
  ts: "typescript",
  py: "python",
  rb: "ruby",
  sh: "bash",
  shell: "bash",
  ps: "powershell",
  csharp: "csharp",
  "c#": "csharp",
  cpp: "cpp",
  "c++": "cpp",
  xml: "xml",
  html: "html",
  text: "",
  plain: "",
  none: "",
};

/** The language of a code macro from its `data-syntaxhighlighter-params` ("brush: java; gutter: false"), or "". */
export function codeLanguage(params: string | null | undefined): string {
  const brush = /(?:^|;)\s*brush\s*:\s*([^;]+)/i.exec(params ?? "")?.[1]?.trim().toLowerCase() ?? "";
  if (!brush) return "";
  return brush in LANGUAGES ? LANGUAGES[brush] : brush.replace(/[^a-z0-9+#-]/g, "");
}

/** Confluence's emoticons by the text it writes for them, for exports without the emoji itself. */
const EMOTICONS: Record<string, string> = {
  "(smile)": "🙂",
  ":)": "🙂",
  "(sad)": "🙁",
  ":(": "🙁",
  "(tongue)": "😛",
  "(biggrin)": "😄",
  "(wink)": "😉",
  "(thumbs-up)": "👍",
  "(y)": "👍",
  "(thumbs-down)": "👎",
  "(n)": "👎",
  "(information)": "ℹ️",
  "(i)": "ℹ️",
  "(tick)": "✅",
  "(/)": "✅",
  "(error)": "❌",
  "(x)": "❌",
  "(warning)": "⚠️",
  "(!)": "⚠️",
  "(plus)": "➕",
  "(minus)": "➖",
  "(question)": "❓",
  "(?)": "❓",
  "(lightbulb_on)": "💡",
  "(on)": "💡",
  "(lightbulb)": "💡",
  "(off)": "💡",
  "(star_yellow)": "⭐",
  "(*)": "⭐",
  "(heart)": "❤️",
  "(broken_heart)": "💔",
};

/** An emoticon image as text: the emoji the export names, else the one its alt text stands for, else "". */
export function emoticonText(fallback: string | null | undefined, alt: string | null | undefined): string {
  const own = (fallback ?? "").trim();
  if (own && !/^:[\w-]+:$/.test(own)) return own;
  return EMOTICONS[(alt ?? "").trim().toLowerCase()] ?? "";
}

export type ConfluenceTreeNode = { file: string; children: ConfluenceTreeNode[] };

/**
 * The pages in order with their parents: as the space's index lists them (`tree`), then those it
 * doesn't, under the parent their breadcrumbs name when that page is in the export, else at the top.
 * Each file once; files that aren't pages of the export are left out.
 */
export function orderPages(
  pages: readonly { file: string; parent: string | null }[],
  tree: readonly ConfluenceTreeNode[],
): { file: string; parent: string | null }[] {
  const known = new Set(pages.map((p) => p.file));
  const out: { file: string; parent: string | null }[] = [];
  const placed = new Set<string>();
  const walk = (nodes: readonly ConfluenceTreeNode[], parent: string | null) => {
    for (const node of nodes) {
      if (!known.has(node.file) || placed.has(node.file)) {
        walk(node.children, parent);
        continue;
      }
      placed.add(node.file);
      out.push({ file: node.file, parent });
      walk(node.children, node.file);
    }
  };
  walk(tree, null);
  // Pages the index leaves out: their parents first, so a parent is always created before its child.
  let left = pages.filter((p) => !placed.has(p.file));
  while (left.length) {
    const ready = left.filter((p) => !p.parent || !known.has(p.parent) || p.parent === p.file || placed.has(p.parent));
    const next = ready.length ? ready : [left[0]];
    for (const page of next) {
      const parent = page.parent && page.parent !== page.file && placed.has(page.parent) ? page.parent : null;
      placed.add(page.file);
      out.push({ file: page.file, parent });
    }
    left = left.filter((p) => !placed.has(p.file));
  }
  return out;
}
