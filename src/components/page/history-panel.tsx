"use client";

import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import { BlockNoteSchema, defaultStyleSpecs } from "@blocknote/core";
import { BlockNoteView } from "@blocknote/mantine";
import { useCreateBlockNote } from "@blocknote/react";
import { BookmarkPlus, History, X } from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { diffSnapshotAction, getSnapshotAction, listSnapshotsAction, restoreSnapshotAction } from "@/app/actions/pages";
import { Button, cn, IconButton, pageLabel, Switch } from "@/components/ui";
import { useColorScheme } from "@/components/theme/theme-provider";
import { useEditorDictionary } from "@/i18n/blocknote";
import { parseDashboardLine } from "@/lib/dashboard";
import { DATABASE_BLOCK, mapReferenceLines } from "@/lib/embed-blocks";
import { relativeTime } from "@/lib/relative-time";
import { isMac, savesVersion } from "@/lib/shortcuts";
import { textScriptStyleSpecs } from "@/lib/text-scripts";
import { BlockDirection } from "./block-direction";
import { HistoryDiff, type VersionDiff } from "./history-diff";
import { VersionNameDialog, type VersionNameTarget } from "./version-name-dialog";

type SnapshotItem = Awaited<ReturnType<typeof listSnapshotsAction>>[number];
/** What the preview shows: the version itself, or its changes against the current page or the version before it. */
type Mode = "version" | "current" | "previous";
const MODES: Mode[] = ["version", "current", "previous"];
const WEEK = 7 * 24 * 3600 * 1000;

/** BlockNote's blocks, with the page's text styles so a version's superscripts show as such. */
const previewSchema = BlockNoteSchema.create({ styleSpecs: { ...defaultStyleSpecs, ...textScriptStyleSpecs } });

function Preview({ markdown }: { markdown: string }) {
  const dictionary = useEditorDictionary();
  const te = useTranslations("page.embed");
  const td = useTranslations("page.dashboard");
  const editor = useCreateBlockNote({ schema: previewSchema, dictionary, extensions: [BlockDirection()] }, [dictionary]);
  // A database block or dashboard is only named here: the version keeps which databases, not their rows back then.
  const text = useMemo(
    () =>
      mapReferenceLines(markdown || "", (ref) => `*${te(ref.type === DATABASE_BLOCK ? "label" : "linkedLabel")}*`)
        .split("\n")
        .map((line) => (parseDashboardLine(line) ? `*${td("title")}*` : line))
        .join("\n"),
    [markdown, te, td],
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
  const colorScheme = useColorScheme();
  return (
    <BlockNoteView
      editor={editor}
      theme={colorScheme}
      editable={false}
      sideMenu={false}
      slashMenu={false}
      formattingToolbar={false}
    />
  );
}

export function HistoryPanel({
  pageId,
  onClose,
  readOnly,
  canName,
}: {
  pageId: string;
  onClose: () => void;
  /** Versions can't be restored (no edit access, a locked page or one in the trash). */
  readOnly: boolean;
  /** Versions can be saved and named (edit access, outside the trash; a locked page too). */
  canName: boolean;
}) {
  const [items, setItems] = useState<SnapshotItem[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // Only named versions (lib/page-versions); the list is loaded again when this or `reload` changes.
  const [namedOnly, setNamedOnly] = useState(false);
  const [reload, setReload] = useState(0);
  // The version to select once the list comes back (one just saved or named).
  const selectNext = useRef<string | null>(null);
  const [naming, setNaming] = useState<VersionNameTarget | null>(null);
  const [preview, setPreview] = useState<{ title: string; markdown: string } | null>(null);
  const [mode, setMode] = useState<Mode>("version");
  // Keyed by version and mode, so a late answer for an earlier choice is not shown.
  const [diff, setDiff] = useState<{ key: string; value: VersionDiff | null } | null>(null);
  const [restoring, startRestore] = useTransition();
  const [error, setError] = useState<"list" | "version" | "diff" | "restore" | null>(null);
  const t = useTranslations("page.history");
  const tc = useTranslations("common");
  const format = useFormatter();
  const locale = useLocale();

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
      case "before_markdown_edit":
        return t("reasons.beforeMarkdownEdit");
      case "before_merge":
        return t("reasons.beforeMerge");
      default:
        return s.reason;
    }
  }

  useEffect(() => {
    let cancelled = false;
    listSnapshotsAction(pageId, namedOnly)
      .then((list) => {
        if (cancelled) return;
        setItems(list);
        const wanted = selectNext.current;
        selectNext.current = null;
        setSelected((current) => {
          const keep = [wanted, current].find((id) => id && list.some((s) => s.id === id));
          return keep ?? list[0]?.id ?? null;
        });
      })
      .catch(() => {
        if (cancelled) return;
        setItems([]);
        setError("list");
      });
    return () => {
      cancelled = true;
    };
  }, [pageId, namedOnly, reload]);

  // Mod+S saves a version here too (the page's own shortcut leaves the key to the open history).
  useEffect(() => {
    if (!canName || naming) return;
    const onKey = (e: KeyboardEvent) => {
      if (!savesVersion(e, isMac())) return;
      e.preventDefault();
      setNaming({ kind: "save", pageId });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canName, naming, pageId]);

  useEffect(() => {
    if (!selected) {
      setPreview(null);
      return;
    }
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

  const selectedItem = selected ? items?.find((s) => s.id === selected) : undefined;
  // A version of the last week reads as "2 hours ago" or "yesterday", an older one as its date
  // written out; the exact time shows on hover.
  const when = (at: Date | string) => {
    const date = new Date(at);
    return Date.now() - date.getTime() < WEEK
      ? relativeTime(date, locale)
      : format.dateTime(date, { dateStyle: "long", timeStyle: "short" });
  };
  const exactly = (at: Date | string) => format.dateTime(new Date(at), { dateStyle: "full", timeStyle: "medium" });
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
    <div data-window-shade className="fixed inset-0 z-40 flex bg-black/30" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
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
        <aside className="flex max-h-[45%] shrink-0 flex-col border-b border-border bg-bg-subtle md:max-h-none md:w-72 md:border-b-0 md:border-s">
          <div className="flex items-center justify-between px-4 py-3">
            <span className="flex items-center gap-2 text-sm font-medium">
              <History className="h-4 w-4" /> {t("title")}
            </span>
            <IconButton label={tc("close")} onClick={onClose}>
              <X className="h-4 w-4" />
            </IconButton>
          </div>
          <div className="space-y-2 px-4 pb-2">
            {canName && (
              <Button size="sm" className="w-full" onClick={() => setNaming({ kind: "save", pageId })}>
                <BookmarkPlus className="h-4 w-4" aria-hidden /> {t("saveVersion")}
              </Button>
            )}
            <label className="flex items-center justify-between gap-2 text-xs text-fg-muted">
              <span>{t("namedOnly")}</span>
              <Switch
                checked={namedOnly}
                label={t("namedOnly")}
                onChange={(on) => {
                  setItems(null);
                  setNamedOnly(on);
                }}
              />
            </label>
          </div>
          <div className="flex-1 overflow-y-auto px-2">
            {items === null && <p className="px-2 text-sm text-fg-muted">{tc("loading")}</p>}
            {items?.length === 0 && !error && (
              <p className="px-2 text-sm text-fg-muted">{namedOnly ? t("emptyNamed") : t("empty")}</p>
            )}
            {items?.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setSelected(s.id)}
                className={cn(
                  "mb-0.5 block w-full rounded-md px-2 py-2 text-start hover:bg-bg-hover",
                  selected === s.id && "bg-bg-active hover:bg-bg-active",
                )}
              >
                <time dateTime={new Date(s.createdAt).toISOString()} title={exactly(s.createdAt)} className="block text-sm">
                  {when(s.createdAt)}
                </time>
                <div className="truncate text-xs text-fg-muted">
                  {s.name ? <span className="font-medium text-fg">{s.name}</span> : describe(s)}
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
            {canName && selectedItem && (
              <Button
                className="mt-2 w-full"
                onClick={() => setNaming({ kind: "rename", versionId: selectedItem.id, name: selectedItem.name, savedAt: selectedItem.createdAt })}
              >
                {selectedItem.name ? t("rename") : t("name")}
              </Button>
            )}
            <p className="mt-2 text-xs text-fg-muted">{t("restoreHint")}</p>
          </div>
        </aside>
      </div>
      {naming && (
        <VersionNameDialog
          target={naming}
          onClose={() => setNaming(null)}
          onDone={(result) => {
            setNaming(null);
            // Selected when the list has it (with Named only on, an unnamed one isn't listed).
            selectNext.current = result.id;
            setReload((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}
