"use client";

import { Download, MoreHorizontal, Plus, Search, TextQuote, Upload } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { createSnippetAction, deleteSnippetAction, duplicateSnippetAction, listSnippetsAction } from "@/app/actions/snippets";
import { Floating, useFloating } from "@/components/database/floating";
import { useAction } from "@/components/settings/workspace-settings";
import { Button, Dialog, IconButton, Input, MenuItem, MenuSeparator } from "@/components/ui";
import { searchFold } from "@/lib/search-fold";
import {
  MAX_SNIPPETS,
  SNIPPET_TRIGGER_CHARACTER,
  snippetExport,
  triggerFromTitle,
  type SkippedSnippet,
  type SnippetInput,
  type SnippetView,
} from "@/lib/snippets";
import { announceSnippetsChanged } from "./library";
import { SnippetDialog } from "./snippet-dialog";

type Translate = ReturnType<typeof useTranslations<"snippets">>;

/** The examples an empty list offers, in the person's language; added only when they pick one. */
function examples(t: Translate): SnippetInput[] {
  const m = (key: string) => t(`examples.meeting.${key}` as never);
  const d = (key: string) => t(`examples.decision.${key}` as never);
  return [
    {
      trigger: m("trigger"),
      title: m("title"),
      body: `## {{page}}: {{date}}\n\n**${m("attendees")}:** {{me}}\n\n### ${m("agenda")}\n\n- {{cursor}}\n\n### ${m("notes")}\n\n- \n\n### ${m("actions")}\n\n- [ ] \n`,
    },
    { trigger: t("examples.log.trigger"), title: t("examples.log.title"), body: "**{{datetime}}**: {{cursor}}\n" },
    {
      trigger: d("trigger"),
      title: d("title"),
      body: `### ${d("heading")}: {{cursor}}\n\n**${d("date")}:** {{date}} · **${d("decidedBy")}:** {{me}}\n\n#### ${d("context")}\n\n\n\n#### ${d("options")}\n\n- \n\n#### ${d("outcome")}\n\n\n\n#### ${d("consequences")}\n\n- \n`,
    },
  ].map((e) => ({ ...e, trigger: triggerFromTitle(e.trigger) || e.trigger }));
}

const matches = (query: string, s: SnippetView) => {
  const q = searchFold(query.trim());
  return !q || [s.trigger, s.title, s.body].some((v) => searchFold(v).includes(q));
};

/** The first line of the body that says something, for the list. */
const excerpt = (body: string) =>
  body
    .split("\n")
    .map((line) => line.replace(/^[#>*\-+\s[\]x]+/i, "").replace(/\*\*|__/g, "").trim())
    .find(Boolean) ?? "";

/**
 * Settings > Snippets: the person's own snippets (`workspace` null) or a workspace's. Everyone who
 * may see them can search and export them; who may change them (`canManage`) also adds, edits,
 * duplicates, deletes and imports them.
 */
export function SnippetsPanel({
  workspace,
  canManage,
  initial,
  me,
}: {
  workspace: { id: string; name: string } | null;
  canManage: boolean;
  initial: SnippetView[];
  me: string;
}) {
  const t = useTranslations("snippets");
  const ts = useTranslations("snippets.settings");
  const [snippets, setSnippets] = useState(initial);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<SnippetView | "new" | null>(null);
  const [deleting, setDeleting] = useState<SnippetView | null>(null);
  const [imported, setImported] = useState<{ added: number; skipped: SkippedSnippet[] } | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const { pending, error, run } = useAction();
  const shown = snippets.filter((s) => matches(query, s));
  const workspaceId = workspace?.id ?? null;

  const changed = (next: SnippetView[]) => {
    setSnippets([...next].sort((a, b) => a.trigger.localeCompare(b.trigger)));
    announceSnippetsChanged();
  };
  const saved = (view: SnippetView) => {
    changed([...snippets.filter((s) => s.id !== view.id), view]);
    setEditing(null);
  };

  const download = () => {
    const blob = new Blob([`${JSON.stringify(snippetExport(snippets), null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${triggerFromTitle(workspace?.name ?? "") || "leafdesk"}-snippets.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const upload = async (picked: File) => {
    setImported(null);
    setImportError(null);
    setImporting(true);
    try {
      const res = await fetch(`/api/snippets/import${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ""}`, {
        method: "POST",
        body: picked,
        headers: { "Content-Type": "application/json", "X-Leafdesk-Import": "1" },
      });
      const data = (await res.json().catch(() => null)) as { added?: number; skipped?: SkippedSnippet[]; code?: string } | null;
      if (!res.ok || !data || typeof data.added !== "number") {
        const code = data?.code;
        setImportError(
          t(code === "importTooLarge" || code === "ownersOnly" || code === "accessDenied" ? `errors.${code}` : "errors.importInvalid"),
        );
        return;
      }
      setImported({ added: data.added, skipped: data.skipped ?? [] });
      const list = await listSnippetsAction(workspaceId);
      if (list.ok) changed(list.data);
    } catch {
      setImportError(t("errors.importInvalid"));
    } finally {
      setImporting(false);
      if (file.current) file.current.value = "";
    }
  };

  // Offered while the list holds nothing but examples, so adding one doesn't hide the others.
  const all = examples(t);
  const offered = all.filter((e) => !snippets.some((s) => s.trigger === e.trigger));
  const onlyExamples = snippets.every((s) => all.some((e) => e.trigger === s.trigger));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:flex-none">
          <Search className="pointer-events-none absolute top-1/2 inset-s-2 h-3.5 w-3.5 -translate-y-1/2 text-fg-faint" />
          <Input
            type="search"
            aria-label={ts("search")}
            placeholder={ts("search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="ps-7 sm:w-56"
          />
        </div>
        <span className="text-xs text-fg-muted">{ts("count", { count: snippets.length, max: MAX_SNIPPETS })}</span>
        <div className="ms-auto flex flex-wrap items-center gap-2">
          {canManage && (
            <>
              <input
                ref={file}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(e) => {
                  const picked = e.target.files?.[0];
                  if (picked) void upload(picked);
                }}
              />
              <Button onClick={() => file.current?.click()} disabled={importing}>
                <Upload className="h-3.5 w-3.5" />
                {importing ? ts("importing") : ts("import")}
              </Button>
            </>
          )}
          <Button onClick={download} disabled={!snippets.length}>
            <Download className="h-3.5 w-3.5" />
            {ts("export")}
          </Button>
          {canManage && (
            <Button variant="primary" onClick={() => setEditing("new")}>
              <Plus className="h-3.5 w-3.5" />
              {ts("new")}
            </Button>
          )}
        </div>
      </div>
      {!canManage && <p className="text-xs text-fg-muted">{ts("ownersOnly")}</p>}
      {(imported || importError) && (
        <div role="status" className="rounded-lg border border-border bg-bg-subtle px-4 py-3 text-sm" data-snippet-import-result>
          {importError ? (
            <p className="text-danger">{ts("importFailed", { error: importError })}</p>
          ) : (
            imported && (
              <>
                <p>{ts("imported", { count: imported.added })}</p>
                {imported.skipped.length > 0 && (
                  <div className="mt-1 text-fg-muted">
                    <p>{ts("skipped", { count: imported.skipped.length })}</p>
                    <ul className="mt-1 max-h-40 list-disc space-y-0.5 overflow-y-auto ps-5">
                      {imported.skipped.map((s, i) => (
                        <li key={i}>
                          <span className="text-fg">{s.trigger ? `${SNIPPET_TRIGGER_CHARACTER}${s.trigger}` : ts("untitledTrigger")}</span>
                          {": "}
                          {ts(`skip.${s.reason}`)}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )
          )}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-border">
        {shown.length ? (
          <ul className="divide-y divide-border">
            {shown.map((s) => (
              <SnippetRow
                key={s.id}
                snippet={s}
                canManage={canManage}
                onEdit={() => setEditing(s)}
                onDuplicate={() => run(() => duplicateSnippetAction(s.id), (copy) => changed([...snippets, copy]))}
                onDelete={() => setDeleting(s)}
              />
            ))}
          </ul>
        ) : (
          <p className="px-4 py-8 text-center text-sm text-fg-muted">
            {snippets.length ? ts("noMatches") : canManage ? ts("emptyOwner") : ts("empty")}
          </p>
        )}
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}

      {canManage && onlyExamples && offered.length > 0 && (
        <section className="space-y-2" data-snippet-examples>
          <h2 className="text-[15px] font-semibold">{ts("examplesHeading")}</h2>
          <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-bg-subtle/60">
            {offered.map((example) => (
              <li key={example.trigger} className="flex items-center gap-3 px-4 py-3">
                <TextQuote className="h-4 w-4 shrink-0 text-fg-muted" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{example.title}</div>
                  <div className="truncate text-xs text-fg-muted">
                    {SNIPPET_TRIGGER_CHARACTER}
                    {example.trigger}
                  </div>
                </div>
                <Button
                  size="sm"
                  disabled={pending}
                  onClick={() => run(() => createSnippetAction(workspaceId, example), (view) => changed([...snippets, view]))}
                >
                  {ts("addExample")}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {editing && (
        <SnippetDialog
          snippet={editing === "new" ? undefined : editing}
          targets={workspace ? { personal: false, workspace } : { personal: true, workspace: null }}
          me={me}
          onSaved={saved}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting && (
        <DeleteDialog
          snippet={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            changed(snippets.filter((s) => s.id !== deleting.id));
            setDeleting(null);
          }}
        />
      )}
    </div>
  );
}

function SnippetRow({
  snippet,
  canManage,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  snippet: SnippetView;
  canManage: boolean;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations("snippets.settings");
  const menu = useFloating<HTMLButtonElement>();
  const content = (
    <>
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="truncate text-sm font-medium">{snippet.title}</span>
        <span className="shrink-0 text-xs text-fg-muted">
          {SNIPPET_TRIGGER_CHARACTER}
          {snippet.trigger}
        </span>
      </div>
      <div className="truncate text-xs text-fg-muted">{excerpt(snippet.body)}</div>
    </>
  );
  return (
    <li className="flex items-center gap-2 px-4 py-2.5" data-snippet={snippet.trigger}>
      {canManage ? (
        <button type="button" onClick={onEdit} className="min-w-0 flex-1 text-start">
          {content}
        </button>
      ) : (
        <div className="min-w-0 flex-1">{content}</div>
      )}
      {canManage && (
        <>
          <IconButton ref={menu.ref} label={t("actionsFor", { title: snippet.title })} onClick={menu.toggle}>
            <MoreHorizontal className="h-4 w-4" />
          </IconButton>
          <Floating anchor={menu.el} open={menu.open} onClose={menu.close} align="end" className="text-start">
            <MenuItem
              onClick={() => {
                menu.close();
                onEdit();
              }}
            >
              {t("edit")}
            </MenuItem>
            <MenuItem
              onClick={() => {
                menu.close();
                onDuplicate();
              }}
            >
              {t("duplicate")}
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              danger
              onClick={() => {
                menu.close();
                onDelete();
              }}
            >
              {t("delete")}
            </MenuItem>
          </Floating>
        </>
      )}
    </li>
  );
}

function DeleteDialog({ snippet, onClose, onDeleted }: { snippet: SnippetView; onClose: () => void; onDeleted: () => void }) {
  const t = useTranslations("snippets.settings");
  const tc = useTranslations("common");
  const { pending, error, run } = useAction();
  return (
    <Dialog open onClose={onClose} className="max-w-md">
      <div className="space-y-3 p-5">
        <h2 className="text-base font-semibold">{t("deleteTitle", { title: snippet.title })}</h2>
        <p className="text-sm text-fg-muted">{t("deleteBody")}</p>
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button variant="danger" disabled={pending} onClick={() => run(() => deleteSnippetAction(snippet.id), onDeleted)}>
            {t("delete")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
