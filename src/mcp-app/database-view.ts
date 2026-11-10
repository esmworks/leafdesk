import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { SHOWN, TOTAL, type DatabaseViewData, type ViewColumn, type ViewSetup } from "@/lib/mcp-view";
import { viewCell, type CellFormat } from "@/lib/mcp-view-cells";

/**
 * The view an app shows show_database's result in (server/mcp/app-view.ts): the rows as a table,
 * a button reading on and one opening the database in Leafdesk. Bundled by scripts/mcp-app.ts into
 * server/mcp/app-bundle.ts; run `pnpm tsx scripts/mcp-app.ts` after changing it. Rows are written
 * by people: they go into the page as text only, and the only links opened are the Leafdesk
 * addresses the server wrote.
 */

type Result = { structuredContent?: unknown; content?: { type: string; text?: string }[]; isError?: boolean };
type State = "waiting" | "shown" | "loading" | "failed" | "unavailable";

const setup = JSON.parse(document.getElementById("setup")?.textContent ?? "{}") as ViewSetup;
const { texts } = setup;
const root = document.getElementById("view") as HTMLElement;

let context: McpUiHostContext = {};
let data: DatabaseViewData | null = null;
let state: State = "waiting";

const app = new App({ name: "Leafdesk", version: "1.0.0" }, { availableDisplayModes: ["inline", "fullscreen"] });

/** The rows a tool result carries: its structuredContent, else the JSON text models read. */
function viewData(result: Result): DatabaseViewData | null {
  if (result.isError) return null;
  let value = result.structuredContent;
  if (value === undefined) {
    const text = result.content?.find((part) => part.type === "text")?.text;
    try {
      value = text ? JSON.parse(text) : undefined;
    } catch {
      return null;
    }
  }
  const v = value as Partial<DatabaseViewData> | undefined;
  return v && typeof v.database?.url === "string" && Array.isArray(v.columns) && Array.isArray(v.rows) ? (v as DatabaseViewData) : null;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Opens a Leafdesk address in the app's browser; nothing else is opened. */
function open(url: string) {
  if (/^https?:\/\//.test(url)) void app.openLink({ url }).catch(() => undefined);
}

function linkButton(className: string, text: string, url: string, focus: string) {
  const button = el("button", className, text);
  button.type = "button";
  button.title = text;
  button.dataset.focus = focus;
  button.addEventListener("click", () => open(url));
  return button;
}

const format = (): CellFormat => ({
  locale: setup.locale,
  timeZone: context.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone,
});

/** Only the palette's names become class names (`opt-blue`); anything else draws a plain chip. */
const COLOR = /^[a-z]{3,10}$/;

function cell(column: ViewColumn, value: unknown, f: CellFormat) {
  const td = el("td");
  const shown = viewCell(column, value, f);
  if (!shown) return td;
  if (shown.kind === "text") {
    td.textContent = shown.text;
    td.title = shown.text;
    if (shown.number) td.className = "num";
  } else if (shown.kind === "chips") {
    td.title = shown.chips.map((c) => c.text).join(", ");
    for (const chip of shown.chips) td.append(el("span", chip.color && COLOR.test(chip.color) ? `chip opt-${chip.color}` : "chip", chip.text));
  } else {
    const box = el("span", shown.checked ? "check on" : "check");
    box.setAttribute("role", "img");
    box.setAttribute("aria-label", shown.checked ? texts.checked : texts.unchecked);
    td.append(box);
  }
  return td;
}

function skeleton() {
  const box = el("div", "skeleton");
  box.setAttribute("role", "status");
  box.setAttribute("aria-label", texts.loading);
  for (const width of [40, 100, 90, 95]) {
    const line = el("div", "bar");
    line.style.width = `${width}%`;
    box.append(line);
  }
  return box;
}

function table(view: DatabaseViewData) {
  const f = format();
  const box = el("div", "table-box");
  const grid = el("table");
  const head = el("tr");
  head.append(el("th", "", texts.name), ...view.columns.map((c) => el("th", c.kind === "number" ? "num" : "", c.name)));
  grid.append(el("thead"));
  grid.tHead?.append(head);
  const body = el("tbody");
  for (const row of view.rows) {
    const tr = el("tr");
    const title = el("td", "name");
    title.append(linkButton("row-link", row.title, row.url, `row:${row.id}`));
    tr.append(title, ...view.columns.map((c) => cell(c, row.properties[c.name], f)));
    body.append(tr);
  }
  grid.append(body);
  box.append(grid);
  return box;
}

function render() {
  const focused = (document.activeElement as HTMLElement | null)?.dataset.focus;
  root.setAttribute("aria-busy", state === "waiting" || state === "loading" ? "true" : "false");
  if (state === "waiting") return root.replaceChildren(skeleton());
  if (!data) return root.replaceChildren(el("p", "note", texts.unavailable));
  const view = data;
  const header = el("header", "head");
  header.append(linkButton("title", view.database.title, view.database.url, "database"));
  const count = (n: number) => new Intl.NumberFormat(setup.locale).format(n);
  const meta = [view.view?.name, texts.showing.replace(SHOWN, count(view.rows.length)).replace(TOTAL, count(view.total))];
  header.append(el("span", "meta", meta.filter(Boolean).join(" · ")));
  const parts: HTMLElement[] = [header, view.rows.length ? table(view) : el("p", "note", texts.empty)];
  const foot = el("footer", "foot");
  if (view.next_cursor) {
    const more = el("button", "btn", texts.more);
    more.type = "button";
    more.dataset.focus = "more";
    more.disabled = state === "loading";
    more.addEventListener("click", () => void readOn());
    foot.append(more);
  }
  foot.append(linkButton("btn primary", texts.open, view.database.url, "open"));
  parts.push(foot);
  if (state === "failed") parts.push(el("p", "note failed", texts.failed));
  root.replaceChildren(...parts);
  if (focused) root.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focused)}"]`)?.focus();
}

/** The next page of rows, in full screen when the app has it: an inline card keeps to its content. */
async function readOn() {
  if (!data?.next_cursor || state === "loading") return;
  const shown = data;
  if (context.displayMode !== "fullscreen" && context.availableDisplayModes?.includes("fullscreen")) {
    await app.requestDisplayMode({ mode: "fullscreen" }).catch(() => undefined);
  }
  state = "loading";
  render();
  try {
    const next = viewData((await app.callServerTool({ name: "show_database", arguments: { ...shown.request, cursor: shown.next_cursor } })) as Result);
    if (!next) throw new Error("no rows");
    data = { ...next, rows: [...shown.rows, ...next.rows] };
    state = "shown";
  } catch {
    state = "failed";
  }
  render();
}

function applyContext(changed: Partial<McpUiHostContext>) {
  context = { ...context, ...changed };
  if (changed.theme) applyDocumentTheme(changed.theme);
  if (changed.styles?.variables) applyHostStyleVariables(changed.styles.variables);
  if (changed.styles?.css?.fonts) applyHostFonts(changed.styles.css.fonts);
  const style = document.documentElement.style;
  if (changed.safeAreaInsets) {
    for (const side of ["top", "right", "bottom", "left"] as const) style.setProperty(`--safe-${side}`, `${changed.safeAreaInsets[side]}px`);
  }
  if (changed.displayMode) document.documentElement.dataset.mode = changed.displayMode;
}

// Handlers before connect(), so the first result isn't missed.
app.onhostcontextchanged = applyContext;
app.ontoolresult = (result) => {
  data = viewData(result as Result);
  state = data ? "shown" : "unavailable";
  render();
};
app.ontoolcancelled = () => {
  if (state !== "waiting") return;
  state = "unavailable";
  render();
};

render();
void app
  .connect()
  .then(() => {
    const initial = app.getHostContext();
    if (initial) applyContext(initial);
  })
  .catch(() => undefined);
