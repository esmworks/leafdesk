"use client";

/**
 * A database's writing instructions for voice notes (page menu, full access): what the notes saved
 * in it cover and how they are laid out, e.g. a customer visit note. The AI follows them when it
 * writes up a recording saved there (server/voice-notes.ts); everyone recording into it shares them.
 */
import { Mic } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { getVoiceNoteInstructionsAction, setVoiceNoteInstructionsAction } from "@/app/actions/ai";
import { Button, Dialog, DialogBody, DialogFooter, DialogHeader, textareaClass } from "@/components/ui";
import { MAX_VOICE_NOTE_INSTRUCTIONS } from "@/lib/voice-notes";

export function VoiceNoteInstructionsDialog({ databaseId, open, onClose }: { databaseId: string; open: boolean; onClose: () => void }) {
  const t = useTranslations("page.voiceNote.instructions");
  const tc = useTranslations("common");
  /** Null while loading. */
  const [text, setText] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setText(null);
    setError(null);
    getVoiceNoteInstructionsAction(databaseId)
      .then((result) => {
        if (!live) return;
        if (result.ok) setText(result.data);
        else setError(result.error);
      })
      .catch(() => live && setError(tc("genericError")));
    return () => {
      live = false;
    };
  }, [open, databaseId, tc]);

  const save = async () => {
    if (text === null) return;
    setSaving(true);
    setError(null);
    try {
      const result = await setVoiceNoteInstructionsAction(databaseId, text);
      if (!result.ok) setError(result.error);
      else onClose();
    } catch {
      setError(tc("genericError"));
    } finally {
      setSaving(false);
    }
  };

  if (!open || typeof document === "undefined") return null;
  // A portal: the page header's blurred background would otherwise hold the fixed overlay inside it.
  return createPortal(
    <Dialog open onClose={saving ? () => {} : onClose} className="max-w-lg">
      <DialogHeader icon={<Mic className="h-4 w-4" />} title={t("title")} description={t("description")} onClose={onClose} closeLabel={tc("close")} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <DialogBody>
          <textarea
            rows={7}
            value={text ?? ""}
            onChange={(e) => setText(e.target.value)}
            readOnly={text === null}
            maxLength={MAX_VOICE_NOTE_INSTRUCTIONS}
            placeholder={t("placeholder")}
            aria-label={t("title")}
            autoFocus
            className={textareaClass}
          />
          {error && (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <span className="me-auto text-xs tabular-nums text-fg-faint">
            {(text ?? "").length} / {MAX_VOICE_NOTE_INSTRUCTIONS}
          </span>
          <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
            {tc("cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={saving || text === null}>
            {saving ? tc("saving") : tc("save")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>,
    document.body,
  );
}
