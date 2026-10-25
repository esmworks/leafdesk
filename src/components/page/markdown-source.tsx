"use client";

import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import { BlockNoteView } from "@blocknote/mantine";
import { useCreateBlockNote } from "@blocknote/react";
import type { EditorView } from "@codemirror/view";
import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  ListTodo,
  X,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type * as Y from "yjs";
import { readMarkdownSourceAction, saveMarkdownSourceAction, type MarkdownSourceFailure } from "@/app/actions/markdown-source";
import { Button, cn, Dialog, IconButton } from "@/components/ui";
import { useColorScheme } from "@/components/theme/theme-provider";
import { useEditorDictionary } from "@/i18n/blocknote";
import { editorMarkdownToPageBlocks } from "@/lib/editor-markdown";
import { formatBytes } from "@/lib/files";
import { changedSyncedRegions, lineAnchors, previewScrollTop, type MarkdownLoss } from "@/lib/markdown-source";
import type { MentionPerson } from "@/lib/mentions";
import { BlockDirection } from "./block-direction";
import { codeHighlighting } from "./code-block";
import { EmbedHostProvider, type EmbedHost } from "./database-embed";
import { pageEditorSchema } from "./embed-blocks";
import {
  createSourceEditor,
  insertLink,
  schemeCompartment,
  schemeExtension,
  sourceStarts,
  toggleHeading,
  toggleList,
  toggleWrap,
} from "./markdown-source-editor";
import { SyncedFrameProvider, type SyncedFrame } from "./synced-page";

/**
 * A page body as Markdown: the source on one side (CodeMirror), the page it makes on the other
 * (BlockNote, read only, parsed as a save would parse it: lib/page-markdown), saved back to the
 * page while nobody else changed it meanwhile (server/markdown-source.ts). Narrow screens show the
 * two as tabs.
 */

type Source = {
  markdown: string;
  version: string;
  losses: MarkdownLoss[];
  blocks: unknown[];
  people: MentionPerson[];
  /** Synced blocks a save can't write to (server/markdown-source). */
  readOnlySynced: string[];
};

/** How long typing pauses before the preview follows. */
const PREVIEW_DELAY_MS = 150;
/** Narrower than this, the source and the preview are tabs. */
const NARROW_QUERY = "(max-width: 900px)";

type Prompt = { kind: "losses"; losses: MarkdownLoss[]; synced: number } | { kind: "conflict"; version: string } | { kind: "close" };

function useNarrow() {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const query = window.matchMedia(NARROW_QUERY);
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return narrow;
}

/** A block's text as it reads, to find where it starts in the source. */
function blockText(block: { content?: unknown }): string {
  const read = (content: unknown): string => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .map((node: { type?: string; text?: unknown; content?: unknown }) => (typeof node?.text === "string" ? node.text : read(node?.content)))
      .join("");
  };
  return read(block.content);
}

export function MarkdownSourceView({
  workspaceId,
  pageId,
  doc,
  user,
  offline,
  onClose,
}: {
  workspaceId: string;
  pageId: string;
  /** The page's document: the preview's synced blocks show from it, as on the page. */
  doc: Y.Doc;
  user: { id: string; name: string };
  offline: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("page.markdownSource");
  const tu = useTranslations("page.upload");
  const tc = useTranslations("common");
  const scheme = useColorScheme();
  const narrow = useNarrow();
  const [tab, setTab] = useState<"source" | "preview">("source");
  const [source, setSource] = useState<Source | null>(null);
  const [failure, setFailure] = useState<MarkdownSourceFailure | null>(null);
  const [text, setText] = useState("");
  // The Markdown as last read or saved: anything else is unsaved.
  const [baseline, setBaseline] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const dirty = source !== null && text !== baseline;

  // ------------------------------------------------------------------------------------------
  // Reading

  const load = useCallback(async () => {
    setFailure(null);
    const result = await readMarkdownSourceAction(pageId).catch(() => ({ ok: false as const, code: "failed" as const }));
    if (!result.ok) {
      setFailure(result.code);
      return null;
    }
    setSource(result.data);
    setText(result.data.markdown);
    setBaseline(result.data.markdown);
    return result.data;
  }, [pageId]);

  useEffect(() => {
    void load();
  }, [load]);

  // ------------------------------------------------------------------------------------------
  // The source editor

  const editorHost = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const callbacks = useRef({ save: () => {}, scroll: () => {}, upload: async (_file: File): Promise<string | null> => null });

  const upload = useCallback(
    async (file: File) => {
      const res = await fetch(`/api/files?pageId=${encodeURIComponent(pageId)}`, {
        method: "POST",
        body: file,
        headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) },
      }).catch(() => null);
      const data = (await res?.json().catch(() => null)) as { url?: string; code?: string; limit?: number } | null;
      if (res?.ok && data?.url) return data.url;
      const limit = data?.limit ? formatBytes(data.limit) : "";
      const name = file.name || "file";
      setNotice(
        data?.code === "tooLarge"
          ? tu("tooLarge", { name, limit })
          : data?.code === "quotaExceeded"
            ? tu("quotaExceeded", { name, limit })
            : data?.code === "storageFailed"
              ? tu("storageFailed", { name })
              : tu("failed", { name }),
      );
      return null;
    },
    [pageId, tu],
  );

  // Made once the Markdown is read; text set later (a reload) goes in through `replaceText`.
  const ready = source !== null;
  useEffect(() => {
    if (!ready || !editorHost.current || view.current) return;
    view.current = createSourceEditor(editorHost.current, {
      doc: text,
      scheme,
      placeholderText: t("placeholder"),
      onChange: (value) => {
        setText(value);
        setSaved(false);
      },
      onSave: () => callbacks.current.save(),
      onScroll: () => callbacks.current.scroll(),
      upload: (file) => callbacks.current.upload(file),
    });
    view.current.focus();
    // `text` and `scheme` only seed the editor; later changes go in below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, t]);
  useEffect(() => () => view.current?.destroy(), []);
  useEffect(() => {
    view.current?.dispatch({ effects: schemeCompartment.reconfigure(schemeExtension(scheme)) });
  }, [scheme]);

  const replaceText = (markdown: string) => {
    const current = view.current;
    if (current) current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: markdown } });
    setText(markdown);
  };

  const run = (command: (target: EditorView) => boolean) => {
    if (!view.current) return;
    command(view.current);
    view.current.focus();
  };

  // ------------------------------------------------------------------------------------------
  // The preview

  const dictionary = useEditorDictionary();
  const preview = useCreateBlockNote({ schema: pageEditorSchema, dictionary, extensions: [codeHighlighting(), BlockDirection()] }, [dictionary]);
  const previewScroller = useRef<HTMLDivElement>(null);
  // Source lines paired with the preview's offsets of the blocks they start (see lib/markdown-source).
  const anchors = useRef<{ line: number; top: number }[]>([]);
  // Typing at the end of the source keeps the preview at its end.
  const pinToEnd = useRef(false);
  const [rendered, setRendered] = useState(0);

  useEffect(() => {
    if (!source) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const blocks = await editorMarkdownToPageBlocks(preview, text, source.blocks as never[], {
        appUrl: window.location.origin,
        people: source.people,
        pageId,
      }).catch(() => null);
      if (cancelled || !blocks) return;
      preview.replaceBlocks(preview.document, blocks.length ? blocks : [{ type: "paragraph" }]);
      setRendered((n) => n + 1);
    }, PREVIEW_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [preview, text, source, pageId]);

  /** Where each anchored block sits in the preview now. */
  const measure = useCallback(() => {
    const scroller = previewScroller.current;
    const current = view.current;
    if (!scroller || !current) return;
    const blocks = preview.document;
    const pairs = lineAnchors(sourceStarts(current.state), blocks.map(blockText));
    const origin = scroller.getBoundingClientRect().top - scroller.scrollTop;
    anchors.current = pairs.flatMap(({ block, line }) => {
      const element = scroller.querySelector(`[data-node-type="blockOuter"][data-id="${CSS.escape(blocks[block].id)}"]`);
      return element ? [{ line, top: element.getBoundingClientRect().top - origin }] : [];
    });
  }, [preview]);

  /** Scrolls the preview to where the source's top line is (lib/markdown-source previewScrollTop). */
  const follow = useCallback(() => {
    const scroller = previewScroller.current;
    const current = view.current;
    if (!scroller || !current) return;
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const editor = current.scrollDOM;
    const editorMax = editor.scrollHeight - editor.clientHeight;
    let target: number;
    if (editor.scrollTop <= 1) target = 0;
    else if (pinToEnd.current || editor.scrollTop >= editorMax - 2) target = max;
    else if (!anchors.current.length) target = editorMax > 0 ? (editor.scrollTop / editorMax) * max : 0;
    else {
      const top = editor.scrollTop - current.documentPadding.top;
      const block = current.lineBlockAtHeight(Math.max(0, top));
      const line = current.state.doc.lineAt(block.from).number - 1 + Math.min(1, Math.max(0, (top - block.top) / Math.max(1, block.height)));
      target = previewScrollTop(anchors.current, line, { line: current.state.doc.lines, top: scroller.scrollHeight });
    }
    scroller.scrollTop = Math.min(max, Math.max(0, target));
  }, []);

  // After each preview render, and whenever the preview's height changes (images loading, the
  // window resizing): measure again and follow the source.
  useEffect(() => {
    const current = view.current;
    if (current) {
      const { head } = current.state.selection.main;
      pinToEnd.current = current.state.doc.lineAt(head).number >= current.state.doc.lines - 1 && current.hasFocus;
    }
    measure();
    follow();
  }, [rendered, measure, follow]);
  useEffect(() => {
    const scroller = previewScroller.current;
    if (!scroller || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      measure();
      follow();
    });
    observer.observe(scroller.firstElementChild ?? scroller);
    return () => observer.disconnect();
  }, [measure, follow, ready]);

  // ------------------------------------------------------------------------------------------
  // Saving

  const write = useCallback(
    async (markdown: string, version: string) => {
      setSaving(true);
      setNotice(null);
      const result = await saveMarkdownSourceAction(pageId, markdown, version).catch(() => ({ ok: false as const, code: "failed" as const }));
      setSaving(false);
      if (!result.ok) {
        setNotice(t(`errors.${result.code}`));
        return;
      }
      if (result.data.conflict) {
        setPrompt({ kind: "conflict", version: result.data.version });
        return;
      }
      setPrompt(null);
      // Saved: the page is now what the Markdown says, so nothing more is lost by saving it again.
      setSource((s) => (s ? { ...s, version: result.data.version, losses: [] } : s));
      setBaseline(markdown);
      setSaved(true);
    },
    [pageId, t],
  );

  const save = useCallback(() => {
    if (!source || saving || offline || !dirty) return;
    const synced = changedSyncedRegions(source.markdown, text, source.readOnlySynced);
    if (source.losses.length || synced) {
      setPrompt({ kind: "losses", losses: source.losses, synced });
      return;
    }
    void write(text, source.version);
  }, [source, saving, offline, dirty, text, write]);

  const reload = async () => {
    setPrompt(null);
    const fresh = await load();
    if (fresh) replaceText(fresh.markdown);
  };

  const requestClose = useCallback(() => {
    if (dirty) setPrompt({ kind: "close" });
    else onClose();
  }, [dirty, onClose]);

  callbacks.current = { save, scroll: follow, upload };

  // Escape closes (asking first when there are unsaved changes) unless something inside used it
  // (the completion list, a dialog); Mod-S saves from anywhere in the view.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !prompt) {
        event.preventDefault();
        requestClose();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s" && !event.defaultPrevented) {
        event.preventDefault();
        save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prompt, requestClose, save]);

  // Leaving the page with unsaved Markdown asks first, as the browser does.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  // ------------------------------------------------------------------------------------------
  // The preview's surroundings, as the page editor has them (collab-editor.tsx), read only.

  const host = useMemo<EmbedHost>(() => ({ workspaceId, pageId, editable: false, doc }), [workspaceId, pageId, doc]);
  const frame = useMemo<SyncedFrame>(
    () => ({ chain: [pageId], user, offline, inSyncedBlock: false }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the user's fields are what matter
    [pageId, user.id, user.name, offline],
  );

  const status = offline ? t("offline") : saving ? tc("saving") : dirty ? t("unsaved") : saved ? tc("saved") : null;
  const tools: { label: string; icon: ReactNode; command: (target: EditorView) => boolean }[] = [
    { label: t("tools.bold"), icon: <Bold className="h-4 w-4" />, command: toggleWrap("**") },
    { label: t("tools.italic"), icon: <Italic className="h-4 w-4" />, command: toggleWrap("*") },
    { label: t("tools.code"), icon: <Code className="h-4 w-4" />, command: toggleWrap("`") },
    { label: t("tools.link"), icon: <LinkIcon className="h-4 w-4" />, command: insertLink },
    { label: t("tools.heading", { level: 1 }), icon: <Heading1 className="h-4 w-4" />, command: toggleHeading(1) },
    { label: t("tools.heading", { level: 2 }), icon: <Heading2 className="h-4 w-4" />, command: toggleHeading(2) },
    { label: t("tools.heading", { level: 3 }), icon: <Heading3 className="h-4 w-4" />, command: toggleHeading(3) },
    { label: t("tools.bulletList"), icon: <List className="h-4 w-4" />, command: toggleList("bullet") },
    { label: t("tools.numberedList"), icon: <ListOrdered className="h-4 w-4" />, command: toggleList("ordered") },
    { label: t("tools.taskList"), icon: <ListTodo className="h-4 w-4" />, command: toggleList("task") },
  ];

  const showSource = !narrow || tab === "source";
  const showPreview = !narrow || tab === "preview";

  return (
    <div role="dialog" aria-modal="true" aria-label={t("title")} className="fixed inset-0 z-50 flex flex-col bg-bg text-fg" data-markdown-source="">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        {/* On a narrow screen the tabs name what is shown, and the title would push Save away. */}
        <h2 className={cn("min-w-0 truncate text-sm font-semibold", narrow && source && "sr-only")}>{t("title")}</h2>
        {narrow && source && (
          <div role="tablist" className="flex shrink-0 rounded-md border border-border p-0.5 text-xs">
            {(["source", "preview"] as const).map((name) => (
              <button
                key={name}
                type="button"
                role="tab"
                aria-selected={tab === name}
                onClick={() => setTab(name)}
                className={cn("rounded px-2 py-1", tab === name ? "bg-bg-active text-fg" : "text-fg-muted hover:text-fg")}
              >
                {t(name === "source" ? "sourceTab" : "previewTab")}
              </button>
            ))}
          </div>
        )}
        <div className="min-w-0 flex-1 truncate text-end text-xs text-fg-muted" aria-live="polite">
          {status}
        </div>
        <Button size="sm" variant="primary" onClick={save} disabled={!source || !dirty || saving || offline} title={t("saveHint")} className="shrink-0">
          {saving ? tc("saving") : tc("save")}
        </Button>
        <IconButton label={t("close")} onClick={requestClose} className="h-7 w-7 shrink-0">
          <X className="h-4 w-4" />
        </IconButton>
      </header>

      {notice && (
        <p role="alert" className="border-b border-border px-4 py-2 text-sm text-danger">
          {notice}
        </p>
      )}

      {failure ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-fg-muted">
          <p>{t(`errors.${failure}`)}</p>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void load()}>
              {t("retry")}
            </Button>
            <Button size="sm" variant="ghost" onClick={onClose}>
              {t("close")}
            </Button>
          </div>
        </div>
      ) : !source ? (
        <div className="flex flex-1 items-center justify-center text-sm text-fg-muted">{tc("loading")}</div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <section className={cn("min-w-0 flex-1 flex-col border-border", showSource ? "flex" : "hidden", !narrow && "border-e")} aria-label={t("sourceTab")}>
            <div role="toolbar" aria-label={t("toolbar")} className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border px-2 py-1">
              {tools.map((tool) => (
                <IconButton key={tool.label} label={tool.label} onClick={() => run(tool.command)} className="h-7 w-7">
                  {tool.icon}
                </IconButton>
              ))}
            </div>
            <div ref={editorHost} className="min-h-0 flex-1 overflow-hidden" />
          </section>
          <section
            ref={previewScroller}
            className={cn("min-w-0 flex-1 overflow-y-auto", showPreview ? "block" : "hidden")}
            aria-label={t("previewTab")}
            data-markdown-preview=""
          >
            <div className="leafdesk-editor mx-auto max-w-3xl py-6">
              <SyncedFrameProvider value={frame}>
                <EmbedHostProvider value={host}>
                  <BlockNoteView editor={preview} theme={scheme} editable={false} sideMenu={false} slashMenu={false} formattingToolbar={false} />
                </EmbedHostProvider>
              </SyncedFrameProvider>
            </div>
          </section>
        </div>
      )}

      <Dialog open={prompt?.kind === "losses"} onClose={() => setPrompt(null)}>
        {prompt?.kind === "losses" && (
          <div className="p-5">
            <h3 className="text-base font-semibold">{t("losses.title")}</h3>
            <p className="mt-2 text-sm text-fg-muted">{t("losses.body")}</p>
            <ul className="mt-3 list-disc space-y-1 ps-5 text-sm">
              {prompt.losses.map((loss) => (
                <li key={loss}>{t(`losses.kinds.${loss}`)}</li>
              ))}
              {prompt.synced > 0 && <li>{t("losses.synced", { count: prompt.synced })}</li>}
            </ul>
            <div className="mt-5 flex justify-end gap-2">
              <Button onClick={() => setPrompt(null)}>{tc("cancel")}</Button>
              <Button variant="primary" onClick={() => void write(text, source!.version)} disabled={saving}>
                {t("losses.confirm")}
              </Button>
            </div>
          </div>
        )}
      </Dialog>

      <Dialog open={prompt?.kind === "conflict"} onClose={() => setPrompt(null)}>
        {prompt?.kind === "conflict" && (
          <div className="p-5">
            <h3 className="text-base font-semibold">{t("conflict.title")}</h3>
            <p className="mt-2 text-sm text-fg-muted">{t("conflict.body")}</p>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <Button onClick={() => setPrompt(null)}>{tc("cancel")}</Button>
              <Button onClick={() => void reload()}>{t("conflict.reload")}</Button>
              <Button variant="danger" onClick={() => void write(text, prompt.version)} disabled={saving}>
                {t("conflict.overwrite")}
              </Button>
            </div>
          </div>
        )}
      </Dialog>

      <Dialog open={prompt?.kind === "close"} onClose={() => setPrompt(null)}>
        <div className="p-5">
          <h3 className="text-base font-semibold">{t("discard.title")}</h3>
          <p className="mt-2 text-sm text-fg-muted">{t("discard.body")}</p>
          <div className="mt-5 flex justify-end gap-2">
            <Button onClick={() => setPrompt(null)}>{t("discard.keep")}</Button>
            <Button variant="danger" onClick={onClose}>
              {t("discard.confirm")}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
