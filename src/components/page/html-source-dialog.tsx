"use client";

import { Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { writeHtmlBlockAction } from "@/app/actions/ai";
import { Button, cn, Dialog, DialogBody, DialogFooter, DialogHeader, Input, selectClass, textareaClass } from "@/components/ui";
import { cleanHtmlHeight, cleanHtmlSource, cleanHtmlTitle, MAX_HTML_HEIGHT, MAX_HTML_SOURCE, MAX_HTML_TITLE, MIN_HTML_HEIGHT } from "@/lib/html-block";
import type { PageEditor } from "./embed-blocks";
import { HtmlFrame } from "./html-frame";

/**
 * An HTML block's source (lib/html-block.ts) for people who may edit the page: its title, height
 * and HTML next to a live preview in the same sandboxed frame, and "Make with AI", which has the
 * model write or change the HTML from a description (server/html-block-ai.ts). Applying writes
 * the block's props, so the change syncs, undoes and versions with the page.
 */
export default function HtmlSourceDialog({
  editor,
  blockId,
  pageId,
  ai,
  focusAi,
  onClose,
}: {
  editor: PageEditor;
  blockId: string;
  pageId: string;
  ai: boolean;
  focusAi: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("page.htmlBlock");
  const tc = useTranslations("common");
  const [initial] = useState(() => {
    const props = (editor.getBlock(blockId)?.props ?? {}) as { source?: unknown; title?: unknown; height?: unknown };
    return { source: cleanHtmlSource(props.source), title: cleanHtmlTitle(props.title), height: cleanHtmlHeight(props.height) };
  });
  const [source, setSource] = useState(initial.source);
  const [title, setTitle] = useState(initial.title);
  const [height, setHeight] = useState(initial.height);
  // What the preview runs: the source a moment after typing stops.
  const [previewed, setPreviewed] = useState(initial.source);
  useEffect(() => {
    const timer = setTimeout(() => setPreviewed(source), 400);
    return () => clearTimeout(timer);
  }, [source]);
  const [instruction, setInstruction] = useState("");
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const aiField = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focusAi) aiField.current?.focus();
  }, [focusAi]);

  const write = async () => {
    if (writing || !instruction.trim()) return;
    setWriting(true);
    setError(null);
    try {
      const res = await writeHtmlBlockAction(pageId, source, instruction);
      if (res.ok) {
        setSource(cleanHtmlSource(res.data));
        setPreviewed(cleanHtmlSource(res.data));
        setInstruction("");
      } else {
        setError(res.error);
      }
    } catch {
      setError(t("editor.aiFailed"));
    } finally {
      setWriting(false);
    }
  };
  const apply = () => {
    if (editor.getBlock(blockId)) editor.updateBlock(blockId, { props: { source: cleanHtmlSource(source), title: cleanHtmlTitle(title), height: cleanHtmlHeight(height) } });
    onClose();
  };

  return (
    <Dialog open onClose={onClose} className="max-w-5xl">
      <DialogHeader title={t("editor.title")} onClose={onClose} closeLabel={tc("close")} />
      <DialogBody className="max-h-[70vh] overflow-y-auto">
        {ai && (
          <div className="space-y-1.5">
            <label htmlFor="html-block-ai" className="text-sm font-medium">
              {t("makeWithAi")}
            </label>
            <div className="flex items-start gap-2">
              <textarea
                id="html-block-ai"
                ref={aiField}
                rows={2}
                value={instruction}
                maxLength={2000}
                disabled={writing}
                placeholder={t("editor.aiPlaceholder")}
                onChange={(e) => setInstruction(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void write();
                  }
                }}
                className={cn(textareaClass, "min-w-0 flex-1")}
              />
              <Button disabled={writing || !instruction.trim()} onClick={() => void write()} className="h-9 shrink-0">
                <Sparkles className="h-3.5 w-3.5" aria-hidden />
                {writing ? t("editor.aiWorking") : source.trim() ? t("editor.aiChange") : t("editor.aiWrite")}
              </Button>
            </div>
            {error && (
              <p role="alert" className="text-xs text-danger">
                {error}
              </p>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-48 flex-1 space-y-1 text-sm font-medium">
            {t("editor.titleField")}
            <Input value={title} maxLength={MAX_HTML_TITLE} onChange={(e) => setTitle(e.target.value)} className="font-normal" />
          </label>
          <label className="space-y-1 text-sm font-medium">
            {t("editor.heightField")}
            <span className="flex items-center gap-2">
              <select
                value={height ? "fixed" : "auto"}
                onChange={(e) => setHeight(e.target.value === "fixed" ? 300 : 0)}
                className={cn(selectClass, "font-normal")}
              >
                <option value="auto">{t("editor.heightAuto")}</option>
                <option value="fixed">{t("editor.heightFixed")}</option>
              </select>
              {height > 0 && (
                <Input
                  type="number"
                  min={MIN_HTML_HEIGHT}
                  max={MAX_HTML_HEIGHT}
                  value={height}
                  aria-label={t("editor.heightPixels")}
                  onChange={(e) => setHeight(Math.max(1, Number(e.target.value) || 0))}
                  onBlur={() => setHeight(cleanHtmlHeight(height))}
                  className="w-24 font-normal"
                />
              )}
            </span>
          </label>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="min-w-0 space-y-1">
            <label htmlFor="html-block-source" className="text-sm font-medium">
              {t("editor.sourceField")}
            </label>
            <textarea
              id="html-block-source"
              value={source}
              rows={16}
              maxLength={MAX_HTML_SOURCE}
              spellCheck={false}
              autoFocus={!focusAi}
              onChange={(e) => setSource(e.target.value)}
              className={cn(textareaClass, "block h-72 font-mono text-xs leading-5 whitespace-pre")}
            />
            <p className="text-xs text-fg-faint">{t("editor.sourceHelp")}</p>
          </div>
          <div className="min-w-0 space-y-1">
            <div className="text-sm font-medium">{t("editor.previewField")}</div>
            <div className="h-72 overflow-auto rounded-md border border-border">
              {previewed.trim() ? (
                <HtmlFrame source={previewed} title={title} height={height} label={t("label")} className="block w-full border-0" />
              ) : (
                <p className="p-3 text-sm text-fg-faint">{t("editor.previewEmpty")}</p>
              )}
            </div>
          </div>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>
          {tc("cancel")}
        </Button>
        <Button variant="primary" onClick={apply}>
          {t("editor.apply")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
