"use client";

import { createExtension } from "@blocknote/core";
import type { DefaultReactSuggestionItem } from "@blocknote/react";
import { AppWindow, ArrowLeft, ArrowRight, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { ySyncPluginKey } from "y-prosemirror";
import { Floating, useFloating } from "@/components/database/floating";
import { isRtl } from "@/components/direction";
import { cn, IconButton, Input, MenuItem, MenuSeparator } from "@/components/ui";
import { COLUMN_BLOCK } from "@/lib/columns";
import { TAB_EDIT, tabGuard } from "@/lib/tab-guard";
import { MAX_TAB_TITLE, MAX_TABS, TAB_BLOCK, TAB_LIST_BLOCK, tabBlockSpecs, TabListNode, TabNode, tabTitle } from "@/lib/tabs";
import type { PageEditor } from "./embed-blocks";

/**
 * The editor's side of tabs (nodes shared with the server in lib/tabs): the tab strip above a tab
 * list's tabs, showing one tab at a time, and what keeps the shown tab and the cursor together.
 *
 * Which tab shows is this reader's own, never in the document: a tab list's node view keeps it and
 * hides the other tabs with a rule of its own (a `<style>` beside the strip, by the tab's place,
 * so it holds while ProseMirror redraws the tabs). The strip itself is React, drawn into each
 * list's strip element by `TabStrips` (mounted inside each BlockNoteView that shows page blocks)
 * through a portal, so it has the page's texts and menus.
 *
 * The cursor never stays in a hidden tab: clicking a tab moves it there, and when anything else
 * moves it into another tab (undo, find, a link to a block) that tab shows. Backspace at the start
 * of a block right after a tab list moves it into the tab that shows, not the last one, and Delete
 * at the end of the block before one does nothing (BlockNote would pull in the first tab's block).
 */

// ---------------------------------------------------------------------------------------------
// The strips of the open editors

type StripTab = { id: string | null; title: string };

type Strip = {
  /** This node view's own key: ids can be missing for a moment or repeat after a paste. */
  key: string;
  element: HTMLElement;
  view: EditorView;
  getPos: () => number | undefined;
  listId: string | null;
  tabs: StripTab[];
  /** The tab that shows, by place, and its id to find it again when tabs move. */
  active: number;
  activeId: string | null;
  /** Writes the rule hiding the other tabs. */
  apply: () => void;
};

const strips = new Map<string, Strip>();
const listeners = new Set<() => void>();
let snapshot: Strip[] = [];
const NONE: Strip[] = [];
/** The tab chosen in each list, by the list's id, kept while the page is open (node views come and go). */
const chosen = new Map<string, string>();

let pending = false;
function changed() {
  // Node views are made while ProseMirror updates, which may be inside a React render.
  if (pending) return;
  pending = true;
  queueMicrotask(() => {
    pending = false;
    snapshot = [...strips.values()];
    for (const listener of listeners) listener();
  });
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

const newKey = () => `t${Math.random().toString(36).slice(2, 10)}`;

/** Shows tab `index` of the strip's list. */
function activate(strip: Strip, index: number) {
  const at = Math.min(Math.max(index, 0), Math.max(strip.tabs.length - 1, 0));
  strip.active = at;
  strip.activeId = strip.tabs[at]?.id ?? null;
  if (strip.listId && strip.activeId) chosen.set(strip.listId, strip.activeId);
  strip.apply();
  changed();
}

const stripOf = (view: EditorView, listPos: number) => [...strips.values()].find((s) => s.view === view && s.getPos() === listPos);

// ---------------------------------------------------------------------------------------------
// Nodes

const EditorTabListNode = TabListNode.extend({
  addNodeView() {
    return ({ node: initial, getPos, view }) => {
      let node = initial;
      const key = newKey();
      const dom = document.createElement("div");
      dom.className = "leafdesk-tab-list";
      dom.setAttribute("data-node-type", TAB_LIST_BLOCK);
      dom.setAttribute("data-tabs-key", key);
      const style = document.createElement("style");
      const stripElement = document.createElement("div");
      stripElement.className = "leafdesk-tab-strip";
      stripElement.contentEditable = "false";
      const contentDOM = document.createElement("div");
      contentDOM.className = "leafdesk-tab-panels";
      dom.append(style, stripElement, contentDOM);

      const strip: Strip = {
        key,
        element: stripElement,
        view,
        getPos: () => (typeof getPos === "function" ? getPos() : undefined),
        listId: null,
        tabs: [],
        active: 0,
        activeId: null,
        apply: () => {
          style.textContent = `.leafdesk-tab-list[data-tabs-key="${key}"]>.leafdesk-tab-panels>.leafdesk-tab:not(:nth-child(${strip.active + 1})){display:none}`;
        },
      };

      const sync = () => {
        strip.listId = node.attrs.id ? String(node.attrs.id) : null;
        if (strip.listId) dom.setAttribute("data-id", strip.listId);
        else dom.removeAttribute("data-id");
        const tabs: StripTab[] = [];
        node.forEach((tab) => tabs.push({ id: tab.attrs.id ? String(tab.attrs.id) : null, title: tabTitle(tab.attrs.title) }));
        strip.tabs = tabs;
        // The same tab as before wherever it went, else the one chosen earlier, else the same place.
        const wanted = strip.activeId ?? (strip.listId ? chosen.get(strip.listId) : undefined) ?? null;
        const found = wanted ? tabs.findIndex((tab) => tab.id === wanted) : -1;
        strip.active = found >= 0 ? found : Math.min(strip.active, Math.max(tabs.length - 1, 0));
        strip.activeId = tabs[strip.active]?.id ?? null;
        strip.apply();
        changed();
      };
      sync();
      strips.set(key, strip);

      return {
        dom,
        contentDOM,
        update(next: PMNode) {
          if (next.type !== node.type) return false;
          node = next;
          sync();
          return true;
        },
        // The strip and the rule are ours; ProseMirror only reads the tabs.
        ignoreMutation(mutation: MutationRecord | { type: "selection"; target: Node }) {
          if (mutation.type === "selection") return false;
          return !contentDOM.contains(mutation.target) || (mutation.type === "attributes" && mutation.target === contentDOM);
        },
        stopEvent(event: Event) {
          return event.target instanceof Node && stripElement.contains(event.target);
        },
        destroy() {
          strips.delete(key);
          changed();
        },
      };
    };
  },
});

const EditorTabNode = TabNode.extend({
  addNodeView() {
    return ({ node: initial }) => {
      let node = initial;
      const dom = document.createElement("div");
      dom.className = "leafdesk-tab";
      dom.setAttribute("data-node-type", TAB_BLOCK);
      dom.setAttribute("role", "tabpanel");
      const sync = () => {
        if (node.attrs.id) dom.setAttribute("data-id", String(node.attrs.id));
        else dom.removeAttribute("data-id");
        const title = tabTitle(node.attrs.title);
        if (title) dom.setAttribute("aria-label", title);
        else dom.removeAttribute("aria-label");
      };
      sync();
      return {
        dom,
        contentDOM: dom,
        update(next: PMNode) {
          if (next.type !== node.type) return false;
          node = next;
          sync();
          return true;
        },
        ignoreMutation(mutation: MutationRecord | { type: "selection"; target: Node }) {
          return mutation.type === "attributes" && mutation.target === dom;
        },
      };
    };
  },
});

// ---------------------------------------------------------------------------------------------
// Ids, the cursor and the keyboard

/** Where the transactions changed the last document, as ranges in it. */
function changedRanges(transactions: readonly Transaction[]): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  transactions.forEach((tr, i) => {
    const later = transactions.slice(i + 1);
    tr.mapping.maps.forEach((map, m) => {
      map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
        // Through the rest of this transaction's steps, then the transactions after it.
        let from = newStart;
        let to = newEnd;
        for (const next of tr.mapping.maps.slice(m + 1)) {
          from = next.map(from, -1);
          to = next.map(to, 1);
        }
        for (const t of later) {
          from = t.mapping.map(from, -1);
          to = t.mapping.map(to, 1);
        }
        ranges.push({ from, to });
      });
    });
  });
  return ranges;
}

/**
 * Tab lists and tabs that came in without an id, or with one another already has (a paste of
 * copied tabs), get a new one. Only nodes wholly inside what changed are looked at, so typing in a
 * tab costs nothing; others' changes arrive with their ids.
 */
const tabIds = new Plugin({
  key: new PluginKey("leafdeskTabIds"),
  appendTransaction(transactions, _old, state) {
    if (!transactions.some((tr) => tr.docChanged) || transactions.some((tr) => tr.getMeta(ySyncPluginKey))) return null;
    const fresh: { pos: number; id: string | null }[] = [];
    for (const { from, to } of changedRanges(transactions)) {
      if (to <= from) continue;
      state.doc.nodesBetween(from, Math.min(to, state.doc.content.size), (node, pos) => {
        if (node.isTextblock) return false;
        const type = node.type.name;
        if ((type === TAB_LIST_BLOCK || type === TAB_BLOCK) && pos >= from && pos + node.nodeSize <= to) {
          fresh.push({ pos, id: node.attrs.id ? String(node.attrs.id) : null });
        }
        return true;
      });
    }
    if (!fresh.length) return null;
    const count = new Map<string, number>();
    state.doc.descendants((node) => {
      if (node.isTextblock) return false;
      if ((node.type.name === TAB_LIST_BLOCK || node.type.name === TAB_BLOCK) && node.attrs.id) {
        count.set(String(node.attrs.id), (count.get(String(node.attrs.id)) ?? 0) + 1);
      }
      return true;
    });
    const tr = state.tr;
    const done = new Set<number>();
    for (const { pos, id } of fresh) {
      if (done.has(pos) || (id && (count.get(id) ?? 0) < 2)) continue;
      done.add(pos);
      if (id) count.set(id, (count.get(id) ?? 1) - 1);
      tr.setNodeAttribute(pos, "id", crypto.randomUUID());
    }
    return tr.docChanged ? tr : null;
  },
});

/** The tab the cursor is in: its list's place and its index there, or null. */
function tabAt(state: EditorState): { listPos: number; index: number; id: string | null } | null {
  const $head = state.selection.$head;
  for (let d = $head.depth; d > 0; d--) {
    if ($head.node(d).type.name !== TAB_BLOCK) continue;
    const id = $head.node(d).attrs.id;
    return { listPos: $head.before(d - 1), index: $head.index(d - 1), id: id ? String(id) : null };
  }
  return null;
}

/** Shows the tab the cursor went into, when it went into another one. */
const followCursor = new Plugin({
  key: new PluginKey("leafdeskTabCursor"),
  view: () => ({
    update(view, prev) {
      if (prev.selection.eq(view.state.selection)) return;
      const now = tabAt(view.state);
      if (!now) return;
      const before = tabAt(prev);
      if (before && before.id === now.id && before.index === now.index) return;
      const strip = stripOf(view, now.listPos);
      if (strip && strip.active !== now.index) activate(strip, now.index);
    },
  }),
});

/** The block the cursor is at the start (or end) of, with its group: the tab, column or list it is in. */
function blockAtCursor(state: EditorState, edge: "start" | "end") {
  const { selection } = state;
  if (!selection.empty) return null;
  const $from = selection.$from;
  if (!$from.parent.isTextblock) return null;
  if (edge === "start" ? $from.parentOffset !== 0 : $from.parentOffset !== $from.parent.content.size) return null;
  const d = $from.depth - 1;
  if (d < 1 || $from.node(d).type.name !== "blockContainer") return null;
  return { block: $from.node(d), pos: $from.before(d), group: $from.node(d - 1), index: $from.index(d - 1) };
}

function backspace(view: EditorView): boolean {
  const at = blockAtCursor(view.state, "start");
  if (!at) return false;
  const { block, pos, group, index } = at;
  if (index === 0) {
    // The first block of a tab has nothing before it in the tab: a paragraph stays (another kind
    // turns into one first, BlockNote's own Backspace).
    return group.type.name === TAB_BLOCK && block.firstChild?.type.name === "paragraph";
  }
  const list = group.child(index - 1);
  if (list.type.name !== TAB_LIST_BLOCK) return false;
  const listPos = pos - list.nodeSize;
  const active = Math.min(stripOf(view, listPos)?.active ?? 0, list.childCount - 1);
  let tabPos = listPos + 1;
  for (let i = 0; i < active; i++) tabPos += list.child(i).nodeSize;
  // The end of the tab's content, inside it.
  const end = tabPos + list.child(active).nodeSize - 1;
  const tr = view.state.tr.delete(pos, pos + block.nodeSize);
  const empty = block.childCount === 1 && block.firstChild!.content.size === 0;
  if (empty) {
    // An empty line just goes, the cursor to the end of the tab.
    tr.setSelection(TextSelection.near(tr.doc.resolve(end - 1), -1));
  } else {
    tr.insert(end, block);
    tr.setSelection(TextSelection.near(tr.doc.resolve(end + 1)));
  }
  view.dispatch(tr.scrollIntoView());
  return true;
}

function forwardDelete(view: EditorView): boolean {
  const at = blockAtCursor(view.state, "end");
  if (!at || at.block.childCount !== 1) return false;
  return at.index + 1 < at.group.childCount && at.group.child(at.index + 1).type.name === TAB_LIST_BLOCK;
}

const TabBehaviour = createExtension(() => ({
  key: "leafdeskTabs",
  prosemirrorPlugins: [tabIds, tabGuard, followCursor],
}));

/**
 * Backspace and Delete beside tabs, in the editor's own extensions (as SmartQuotes): ahead of
 * BlockNote's Backspace, which would join the line with the text of the tab that shows. What still
 * gets past them (the browser's own deletion) meets lib/tab-guard.
 */
export const TabKeys = createExtension(() => ({
  key: "leafdeskTabKeys",
  keyboardShortcuts: {
    Backspace: ({ editor }) => (editor.prosemirrorView ? backspace(editor.prosemirrorView) : false),
    Delete: ({ editor }) => (editor.prosemirrorView ? forwardDelete(editor.prosemirrorView) : false),
  },
}));

/** The editor's tab blocks: the strip's node views and the behaviour above. */
export const tabEditorBlockSpecs = tabBlockSpecs({ tabList: EditorTabListNode, tab: EditorTabNode, extensions: [TabBehaviour()] });

// ---------------------------------------------------------------------------------------------
// Changing tabs

/** The strip's tab list in the current document, if it is still there. */
function listOf(strip: Strip): { pos: number; node: PMNode } | null {
  const pos = strip.getPos();
  const node = pos === undefined ? null : strip.view.state.doc.nodeAt(pos);
  return node?.type.name === TAB_LIST_BLOCK && pos !== undefined ? { pos, node } : null;
}

function tabPosition(list: { pos: number; node: PMNode }, index: number): number {
  let at = list.pos + 1;
  for (let i = 0; i < index; i++) at += list.node.child(i).nodeSize;
  return at;
}

/** Shows tab `index` and, where the reader may edit, puts the cursor at its start. */
function choose(strip: Strip, index: number, editable: boolean) {
  activate(strip, index);
  const list = listOf(strip);
  if (!editable || !list || index >= list.node.childCount) return;
  const { view } = strip;
  view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(tabPosition(list, index) + 1))));
}

function rename(strip: Strip, index: number, title: string) {
  const list = listOf(strip);
  if (!list || index >= list.node.childCount) return;
  const value = tabTitle(title);
  if (tabTitle(list.node.child(index).attrs.title) === value) return;
  strip.view.dispatch(strip.view.state.tr.setNodeAttribute(tabPosition(list, index), "title", value));
}

/** Adds a tab at the end, named: an untitled tab is named by its place, so it would seem to stay put when moved. */
function addTab(strip: Strip, title: string) {
  const list = listOf(strip);
  if (!list || list.node.childCount >= MAX_TABS) return;
  const { view } = strip;
  const { schema } = view.state;
  const line = schema.nodes.blockContainer.createAndFill();
  if (!line) return;
  const id = crypto.randomUUID();
  const at = list.pos + list.node.nodeSize - 1;
  const tr = view.state.tr.insert(at, schema.nodes[TAB_BLOCK].create({ id, title: tabTitle(title) }, line));
  tr.setSelection(TextSelection.near(tr.doc.resolve(at + 1)));
  // The new tab shows once the list has it (sync finds it by its id).
  strip.activeId = id;
  if (strip.listId) chosen.set(strip.listId, id);
  view.dispatch(tr);
  view.focus();
}

function moveTab(strip: Strip, index: number, by: -1 | 1) {
  const list = listOf(strip);
  const to = index + by;
  if (!list || to < 0 || to >= list.node.childCount) return;
  const tab = list.node.child(index);
  const from = tabPosition(list, index);
  const tr = strip.view.state.tr.delete(from, from + tab.nodeSize);
  // The other tab's place after the deletion: before it, or past it.
  const place = by < 0 ? tabPosition(list, to) : from + list.node.child(to).nodeSize;
  tr.insert(place, tab);
  strip.view.dispatch(tr.setMeta(TAB_EDIT, true));
  // Back to the page, so Cmd+Z undoes it at once.
  strip.view.focus();
}

function removeTab(strip: Strip, index: number) {
  const list = listOf(strip);
  if (!list || index >= list.node.childCount) return;
  const tr = strip.view.state.tr;
  if (list.node.childCount === 1) tr.delete(list.pos, list.pos + list.node.nodeSize);
  else {
    const from = tabPosition(list, index);
    tr.delete(from, from + list.node.child(index).nodeSize);
  }
  strip.view.dispatch(tr.setMeta(TAB_EDIT, true));
  strip.view.focus();
}

function removeList(strip: Strip) {
  const list = listOf(strip);
  if (!list) return;
  strip.view.dispatch(strip.view.state.tr.delete(list.pos, list.pos + list.node.nodeSize).setMeta(TAB_EDIT, true));
  strip.view.focus();
}

// ---------------------------------------------------------------------------------------------
// The strip

/**
 * The strips of `editor`'s tab lists, each drawn into its list. Mounted inside every BlockNoteView
 * showing page blocks; without it a list shows its first tab and no strip.
 */
export function TabStrips({ editor, editable }: { editor: { prosemirrorView: EditorView | undefined }; editable: boolean }) {
  const all = useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => NONE,
  );
  const view = editor.prosemirrorView;
  return (
    <>
      {all
        .filter((strip) => strip.view === view)
        .map((strip) => createPortal(<TabStrip strip={strip} tabs={strip.tabs} active={strip.active} editable={editable} />, strip.element, strip.key))}
    </>
  );
}

function TabStrip({ strip, tabs, active, editable }: { strip: Strip; tabs: StripTab[]; active: number; editable: boolean }) {
  const t = useTranslations("page.blocks.tabs");
  const [renaming, setRenaming] = useState<number | null>(null);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const name = (tab: StripTab, i: number) => tab.title || t("untitled", { number: i + 1 });
  // "Tab 3" for a third tab, or the next number no tab shows yet.
  const freshName = () => {
    const shown = new Set(tabs.map(name));
    let n = tabs.length + 1;
    while (shown.has(t("untitled", { number: n }))) n++;
    return t("untitled", { number: n });
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (!(e.target instanceof HTMLButtonElement)) return;
    const back = isRtl(e.currentTarget) ? "ArrowRight" : "ArrowLeft";
    const next =
      e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : e.key === back ? active - 1 : e.key === "ArrowLeft" || e.key === "ArrowRight" ? active + 1 : null;
    if (next === null) return;
    e.preventDefault();
    const to = (next + tabs.length) % tabs.length;
    activate(strip, to);
    refs.current[to]?.focus();
  };
  const full = tabs.length >= MAX_TABS;
  return (
    <div className="flex min-w-0 items-end gap-1 border-b border-border">
      <div role="tablist" aria-label={t("label")} onKeyDown={onKeyDown} className="-mb-px flex min-w-0 items-end gap-0.5 overflow-x-auto overflow-y-hidden pb-px">
        {tabs.map((tab, i) =>
          editable && renaming === i ? (
            <Input
              key={tab.id ?? i}
              autoFocus
              defaultValue={tab.title}
              maxLength={MAX_TAB_TITLE}
              placeholder={t("untitled", { number: i + 1 })}
              aria-label={t("nameLabel")}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                  setRenaming(null);
                  rename(strip, i, e.currentTarget.value);
                } else if (e.key === "Escape") setRenaming(null);
              }}
              onBlur={(e) => {
                setRenaming(null);
                rename(strip, i, e.currentTarget.value);
              }}
              className="mb-1 h-7 w-44"
            />
          ) : (
            <div key={tab.id ?? i} className={cn("relative -mb-px flex shrink-0 items-center border-b-2", i === active ? "border-accent" : "border-transparent")}>
              <button
                ref={(el) => void (refs.current[i] = el)}
                type="button"
                role="tab"
                aria-selected={i === active}
                tabIndex={i === active ? 0 : -1}
                onClick={() => choose(strip, i, editable)}
                onDoubleClick={editable ? () => setRenaming(i) : undefined}
                className={cn(
                  "flex max-w-56 min-w-0 items-center rounded-t px-2.5 py-1.5 text-sm hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-accent",
                  i === active ? "font-medium text-fg" : "text-fg-muted hover:text-fg",
                )}
              >
                <span className="truncate">{name(tab, i)}</span>
              </button>
              {editable && i === active && (
                <TabMenu
                  first={i === 0}
                  last={i === tabs.length - 1}
                  rename={() => setRenaming(i)}
                  move={(by) => moveTab(strip, i, by)}
                  remove={() => removeTab(strip, i)}
                  removeAll={() => removeList(strip)}
                />
              )}
            </div>
          ),
        )}
      </div>
      {editable && (
        <IconButton label={t("add")} title={full ? t("full", { max: MAX_TABS }) : t("add")} disabled={full} onClick={() => addTab(strip, freshName())} className="mb-1 shrink-0">
          <Plus className="h-4 w-4" />
        </IconButton>
      )}
    </div>
  );
}

function TabMenu({
  first,
  last,
  rename,
  move,
  remove,
  removeAll,
}: {
  first: boolean;
  last: boolean;
  rename: () => void;
  move: (by: -1 | 1) => void;
  remove: () => void;
  removeAll: () => void;
}) {
  const t = useTranslations("page.blocks.tabs");
  const menu = useFloating<HTMLButtonElement>();
  const run = (action: () => void) => () => {
    menu.close();
    action();
  };
  return (
    <>
      <IconButton ref={menu.ref} label={t("menu")} onClick={menu.toggle}>
        <MoreHorizontal className="h-3.5 w-3.5" />
      </IconButton>
      <Floating open={menu.open} anchor={menu.el} onClose={menu.close} align="end">
        <div className="w-48">
          <MenuItem icon={<Pencil className="h-3.5 w-3.5" />} onClick={run(rename)}>
            {t("rename")}
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<ArrowLeft className="h-3.5 w-3.5 rtl:-scale-x-100" />} disabled={first} onClick={run(() => move(-1))}>
            {t("moveBefore")}
          </MenuItem>
          <MenuItem icon={<ArrowRight className="h-3.5 w-3.5 rtl:-scale-x-100" />} disabled={last} onClick={run(() => move(1))}>
            {t("moveAfter")}
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<Trash2 className="h-3.5 w-3.5" />} danger onClick={run(remove)}>
            {t("remove")}
          </MenuItem>
          <MenuItem icon={<Trash2 className="h-3.5 w-3.5" />} danger onClick={run(removeAll)}>
            {t("removeAll")}
          </MenuItem>
        </div>
      </Floating>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Slash menu

type AnyBlock = PageEditor["document"][number];

const emptyLine = (block: AnyBlock) =>
  block.type === "paragraph" &&
  !block.children.length &&
  Array.isArray(block.content) &&
  (block.content.length === 0 || (block.content.length === 1 && block.content[0].type === "text" && block.content[0].text.trim() === "/"));

/** "Tabs" in the slash menu, read when the menu opens: not inside a tab (tabs don't nest) or a column. */
export function useTabSlashItems(editor: PageEditor): () => DefaultReactSuggestionItem[] {
  const t = useTranslations("page.blocks.tabs");
  return useCallback(() => {
    const block = editor.getTextCursorPosition().block;
    for (let parent = editor.getParentBlock(block); parent; parent = editor.getParentBlock(parent)) {
      if (parent.type === TAB_BLOCK || parent.type === COLUMN_BLOCK) return [];
    }
    return [
      {
        title: t("title"),
        subtext: t("subtext"),
        aliases: t("aliases").split(" "),
        group: editor.dictionary.slash_menu.table.group,
        icon: <AppWindow size={18} />,
        onItemClick: () => {
          const current = editor.getTextCursorPosition().block;
          // Named from the start (see addTab).
          const tab = (number: number) => ({ type: TAB_BLOCK, props: { title: t("untitled", { number }) }, children: [{ type: "paragraph" }] });
          const list = { type: TAB_LIST_BLOCK, children: [tab(1), tab(2)] };
          editor.transact(() => {
            const [placed] = emptyLine(current)
              ? editor.replaceBlocks([current], [list] as never).insertedBlocks
              : editor.insertBlocks([list] as never, current, "after");
            const first = placed?.children[0]?.children[0];
            if (first) editor.setTextCursorPosition(first, "start");
          });
        },
      },
    ];
  }, [editor, t]);
}
