"use client";

import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import { BlockNoteView } from "@blocknote/mantine";
import { useCreateBlockNote } from "@blocknote/react";
import { History, X } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useMemo, useState, useTransition } from "react";
import { diffSnapshotAction, getSnapshotAction, listSnapshotsAction, restoreSnapshotAction } from "@/app/actions/pages";
import { Button, cn, IconButton, pageLabel } from "@/components/ui";
import { useEditorDictionary } from "@/i18n/blocknote";
import { DATABASE_BLOCK, mapReferenceLines } from "@/lib/embed-blocks";
import { HistoryDiff, type VersionDiff } from "./history-diff";

type SnapshotItem = Awaited<ReturnType<typeof listSnapshotsAction>>[number];
/** What the preview shows: the version itself, or its changes against the current page or the version before it. */
type Mode = "version" | "current" | "previous";
const MODES: Mode[] = ["version", "current", "previous"];

function Preview({ markdown }: { markdown: string }) {
  const dictionary = useEditorDictionary();
  const te = useTranslations("page.embed");
  const editor = useCreateBlockNote({ dictionary }, [dictionary]);
  // A database block is only named here: the version keeps which database, not its rows back then.
  const text = useMemo(
    () => mapReferenceLines(markdown || "", (ref) => `*${te(ref.type === DATABASE_BLOCK ? "label" : "linkedLabel")}*`),
    [markdown, te],
  );
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const blocks = await editor.tryParseMarkdownToBlocks(text);
      if (!cancelled) editor.replaceBlocks(editor.document, blocks.length ? blocks : [{ type: "paragraph" }]);
    })();
    return () => {
      cancelled = true;
    };
  }, [editor, text]);
  return <BlockNoteView editor={editor} editable={false} sideMenu={false} slashMenu={false} formattingToolbar={false} />;
}

export function HistoryPanel({ pageId, onClose, readOnly }: { pageId: string; onClose: () => void; readOnly: boolean }) {
  const [items, setItems] = useState<SnapshotItem[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ title: string; markdown: string } | null>(null);
  const [mode, setMode] = useState<Mode>("version");
  // Keyed by version and mode, so a late answer for an earlier choice is not shown.
  const [diff, setDiff] = useState<{ key: string; value: VersionDiff | null } | null>(null);
  const [restoring, startRestore] = useTransition();
  const [error, setError] = useState<"list" | "version" | "diff" | "restore" | null>(null);
  const t = useTranslations("page.history");
  const tc = useTranslations("common");
  const format = useFormatter();

  function describe(s: SnapshotItem) {
    switch (s.reason) {
      case "before_mcp_write":
        return s.clientName ? t("reasons.beforeAiEditBy", { client: s.clientName }) : t("reasons.beforeAiEdit");
      case "auto":
        return t("reasons.auto");
      case "before_restore":
        return t("reasons.beforeRestore");
      case "before_ai_edit":
        return t("reasons.beforeAssistantEdit");
      case "manual":
        return t("reasons.manual");
      default:
        return s.reason;
    }
  }

  useEffect(() => {
    let cancelled = false;
    listSnapshotsAction(pageId)
      .then((list) => {
        if (cancelled) return;
        setItems(list);
        if (list[0]) setSelected(list[0].id);
      })
      .catch(() => {
        if (cancelled) return;
        setItems([]);
        setError("list");
      });
    return () => {
      cancelled = true;
    };
  }, [pageId]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setPreview(null);
    setError((e) => (e === "version" ? null : e));
    getSnapshotAction(selected)
      .then((s) => !cancelled && setPreview({ title: s.title, markdown: s.contentMarkdown }))
      .catch(() => !cancelled && setError("version"));
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const diffKey = selected && mode !== "version" ? `${selected}:${mode}` : null;
  useEffect(() => {
    if (!selected || mode === "version") return;
    let cancelled = false;
    setError((e) => (e === "diff" ? null : e));
    diffSnapshotAction(selected, mode)
      .then((value) => !cancelled && setDiff({ key: `${selected}:${mode}`, value }))
      .catch(() => !cancelled && setError("diff"));
    return () => {
      cancelled = true;
    };
  }, [selected, mode]);

  const savedAt = (id: string | null) => {
    const item = id ? items?.find((s) => s.id === id) : undefined;
    return item ? format.dateTime(new Date(item.createdAt), { dateStyle: "medium", timeStyle: "short" }) : null;
  };

  function renderBody() {
    if (mode === "version") {
      if (preview) return <Preview markdown={preview.markdown} />;
      // A failed load shows its error beside the Restore button instead of loading forever.
      return <p className="px-4 text-sm text-fg-muted md:px-12">{items?.length === 0 || error === "version" ? "" : tc("loading")}</p>;
    }
    if (!diffKey || diff?.key !== diffKey) {
      return <p className="px-4 text-sm text-fg-muted md:px-12">{error === "diff" ? "" : tc("loading")}</p>;
    }
    if (!diff.value) return <p className="px-4 text-sm text-fg-muted md:px-12">{t("diff.oldest")}</p>;
    const range =
      mode === "current"
        ? t("diff.rangeCurrent", { from: savedAt(selected) ?? "" })
        : t("diff.rangePrevious", { from: savedAt(diff.value.fromId) ?? t("diff.earlier"), to: savedAt(selected) ?? "" });
    return <HistoryDiff key={diffKey} diff={diff.value} range={range} />;
  }

  function restore() {
    if (!selected) return;
    setError(null);
    startRestore(async () => {
      try {
        await restoreSnapshotAction(selected);
        onClose();
      } catch {
        setError("restore");
      }
    });
  }

  return (
    <div className="fixed inset-0 z-40 flex bg-black/30" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      {/* Phones: full screen, the version list above the preview. */}
      <div className="flex h-full w-full flex-col-reverse overflow-hidden bg-bg md:m-auto md:h-[80vh] md:max-w-5xl md:flex-row md:rounded-xl md:border md:border-border md:shadow-2xl">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="border-b border-border px-5 pt-3">
            <h2 className="truncate text-sm font-medium">{preview ? pageLabel(preview.title, tc("untitled")) : t("previewTitle")}</h2>
            <div className="-mb-px mt-1 flex gap-4 overflow-x-auto" role="tablist">
              {MODES.map((key) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={mode === key}
                  disabled={!items?.length}
                  onClick={() => setMode(key)}
                  className={cn(
                    "shrink-0 whitespace-nowrap border-b-2 py-2 text-sm disabled:opacity-50",
                    mode === key ? "border-fg font-medium text-fg" : "border-transparent text-fg-muted hover:text-fg",
                  )}
                >
                  {t(`modes.${key}`)}
                </button>
              ))}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto py-4 md:py-6">{renderBody()}</div>
        </div>
        <aside className="flex max-h-[45%] shrink-0 flex-col border-b border-border bg-bg-subtle md:max-h-none md:w-72 md:border-b-0 md:border-l">
          <div className="flex items-center justify-between px-4 py-3">
            <span className="flex items-center gap-2 text-sm font-medium">
              <History className="h-4 w-4" /> {t("title")}
            </span>
            <IconButton label={tc("close")} onClick={onClose}>
              <X className="h-4 w-4" />
            </IconButton>
          </div>
          <div className="flex-1 overflow-y-auto px-2">
            {items === null && <p className="px-2 text-sm text-fg-muted">{tc("loading")}</p>}
            {items?.length === 0 && !error && (
              <p className="px-2 text-sm text-fg-muted">{t("empty")}</p>
            )}
            {items?.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setSelected(s.id)}
                className={cn(
                  "mb-0.5 block w-full rounded-md px-2 py-2 text-left hover:bg-bg-hover",
                  selected === s.id && "bg-bg-active hover:bg-bg-active",
                )}
              >
                <div className="text-sm">{format.dateTime(new Date(s.createdAt), { dateStyle: "medium", timeStyle: "short" })}</div>
                <div className="truncate text-xs text-fg-muted">
                  {describe(s)}
                  {s.authorName ? ` · ${s.authorIsAgent ? tc("agentName", { name: s.authorName }) : s.authorName}` : ""}
                </div>
              </button>
            ))}
          </div>
          <div className="border-t border-border p-3">
            {error && <p className="mb-2 text-xs text-danger">{t(`errors.${error}`)}</p>}
            <Button variant="primary" className="w-full" disabled={!selected || restoring || readOnly} onClick={restore}>
              {restoring ? t("restoring") : t("restore")}
            </Button>
            <p className="mt-2 text-xs text-fg-muted">{t("restoreHint")}</p>
          </div>
        </aside>
      </div>
    </div>
  );
}
