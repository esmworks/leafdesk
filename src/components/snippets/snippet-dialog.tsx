"use client";

import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";
import { createSnippetAction, updateSnippetAction } from "@/app/actions/snippets";
import { useAction } from "@/components/settings/workspace-settings";
import { Button, Dialog, Input, selectClass, textareaClass } from "@/components/ui";
import {
  MAX_SNIPPET_BODY,
  MAX_SNIPPET_TITLE,
  MAX_SNIPPET_TRIGGER,
  SNIPPET_PLACEHOLDERS,
  SNIPPET_TRIGGER_CHARACTER,
  cleanTrigger,
  triggerFromTitle,
  type SnippetView,
} from "@/lib/snippets";

const SnippetPreview = dynamic(() => import("./snippet-preview"), { ssr: false });

/** Where a new snippet may go: the person's own snippets, a workspace's (they own), or both to choose from. */
export type SnippetTargets = { personal: boolean; workspace: { id: string; name: string } | null };

/**
 * The snippet form: title, trigger (made from the title until typed), where it goes (for a new one
 * the person may also add to the workspace) and its Markdown, with the blocks it makes beside it.
 * `snippet` is the one being changed; `body` starts a new one with content (the block menu).
 */
export function SnippetDialog({
  snippet,
  body,
  targets,
  defaultTarget = "personal",
  me,
  onSaved,
  onClose,
}: {
  snippet?: SnippetView;
  body?: string;
  targets: SnippetTargets;
  defaultTarget?: "personal" | "workspace";
  /** The person's name, for the preview's {{me}}. */
  me: string;
  onSaved: (saved: SnippetView) => void;
  onClose: () => void;
}) {
  const t = useTranslations("snippets.form");
  const tc = useTranslations("common");
  const id = useId();
  const [title, setTitle] = useState(snippet?.title ?? "");
  const [trigger, setTrigger] = useState(snippet?.trigger ?? "");
  // Until the trigger is typed, it follows the title.
  const [triggerTyped, setTriggerTyped] = useState(Boolean(snippet));
  const [markdown, setMarkdown] = useState(snippet?.body ?? body ?? "");
  const [target, setTarget] = useState<"personal" | "workspace">(
    targets.workspace && (defaultTarget === "workspace" || !targets.personal) ? "workspace" : "personal",
  );
  const textarea = useRef<HTMLTextAreaElement>(null);
  const { pending, error, run } = useAction();
  const shownTrigger = triggerTyped ? trigger : triggerFromTitle(title);

  const insertPlaceholder = (name: string) => {
    const el = textarea.current;
    const text = `{{${name}}}`;
    if (!el) return setMarkdown((m) => m + text);
    const start = el.selectionStart ?? markdown.length;
    const end = el.selectionEnd ?? start;
    const next = markdown.slice(0, start) + text + markdown.slice(end);
    setMarkdown(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + text.length, start + text.length);
    });
  };

  const submit = () => {
    const value = { trigger: shownTrigger, title, body: markdown };
    if (snippet) run(() => updateSnippetAction(snippet.id, value), onSaved);
    else run(() => createSnippetAction(target === "workspace" && targets.workspace ? targets.workspace.id : null, value), onSaved);
  };

  return (
    <Dialog open onClose={onClose} className="max-w-4xl">
      <form
        className="flex max-h-[80vh] flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <h2 className="border-b border-border px-5 py-3.5 text-base font-semibold">{snippet ? t("editTitle") : t("newTitle")}</h2>
        <div className="grid min-h-0 flex-1 gap-5 overflow-y-auto p-5 md:grid-cols-2">
          <div className="space-y-3">
            <label className="block space-y-1.5">
              <span className="text-sm text-fg-muted">{t("title")}</span>
              <Input
                autoFocus
                value={title}
                maxLength={MAX_SNIPPET_TITLE}
                placeholder={t("titlePlaceholder")}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <div className="space-y-1.5">
              <label htmlFor={`${id}-trigger`} className="block text-sm text-fg-muted">
                {t("trigger")}
              </label>
              <div className="flex items-center rounded-md border border-border bg-bg focus-within:border-accent">
                <span className="ps-2.5 text-sm text-fg-faint" aria-hidden>
                  {SNIPPET_TRIGGER_CHARACTER}
                </span>
                <input
                  id={`${id}-trigger`}
                  value={shownTrigger}
                  maxLength={MAX_SNIPPET_TRIGGER}
                  spellCheck={false}
                  autoCapitalize="off"
                  placeholder={t("triggerPlaceholder")}
                  onChange={(e) => {
                    setTriggerTyped(true);
                    setTrigger(cleanTrigger(e.target.value));
                  }}
                  className="h-8 min-w-0 flex-1 bg-transparent pe-2.5 ps-0.5 text-sm outline-none placeholder:text-fg-faint"
                />
              </div>
              <p className="text-xs text-fg-muted">{t("triggerHint", { trigger: shownTrigger || t("triggerPlaceholder") })}</p>
            </div>
            {!snippet && targets.personal && targets.workspace && (
              <label className="block space-y-1.5">
                <span className="text-sm text-fg-muted">{t("target")}</span>
                <select className={`${selectClass} w-full`} value={target} onChange={(e) => setTarget(e.target.value as "personal" | "workspace")}>
                  <option value="personal">{t("targetPersonal")}</option>
                  <option value="workspace">{t("targetWorkspace", { workspace: targets.workspace.name })}</option>
                </select>
              </label>
            )}
            <div className="space-y-1.5">
              <label htmlFor={`${id}-body`} className="block text-sm text-fg-muted">
                {t("body")}
              </label>
              <textarea
                id={`${id}-body`}
                ref={textarea}
                value={markdown}
                maxLength={MAX_SNIPPET_BODY}
                rows={12}
                spellCheck={false}
                onChange={(e) => setMarkdown(e.target.value)}
                placeholder={t("bodyPlaceholder")}
                className={`${textareaClass} min-h-48 font-mono text-[13px] leading-relaxed`}
              />
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
                <span>{t("placeholders")}</span>
                {SNIPPET_PLACEHOLDERS.map((name) => (
                  <button
                    key={name}
                    type="button"
                    title={t(`placeholder.${name}`)}
                    onClick={() => insertPlaceholder(name)}
                    className="rounded border border-border bg-bg-subtle px-1.5 py-0.5 text-fg hover:bg-bg-hover"
                  >
                    {`{{${name}}}`}
                  </button>
                ))}
              </div>
              <p className="text-xs text-fg-faint">
                {t("length", { count: markdown.length, max: MAX_SNIPPET_BODY })}
              </p>
            </div>
          </div>
          <div className="flex min-h-48 flex-col space-y-1.5">
            <span className="text-sm text-fg-muted">{t("preview")}</span>
            <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border py-2">
              {markdown.trim() ? (
                <SnippetPreview markdown={markdown} me={me} page={t("previewPage")} />
              ) : (
                <p className="px-4 py-6 text-center text-sm text-fg-faint">{t("previewEmpty")}</p>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          {error && <p className="me-auto text-xs text-danger">{error}</p>}
          <Button variant="ghost" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={pending || !markdown.trim() || !shownTrigger}>
            {pending ? tc("saving") : snippet ? tc("save") : t("create")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
