"use client";

import type { Editor } from "@tiptap/core";
import { ScrollText } from "lucide-react";
import { useLocale, useTimeZone, useTranslations } from "next-intl";
import { useState } from "react";
import { mailTemplateAction } from "@/app/actions/mail";
import { useSnippetLibrary } from "@/components/snippets/library";
import { showToast } from "@/components/toast";
import { IconButton, MenuItem, Popover } from "@/components/ui";
import { matchSnippets } from "@/lib/snippets";
import { browserTimeZone } from "@/lib/time-zone";

/**
 * The composer's snippets: the person's own and the workspace's, found by title or trigger, put
 * in where the caret is (server/mail-client/templates.ts makes them mail). They are written under
 * Settings › Snippets, as for pages.
 */
export function TemplateMenu({ editor, workspaceId, subject }: { editor: Editor; workspaceId: string; subject: string }) {
  const t = useTranslations("mail.composer");
  const locale = useLocale();
  const timeZone = useTimeZone() ?? browserTimeZone();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const { library, refresh } = useSnippetLibrary(workspaceId, open);
  const found = matchSnippets(query, library.snippets).slice(0, 50);
  // Where the caret was before the menu took the focus.
  const [at, setAt] = useState<{ from: number; to: number } | null>(null);

  const put = (id: string) => {
    setBusy(true);
    void mailTemplateAction({ id, locale, timeZone, subject })
      .then((result) => {
        if (!result.ok) return showToast({ message: result.error });
        setOpen(false);
        editor
          .chain()
          .focus()
          .insertContentAt(at ?? editor.state.selection, result.data.html)
          .run();
      })
      .finally(() => setBusy(false));
  };

  return (
    <Popover
      side="top"
      open={open}
      onOpenChange={(next) => {
        if (next) {
          const { from, to } = editor.state.selection;
          setAt({ from, to });
          setQuery("");
          void refresh();
        }
        setOpen(next);
      }}
      className="w-72 p-1"
      trigger={({ toggle }) => (
        <IconButton label={t("templates")} aria-expanded={open} className="h-8 w-8 text-fg-icon" onClick={toggle}>
          <ScrollText className="h-4 w-4" />
        </IconButton>
      )}
    >
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && found[0]) {
            e.preventDefault();
            put(found[0].id);
          }
          if (e.key === "Escape") {
            e.stopPropagation();
            setOpen(false);
            editor.commands.focus();
          }
        }}
        placeholder={t("templatesSearch")}
        aria-label={t("templatesSearch")}
        className="mb-1 h-8 w-full rounded-md border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
      />
      <div className="max-h-72 overflow-y-auto" aria-busy={busy}>
        {found.map((s) => (
          <MenuItem key={s.id} disabled={busy} trailing={<span className="text-xs text-fg-faint">;{s.trigger}</span>} onClick={() => put(s.id)}>
            <span className="truncate">{s.title}</span>
          </MenuItem>
        ))}
        {!found.length && <p className="px-2 py-2 text-sm text-fg-muted">{library.snippets.length ? t("templatesNone") : t("templatesEmpty")}</p>}
      </div>
    </Popover>
  );
}
