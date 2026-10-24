"use client";

import { Bookmark, Check, Pencil, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { deleteSavedPromptAction, listSavedPromptsAction, renameSavedPromptAction, savePromptAction } from "@/app/actions/ai";
import { cn } from "@/components/ui";
import { MAX_PROMPT_NAME, MAX_SAVED_PROMPTS, suggestPromptName, type SavedPrompt } from "@/lib/ai-saved-prompts";

/**
 * The AI assistant's saved prompts (lib/ai-saved-prompts): the person's own instructions, saved
 * from the instruction field and listed under the menu's actions to run again. Loaded when the
 * menu first opens in a workspace and kept for this tab.
 */

const loaded = new Map<string, SavedPrompt[]>();

/** The saved prompts of the workspace, read once `active` (the assistant is open). */
export function useSavedPrompts(workspaceId: string, active: boolean) {
  const [list, setList] = useState<SavedPrompt[] | null>(() => loaded.get(workspaceId) ?? null);
  const [error, setError] = useState<string | null>(null);
  const keep = useCallback(
    (next: SavedPrompt[]) => {
      loaded.set(workspaceId, next);
      setList(next);
    },
    [workspaceId],
  );
  const wanted = active && list === null;
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    listSavedPromptsAction(workspaceId)
      .then((res) => live && res.ok && keep(res.data))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [workspaceId, wanted, keep]);

  const run = useCallback(async <T,>(action: Promise<{ ok: true; data: T } | { ok: false; error: string }>) => {
    const res = await action.catch(() => null);
    if (!res?.ok) {
      setError(res?.error ?? null);
      return null;
    }
    setError(null);
    return { data: res.data };
  }, []);

  const save = async (name: string, prompt: string) => {
    const res = await run(savePromptAction(workspaceId, { name, prompt }));
    if (res) keep([...(list ?? []), res.data]);
    return Boolean(res);
  };
  const rename = async (id: string, name: string) => {
    const res = await run(renameSavedPromptAction(id, name));
    if (res) keep((list ?? []).map((p) => (p.id === id ? res.data : p)));
    return Boolean(res);
  };
  const remove = async (id: string) => {
    if (await run(deleteSavedPromptAction(id))) keep((list ?? []).filter((p) => p.id !== id));
  };
  return { list, error, save, rename, remove, full: (list?.length ?? 0) >= MAX_SAVED_PROMPTS };
}

export type SavedPrompts = ReturnType<typeof useSavedPrompts>;

const fieldClass = "h-7 min-w-0 flex-1 rounded-md border border-border bg-bg px-2 text-sm outline-none focus:border-accent";

function SmallIconButton({ label, onClick, children, type = "button" }: { label: string; onClick?: () => void; children: React.ReactNode; type?: "button" | "submit" }) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-bg-active hover:text-fg"
    >
      {children}
    </button>
  );
}

/** Naming the instruction in the field before saving it. */
export function SavePromptForm({ prompts, prompt, onDone }: { prompts: SavedPrompts; prompt: string; onDone: () => void }) {
  const t = useTranslations("ai.assistant.saved");
  const [name, setName] = useState(() => suggestPromptName(prompt));
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex items-center gap-1 border-b border-border px-2 py-1.5"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        const ok = await prompts.save(name, prompt);
        setBusy(false);
        if (ok) onDone();
      }}
    >
      <Bookmark className="mx-1 h-3.5 w-3.5 shrink-0 text-fg-muted" aria-hidden />
      <input
        autoFocus
        value={name}
        maxLength={MAX_PROMPT_NAME}
        onChange={(event) => setName(event.target.value)}
        placeholder={t("namePlaceholder")}
        aria-label={t("name")}
        className={fieldClass}
      />
      <button
        type="submit"
        disabled={busy || !name.trim()}
        className="inline-flex h-7 items-center rounded-md bg-accent px-2 text-xs font-medium text-accent-fg hover:opacity-90 disabled:opacity-50"
      >
        {t("save")}
      </button>
      <SmallIconButton label={t("cancel")} onClick={onDone}>
        <X className="h-3.5 w-3.5" />
      </SmallIconButton>
    </form>
  );
}

/** The person's saved prompts, to run, rename or delete; how to save one while there are none. */
export function SavedPromptList({ prompts, workspaceId, onUse }: { prompts: SavedPrompts; workspaceId: string; onUse: (prompt: string) => void }) {
  const t = useTranslations("ai.assistant.saved");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  if (!prompts.list) return null;
  return (
    <div className="border-t border-border p-1">
      <div className="px-2 pt-1 pb-0.5 text-xs text-fg-muted">{t("title")}</div>
      {prompts.list.length === 0 && (
        <p className="px-2 pb-1.5 text-xs text-fg-faint">
          {t.rich("empty", {
            skills: (chunks) => (
              <Link href={`/w/${workspaceId}/skills`} className="text-fg-muted underline underline-offset-2 hover:text-fg">
                {chunks}
              </Link>
            ),
          })}
        </p>
      )}
      <div role="menu" aria-label={t("title")} className="max-h-48 overflow-y-auto">
        {prompts.list.map((saved) =>
          renaming?.id === saved.id ? (
            <form
              key={saved.id}
              className="flex items-center gap-1 px-1 py-0.5"
              onSubmit={async (event) => {
                event.preventDefault();
                if (await prompts.rename(saved.id, renaming.name)) setRenaming(null);
              }}
            >
              <input
                autoFocus
                value={renaming.name}
                maxLength={MAX_PROMPT_NAME}
                aria-label={t("rename")}
                onChange={(event) => setRenaming({ id: saved.id, name: event.target.value })}
                className={fieldClass}
              />
              <SmallIconButton type="submit" label={t("save")}>
                <Check className="h-3.5 w-3.5" />
              </SmallIconButton>
              <SmallIconButton label={t("cancel")} onClick={() => setRenaming(null)}>
                <X className="h-3.5 w-3.5" />
              </SmallIconButton>
            </form>
          ) : (
            <div key={saved.id} className="group flex items-center rounded hover:bg-bg-hover">
              <button
                type="button"
                role="menuitem"
                title={saved.prompt}
                onClick={() => onUse(saved.prompt)}
                className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-start text-sm text-fg"
              >
                <Bookmark className="h-3.5 w-3.5 shrink-0 text-fg-muted" aria-hidden />
                <span className="truncate">{saved.name}</span>
              </button>
              <span className={cn("flex shrink-0 gap-0.5 pe-1 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100")}>
                <SmallIconButton label={t("renameNamed", { name: saved.name })} onClick={() => setRenaming({ id: saved.id, name: saved.name })}>
                  <Pencil className="h-3 w-3" />
                </SmallIconButton>
                <SmallIconButton label={t("deleteNamed", { name: saved.name })} onClick={() => void prompts.remove(saved.id)}>
                  <Trash2 className="h-3 w-3" />
                </SmallIconButton>
              </span>
            </div>
          ),
        )}
      </div>
      {prompts.error && (
        <p role="alert" className="px-2 py-1 text-xs text-danger">
          {prompts.error}
        </p>
      )}
    </div>
  );
}
