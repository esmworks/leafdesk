"use client";

import { Check, Pencil, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { mentionCandidatesAction } from "@/app/actions/mentions";
import { Button, cn, Popover } from "@/components/ui";
import { UserAvatar } from "@/components/user-avatar";
import { speakerKeys, speakerNamer, serializeSpeakers, type SpeakerLabels, type SpeakerNames, type TranscriptChunk } from "@/lib/meetings";

/** The words speakers are called by until someone names them, in the reader's language. */
export function useSpeakerLabels(recorderName: string): SpeakerLabels {
  const t = useTranslations("meetings.block.speakers");
  return useMemo(() => ({ you: recorderName.trim() || t("you"), others: t("others"), speaker: (n: number) => t("speaker", { n }) }), [recorderName, t]);
}

/** A function giving each speaker key of the transcript its name (given, or "You", "Others", "Speaker N"). */
export function useSpeakerNames(chunks: TranscriptChunk[], names: SpeakerNames, recorderName: string) {
  const labels = useSpeakerLabels(recorderName);
  return useMemo(() => speakerNamer(chunks, names, labels), [chunks, names, labels]);
}

/**
 * Who spoke in the transcript, a chip each. An editor names one: a workspace member (the name is
 * then theirs everywhere, and action items for them mention them) or any name typed. Naming two
 * speakers alike makes them one in the reader's eyes, which is how a person the provider heard as
 * two is put right.
 */
export function Speakers({
  chunks,
  names,
  nameOf,
  editable,
  pageId,
  onChange,
}: {
  chunks: TranscriptChunk[];
  names: SpeakerNames;
  nameOf: (key: string) => string;
  editable: boolean;
  pageId: string | null;
  onChange: (value: string) => void;
}) {
  const t = useTranslations("meetings.block.speakers");
  const keys = useMemo(() => speakerKeys(chunks), [chunks]);
  if (keys.length === 0) return null;
  const save = (key: string, next: { name: string; id?: string } | null) => {
    const copy = { ...names };
    if (next && next.name.trim()) copy[key] = { name: next.name.trim().slice(0, 100), ...(next.id ? { id: next.id } : {}) };
    else delete copy[key];
    onChange(serializeSpeakers(copy));
  };
  return (
    <div className="mt-4 flex flex-wrap items-center gap-1.5 text-sm">
      <span className="me-1 text-xs font-medium tracking-wide text-fg-muted">{t("label")}</span>
      {keys.map((key) =>
        editable && pageId ? (
          <SpeakerChip key={key} name={nameOf(key)} renamed={Boolean(names[key])} pageId={pageId} onSave={(next) => save(key, next)} />
        ) : (
          <span key={key} className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-xs">
            {nameOf(key)}
          </span>
        ),
      )}
    </div>
  );
}

function SpeakerChip({ name, renamed, pageId, onSave }: { name: string; renamed: boolean; pageId: string; onSave: (next: { name: string; id?: string } | null) => void }) {
  const t = useTranslations("meetings.block.speakers");
  const tb = useTranslations("meetings.block");
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(name);
  const [people, setPeople] = useState<{ id: string; name: string; image: string | null }[] | null>(null);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      mentionCandidatesAction(pageId, text.trim() === name ? "" : text.trim())
        .then((res) => !cancelled && setPeople(res.people))
        .catch(() => !cancelled && setPeople([]));
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, text, pageId, name]);
  const done = (next: { name: string; id?: string } | null) => {
    onSave(next);
    setOpen(false);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setText(name);
      }}
      trigger={({ toggle }) => (
        <button
          type="button"
          onClick={toggle}
          title={t("rename")}
          className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs hover:bg-bg-hover", renamed ? "border-border" : "border-dashed border-border text-fg-muted")}
        >
          {name}
          <Pencil className="h-3 w-3 text-fg-faint" aria-hidden />
        </button>
      )}
      className="w-64"
    >
      <div className="flex items-center gap-2 border-b border-border px-2">
        <Search className="h-3.5 w-3.5 text-fg-muted" aria-hidden />
        <input
          autoFocus
          value={text}
          maxLength={100}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && text.trim()) done({ name: text });
          }}
          placeholder={t("namePlaceholder")}
          aria-label={t("namePlaceholder")}
          className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-faint"
        />
      </div>
      <div className="max-h-48 overflow-y-auto py-1">
        {(people ?? []).map((p) => (
          <button key={p.id} type="button" onClick={() => done({ name: p.name, id: p.id })} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm hover:bg-bg-hover">
            <UserAvatar name={p.name} image={p.image} size="sm" />
            <span className="truncate">{p.name}</span>
          </button>
        ))}
        {people && people.length === 0 && <p className="px-2 py-2 text-sm text-fg-muted">{tb("noPeople")}</p>}
      </div>
      <div className="flex items-center gap-2 border-t border-border p-2">
        <Button size="sm" variant="primary" disabled={!text.trim()} onClick={() => done({ name: text })}>
          <Check className="h-3.5 w-3.5" />
          {t("use")}
        </Button>
        {renamed && (
          <Button size="sm" variant="ghost" onClick={() => done(null)}>
            {t("reset")}
          </Button>
        )}
      </div>
    </Popover>
  );
}
