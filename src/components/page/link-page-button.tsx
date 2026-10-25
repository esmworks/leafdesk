"use client";

import { isTableCellSelection } from "@blocknote/core";
import { FormattingToolbarExtension, ShowSelectionExtension } from "@blocknote/core/extensions";
import { useBlockNoteEditor, useComponentsContext, useDictionary, useEditorDOMElement, useEditorState, useExtension, usePortalElement } from "@blocknote/react";
import { FilePlus, Link2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import { mentionCandidatesAction } from "@/app/actions/mentions";
import { createPageAction } from "@/app/actions/pages";
import { cn, PageIcon, pageLabel } from "@/components/ui";
import { linkTarget } from "@/lib/link-target";
import { pagePath } from "@/lib/mentions";
import type { PageCandidate } from "@/server/mentions";
import type { PageEditor } from "./embed-blocks";

/** Pages the picker lists under the address field. */
const SHOWN = 6;

/**
 * The formatting toolbar's link button, in place of BlockNote's: the field takes a web address as
 * before, and also searches the workspace's pages (by the selected text until something is typed),
 * so the selected text can link to a page, or to a new page made inside this one with the text as
 * its title. Cmd/Ctrl+K opens it, as BlockNote's does.
 */
export function LinkPageButton({ workspaceId, pageId, offline }: { workspaceId: string; pageId: string; offline: boolean }) {
  const t = useTranslations("page.linkPicker");
  const tc = useTranslations("common");
  const editor = useBlockNoteEditor() as unknown as PageEditor;
  const editorElement = useEditorDOMElement();
  const Components = useComponentsContext()!;
  const dict = useDictionary();
  const portalElement = usePortalElement();
  const formattingToolbar = useExtension(FormattingToolbarExtension);
  const { showSelection } = useExtension(ShowSelectionExtension);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pages, setPages] = useState<PageCandidate[]>([]);
  const [active, setActive] = useState(-1);

  // What BlockNote's button needs to show: a selection of text that can take a link.
  const state = useEditorState({
    editor,
    selector: ({ editor }) => {
      const selection = editor.prosemirrorState.selection;
      if (!editor.isEditable || selection.empty || !("link" in editor.schema.inlineContentSchema) || isTableCellSelection(selection)) return undefined;
      const blocks = editor.getSelection()?.blocks ?? [editor.getTextCursorPosition().block];
      if (!blocks.some((block) => block.content !== undefined)) return undefined;
      return { url: editor.getSelectedLinkUrl() ?? "", text: editor.getSelectedText(), from: selection.from, to: selection.to };
    },
  });

  useEffect(() => {
    setOpen(false);
  }, [state]);
  useEffect(() => {
    showSelection(open, "linkPageButton");
    return () => showSelection(false, "linkPageButton");
  }, [open, showSelection]);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
      }
    };
    editorElement?.addEventListener("keydown", onKey);
    return () => editorElement?.removeEventListener("keydown", onKey);
  }, [editorElement]);

  const changeOpen = useCallback(
    (next: boolean) => {
      if (next) {
        setQuery(state?.url ?? "");
        setActive(-1);
      } else editor.focus();
      setOpen(next);
    },
    [editor, state?.url],
  );

  // Pages for what is typed, or for the selected text while the field is empty; none for an address.
  const term = (query.trim() || (state?.text ?? "")).slice(0, 200);
  const asAddress = linkTarget(query) !== null;
  useEffect(() => {
    if (!open || asAddress) {
      setPages([]);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      mentionCandidatesAction(pageId, term).then(
        (found) => current && setPages(found.pages.filter((p) => p.id !== pageId).slice(0, SHOWN)),
        () => current && setPages([]),
      );
    }, 120);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [open, asAddress, term, pageId]);

  if (!state) return null;

  // On the text selected when the picker opened: making a page takes a moment, and the address
  // field has the focus meanwhile.
  const { from, to } = state;
  const link = (href: string) => {
    editor.transact((tr) => tr.addMark(from, Math.min(to, tr.doc.content.size), editor.pmSchema.mark("link", { href })));
    editor.focus();
    formattingToolbar.store.setState(false);
  };
  const newTitle = (query.trim() && !asAddress ? query.trim() : state.text.trim()).slice(0, 200);
  const createAndLink = async () => {
    try {
      const { id } = await createPageAction({ workspaceId, parentId: pageId, title: newTitle });
      link(pagePath(workspaceId, id));
    } catch {
      // Not made (offline, or not allowed here): the picker stays open for another choice.
    }
  };
  const choices = pages.length + (newTitle && !offline ? 1 : 0);
  const pick = (index: number) => {
    if (index < pages.length) link(pagePath(workspaceId, pages[index].id));
    else void createAndLink();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!choices) return;
      setActive((i) => (event.key === "ArrowDown" ? (i + 1) % choices : (i <= 0 ? choices : i) - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const href = linkTarget(query);
      if (active >= 0) pick(active);
      else if (href) link(href);
      else if (pages.length) pick(0);
    } else if (event.key === "Escape") {
      event.preventDefault();
      changeOpen(false);
    }
  };

  const item = "flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm";
  return (
    <Components.Generic.Popover.Root open={open} onOpenChange={changeOpen} portalElement={portalElement}>
      <Components.Generic.Popover.Trigger>
        <Components.FormattingToolbar.Button
          className="bn-button"
          data-test="createLink"
          label={dict.formatting_toolbar.link.tooltip}
          mainTooltip={dict.formatting_toolbar.link.tooltip}
          icon={<Link2 size={16} />}
          onClick={() => changeOpen(!open)}
        />
      </Components.Generic.Popover.Trigger>
      <Components.Generic.Popover.Content className="bn-popover-content bn-form-popover" variant="form-popover">
        <div className="w-72">
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(-1);
            }}
            onKeyDown={onKeyDown}
            placeholder={t("placeholder")}
            aria-label={t("placeholder")}
            className="w-full rounded-md border border-border bg-bg px-2 py-1.5 text-sm outline-none focus:border-accent"
          />
          {choices > 0 && (
            <div role="listbox" aria-label={t("pages")} className="mt-1 flex flex-col">
              {pages.length > 0 && <span className="px-2 pt-1 pb-0.5 text-xs text-fg-muted">{t("pages")}</span>}
              {pages.map((p, i) => (
                <button
                  key={p.id}
                  type="button"
                  role="option"
                  aria-selected={active === i}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(i)}
                  className={cn(item, active === i ? "bg-bg-active" : "hover:bg-bg-hover")}
                >
                  <PageIcon icon={p.icon} kind={p.kind} className="text-sm" />
                  <span className="truncate">{pageLabel(p.title, tc("untitled"))}</span>
                </button>
              ))}
              {newTitle && !offline && (
                <button
                  type="button"
                  role="option"
                  aria-selected={active === pages.length}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(pages.length)}
                  className={cn(item, active === pages.length ? "bg-bg-active" : "hover:bg-bg-hover")}
                >
                  <FilePlus className="h-4 w-4 shrink-0 text-fg-muted" />
                  <span className="truncate">{t("newPage", { title: newTitle })}</span>
                </button>
              )}
            </div>
          )}
        </div>
      </Components.Generic.Popover.Content>
    </Components.Generic.Popover.Root>
  );
}
