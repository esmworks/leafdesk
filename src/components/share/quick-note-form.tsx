"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { createQuickNoteAction } from "@/app/actions/pages";
import { Button, buttonClass, Input } from "@/components/ui";

const selectClass = "h-8 w-full rounded-md border border-border bg-bg px-2.5 text-sm outline-none focus:border-accent";
const textareaClass =
  "w-full resize-y rounded-md border border-border bg-bg px-2.5 py-2 text-sm outline-none placeholder:text-fg-faint focus:border-accent";

/** The quick note's fields (see app/share): saved as a private page, then opened. */
export function QuickNoteForm({
  workspaces,
  workspaceId: initialWorkspace,
  title: initialTitle,
  body: initialBody,
}: {
  workspaces: { id: string; name: string }[];
  workspaceId: string;
  title: string;
  body: string;
}) {
  const t = useTranslations("page.quickNote");
  const tc = useTranslations("common");
  const router = useRouter();
  const [workspaceId, setWorkspaceId] = useState(initialWorkspace);
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState(initialBody);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const { id } = await createQuickNoteAction({ workspaceId, title: title.trim(), markdown: body });
      router.push(`/w/${workspaceId}/p/${id}`);
    } catch {
      setError(tc("genericError"));
      setBusy(false);
    }
  };

  return (
    <form
      className="mt-5 space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {workspaces.length > 1 && (
        <label className="block">
          <span className="mb-1 block text-sm font-medium">{t("workspace")}</span>
          <select value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} className={selectClass}>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="block">
        <span className="mb-1 block text-sm font-medium">{t("title")}</span>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={tc("untitled")} autoFocus={!initialTitle} />
      </label>
      <label className="block">
        <span className="mb-1 block text-sm font-medium">{t("body")}</span>
        <textarea
          rows={8}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={t("bodyPlaceholder")}
          className={textareaClass}
        />
      </label>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <a href={`/w/${workspaceId}`} className={buttonClass({ variant: "ghost" })}>
          {tc("cancel")}
        </a>
        <Button type="submit" variant="primary" disabled={busy || (!title.trim() && !body.trim())}>
          {t("save")}
        </Button>
      </div>
    </form>
  );
}
