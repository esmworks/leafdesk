"use client";

/**
 * What the AI chat remembers about the person in this workspace (server/ai-memory.ts): its notes,
 * each changed in place or deleted, a note to add, and forgetting everything. Only the person sees
 * them; they go with each of their questions in the workspace while their "Use memory" switch is on.
 * Not shown when the workspace has the memory off.
 */
import { Brain, Check, Loader2, Pencil, Trash2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { addMemoryAction, deleteMemoryAction, listMemoriesAction, memoryUseAction, setMemoryUseAction, updateMemoryAction } from "@/app/actions/ai";
import { useIsOffline } from "@/components/offline/offline-context";
import { Button, Dialog, IconButton, Input, Switch } from "@/components/ui";
import { MAX_MEMORIES, MAX_MEMORY_CHARS, type MemoryView } from "@/lib/ai-chat";

/** The button that opens the Memory dialog (in the chat's headers). */
export function MemoryButton({ workspaceId, className }: { workspaceId: string; className?: string }) {
  const t = useTranslations("ai.memory");
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconButton label={t("open")} className={className} onClick={() => setOpen(true)}>
        <Brain className="h-4 w-4" />
      </IconButton>
      <MemoryDialog workspaceId={workspaceId} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

export function MemoryDialog({ workspaceId, open, onClose }: { workspaceId: string; open: boolean; onClose: () => void }) {
  const t = useTranslations("ai.memory");
  const offline = useIsOffline();
  const [notes, setNotes] = useState<MemoryView[] | null>(null);
  /** The person's "Use memory" switch; null until loaded. */
  const [use, setUse] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await listMemoriesAction(workspaceId);
    if (result.ok) setNotes(result.data);
    else setError(result.error);
  }, [workspaceId]);

  useEffect(() => {
    if (!open || offline) return;
    setError(null);
    setEditing(null);
    void load();
    void memoryUseAction(workspaceId).then((result) => {
      if (result.ok) setUse(result.data);
    });
  }, [open, offline, load, workspaceId]);

  async function toggleUse(next: boolean) {
    setUse(next);
    setBusy(true);
    const result = await setMemoryUseAction(workspaceId, next);
    setBusy(false);
    setError(result.ok ? null : result.error);
    if (!result.ok) setUse(!next);
  }

  /** Runs a change, then shows the notes as the server has them. */
  async function change(fn: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setBusy(true);
    const result = await fn();
    setBusy(false);
    setError(result.ok ? null : result.error);
    if (result.ok) await load();
    return result.ok;
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim() || busy) return;
    if (await change(() => addMemoryAction(workspaceId, draft))) setDraft("");
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editing || busy) return;
    const { id, text } = editing;
    if (await change(() => updateMemoryAction(workspaceId, id, text))) setEditing(null);
  }

  async function forgetAll() {
    if (!confirm(t("confirmForgetAll"))) return;
    await change(() => deleteMemoryAction(workspaceId, "all"));
  }

  const full = (notes?.length ?? 0) >= MAX_MEMORIES;
  return (
    <Dialog open={open} onClose={onClose} className="max-w-lg">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <h2 className="flex-1 text-sm font-medium">{t("title")}</h2>
        <IconButton label={t("close")} className="h-7 w-7" onClick={onClose}>
          <X className="h-4 w-4" />
        </IconButton>
      </div>
      <div className="max-h-[60vh] overflow-y-auto px-4 py-3 text-sm">
        <p className="text-fg-muted">{t("intro")}</p>
        {!offline && use !== null && (
          <div className="mt-3 flex items-start gap-3 rounded-md border border-border px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="font-medium">{t("use")}</p>
              <p className="text-xs text-fg-muted">{t("useHint")}</p>
            </div>
            <Switch checked={use} label={t("use")} disabled={busy} onChange={(next) => void toggleUse(next)} />
          </div>
        )}
        {error && (
          <p role="alert" className="mt-2 text-xs text-danger">
            {error}
          </p>
        )}
        {offline ? (
          <p className="mt-3 text-fg-muted">{t("offline")}</p>
        ) : notes === null ? (
          !error && <Loader2 className="mt-3 h-4 w-4 animate-spin text-fg-muted" aria-hidden />
        ) : notes.length === 0 ? (
          <p className="mt-3 text-fg-muted">{t("empty")}</p>
        ) : (
          <ul aria-label={t("title")} className="mt-3 divide-y divide-border border-y border-border">
            {notes.map((note) =>
              editing?.id === note.id ? (
                <li key={note.id} className="py-1.5">
                  <form onSubmit={save} className="flex items-center gap-1">
                    <Input
                      autoFocus
                      aria-label={t("editLabel")}
                      value={editing.text}
                      maxLength={MAX_MEMORY_CHARS}
                      onChange={(e) => setEditing({ id: note.id, text: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key !== "Escape") return;
                        // Escape cancels the edit, not the dialog.
                        e.stopPropagation();
                        setEditing(null);
                      }}
                    />
                    <IconButton type="submit" label={t("save")} className="h-8 w-8" disabled={busy || !editing.text.trim()}>
                      <Check className="h-4 w-4" />
                    </IconButton>
                    <IconButton label={t("cancel")} className="h-8 w-8" onClick={() => setEditing(null)}>
                      <X className="h-4 w-4" />
                    </IconButton>
                  </form>
                </li>
              ) : (
                <li key={note.id} className="group/note flex items-start gap-1 py-1.5">
                  <p className="min-w-0 flex-1 py-1 break-words">{note.text}</p>
                  <IconButton
                    label={t("edit")}
                    className="h-7 w-7 opacity-0 group-hover/note:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-60"
                    disabled={busy}
                    onClick={() => setEditing({ id: note.id, text: note.text })}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </IconButton>
                  <IconButton
                    label={t("delete")}
                    className="h-7 w-7 opacity-0 group-hover/note:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-60"
                    disabled={busy}
                    onClick={() => void change(() => deleteMemoryAction(workspaceId, note.id))}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </IconButton>
                </li>
              ),
            )}
          </ul>
        )}
      </div>
      {!offline && notes !== null && (
        <div className="space-y-2 border-t border-border px-4 py-3">
          <form onSubmit={add} className="flex gap-2">
            <Input
              aria-label={t("addLabel")}
              placeholder={full ? t("full", { max: MAX_MEMORIES }) : t("addPlaceholder")}
              value={draft}
              maxLength={MAX_MEMORY_CHARS}
              disabled={full}
              onChange={(e) => setDraft(e.target.value)}
            />
            <Button type="submit" variant="primary" disabled={busy || full || !draft.trim()}>
              {t("add")}
            </Button>
          </form>
          <div className="flex items-center justify-between gap-2 text-xs text-fg-muted">
            <span>{t("count", { count: notes.length, max: MAX_MEMORIES })}</span>
            {notes.length > 0 && (
              <Button size="sm" variant="ghost" className="hover:text-danger" disabled={busy} onClick={() => void forgetAll()}>
                {t("forgetAll")}
              </Button>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
