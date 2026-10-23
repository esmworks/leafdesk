import { createExtension } from "@blocknote/core";
import { Plugin, PluginKey, type EditorState, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { findMatches, matchIndexAt, type FindMatch } from "@/lib/find-replace";

/**
 * Find in the page body: a ProseMirror plugin holding the query, its matches and their highlights.
 * The find bar (find-bar.tsx) drives it with transaction metadata and reads its state; the
 * matching itself lives in lib/find-replace.
 */

export type FindState = {
  query: string;
  caseSensitive: boolean;
  matchAccents: boolean;
  locale: string | undefined;
  matches: FindMatch[];
  /** Index of the current match, -1 when there are none. */
  current: number;
  decorations: DecorationSet;
  /** Bumped when the current match should be scrolled into view. */
  reveal: number;
};

export type FindMeta = {
  query?: string;
  caseSensitive?: boolean;
  matchAccents?: boolean;
  locale?: string;
  /** Make this match the current one. */
  current?: number;
  /** Make the first match at or after this position the current one. */
  anchor?: number;
  /** Scroll the current match into view. */
  reveal?: boolean;
};

export const findKey = new PluginKey<FindState>("leafdeskFind");

const MATCH = "leafdesk-find-match";
const CURRENT = "leafdesk-find-match leafdesk-find-current";

const EMPTY: FindState = {
  query: "",
  caseSensitive: false,
  matchAccents: false,
  locale: undefined,
  matches: [],
  current: -1,
  decorations: DecorationSet.empty,
  reveal: 0,
};

function decorate(state: EditorState, matches: FindMatch[], current: number) {
  if (matches.length === 0) return DecorationSet.empty;
  return DecorationSet.create(
    state.doc,
    matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === current ? CURRENT : MATCH }, { current: i === current })),
  );
}

/**
 * Where the current match was, in the new document. Remote edits arrive from y-prosemirror as one
 * step replacing the whole document, which maps every position to an end; the old position is
 * then the better guess, as the text around it rarely moves far.
 */
function carriedPosition(tr: Transaction, prev: FindState): number | undefined {
  const match = prev.matches[prev.current];
  if (!match) return undefined;
  const mapped = tr.mapping.mapResult(match.from, 1);
  return mapped.deleted ? match.from : mapped.pos;
}

function apply(tr: Transaction, prev: FindState, state: EditorState): FindState {
  const meta = tr.getMeta(findKey) as FindMeta | undefined;
  if (!meta && !tr.docChanged) return prev;
  const query = meta?.query ?? prev.query;
  const caseSensitive = meta?.caseSensitive ?? prev.caseSensitive;
  const matchAccents = meta?.matchAccents ?? prev.matchAccents;
  const locale = meta?.locale ?? prev.locale;
  if (!query) return prev.query ? { ...EMPTY, caseSensitive, matchAccents, locale, reveal: prev.reveal } : prev;

  const searchChanged =
    query !== prev.query || caseSensitive !== prev.caseSensitive || matchAccents !== prev.matchAccents || locale !== prev.locale;
  // Matches are found again after every change to the document, local or remote.
  const matches = searchChanged || tr.docChanged ? findMatches(state.doc, query, { caseSensitive, matchAccents, locale }) : prev.matches;

  let current: number;
  if (meta?.current !== undefined && matches.length > 0) current = Math.max(0, Math.min(meta.current, matches.length - 1));
  else if (meta?.anchor !== undefined) current = matchIndexAt(matches, meta.anchor);
  else current = matchIndexAt(matches, carriedPosition(tr, prev) ?? state.selection.from);

  if (matches === prev.matches && current === prev.current && !meta?.reveal) return prev;
  return {
    query,
    caseSensitive,
    matchAccents,
    locale,
    matches,
    current,
    decorations: decorate(state, matches, current),
    reveal: meta?.reveal ? prev.reveal + 1 : prev.reveal,
  };
}

/** Scrolls the current match to the middle of the window unless it's already comfortably in view. */
function reveal(view: EditorView) {
  const el = view.dom.querySelector<HTMLElement>(".leafdesk-find-current");
  if (!el) return;
  const rect = el.getBoundingClientRect();
  // The sticky page header and the find bar cover the top of the window.
  if (rect.top < 120 || rect.bottom > window.innerHeight - 40) el.scrollIntoView({ block: "center", inline: "nearest" });
}

/** The find plugin; `onChange` runs after the view shows a new find state. */
export function findPlugin(onChange: () => void = () => {}) {
  return new Plugin<FindState>({
    key: findKey,
    state: {
      init: () => EMPTY,
      apply: (tr, prev, _old, state) => apply(tr, prev, state),
    },
    props: {
      decorations: (state) => findKey.getState(state)?.decorations,
    },
    view: () => ({
      update(view, prevState) {
        const next = findKey.getState(view.state);
        const prev = findKey.getState(prevState);
        if (next === prev) return;
        if (next && prev && next.reveal !== prev.reveal) reveal(view);
        onChange();
      },
    }),
  });
}

export const FindReplace = createExtension(() => {
  const listeners = new Set<() => void>();
  const plugin = findPlugin(() => {
    for (const listener of listeners) listener();
  });
  return {
    key: "findReplace",
    prosemirrorPlugins: [plugin],
    /** Calls `listener` whenever the find state changes; returns the unsubscribe. */
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as const;
});
