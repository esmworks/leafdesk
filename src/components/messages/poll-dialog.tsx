"use client";

import { Plus, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { Button, Dialog, DialogBody, DialogFooter, DialogHeader, IconButton, Input, selectClass, Switch } from "@/components/ui";
import { POLL_LIMITS, pollInputError, type PollInputError } from "@/lib/message-polls";
import { MessagesError, sendPoll } from "./store";

type Closes = "never" | "day" | "week" | "at";

const DAY_MS = 24 * 60 * 60_000;

/** The value of a `datetime-local` field for a time, in the browser's zone. */
function localInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Writes a poll and sends it where the composer is (a channel, a direct conversation or a
 * thread): a question, two to ten options, whether several may be chosen, whether it is
 * anonymous and when it closes. Loaded the first time it opens (a `lazyPart` of the composer).
 */
export function PollDialog({
  channelId,
  threadId,
  alsoInChannel,
  close,
  onSent,
}: {
  channelId: string;
  threadId: string | null;
  alsoInChannel: boolean;
  close: () => void;
  onSent?: () => void;
}) {
  const t = useTranslations("messages");
  const common = useTranslations("common");
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState<{ key: string; text: string }[]>(() => [
    { key: crypto.randomUUID(), text: "" },
    { key: crypto.randomUUID(), text: "" },
  ]);
  const [multiple, setMultiple] = useState(false);
  const [anonymous, setAnonymous] = useState(false);
  const [closes, setCloses] = useState<Closes>("never");
  const [at, setAt] = useState(() => localInput(new Date(Date.now() + DAY_MS)));
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);

  const closesAt = (): Date | null => {
    if (closes === "day") return new Date(Date.now() + DAY_MS);
    if (closes === "week") return new Date(Date.now() + 7 * DAY_MS);
    if (closes === "at") return new Date(at);
    return null;
  };
  const texts = options.map((o) => o.text);
  const problem = pollInputError({ question, options: texts, closesAt: closesAt() });
  const errorWords = (error: PollInputError) =>
    error === "questionTooLong" ? t("poll.errors.questionTooLong", { max: POLL_LIMITS.question })
    : error === "optionTooLong" ? t("poll.errors.optionTooLong", { max: POLL_LIMITS.option })
    : error === "tooManyOptions" ? t("poll.errors.tooManyOptions", { max: POLL_LIMITS.maxOptions })
    : t(`poll.errors.${error}`);

  const addOption = () => {
    if (options.length >= POLL_LIMITS.maxOptions) return;
    setOptions([...options, { key: crypto.randomUUID(), text: "" }]);
    requestAnimationFrame(() => [...(list.current?.querySelectorAll("input") ?? [])].at(-1)?.focus());
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (problem || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await sendPoll({ channelId, threadId, alsoInChannel, poll: { question, options: texts, multiple, anonymous, closesAt: closesAt()?.toISOString() ?? null } });
      close();
      onSent?.();
    } catch (error) {
      setFailure(t(`errors.${error instanceof MessagesError ? (error.code as "internal") : "internal"}`));
    } finally {
      setBusy(false);
    }
  };

  const label = "mb-1.5 block text-[13px] font-medium text-fg";
  return (
    <Dialog open onClose={close}>
      <form onSubmit={submit}>
        <DialogHeader title={t("poll.title")} onClose={close} closeLabel={common("close")} />
        <DialogBody className="max-h-[70vh] space-y-4 overflow-y-auto">
          <label className="block">
            <span className={label}>{t("poll.question")}</span>
            <Input autoFocus value={question} maxLength={POLL_LIMITS.question} onChange={(e) => setQuestion(e.target.value)} placeholder={t("poll.questionPlaceholder")} />
          </label>
          <div>
            <p className={label}>{t("poll.options")}</p>
            <div ref={list} className="flex flex-col gap-1.5">
              {options.map((o, i) => (
                <div key={o.key} className="flex items-center gap-1">
                  <Input
                    value={o.text}
                    maxLength={POLL_LIMITS.option}
                    aria-label={t("poll.optionPlaceholder", { number: i + 1 })}
                    placeholder={t("poll.optionPlaceholder", { number: i + 1 })}
                    onChange={(e) => setOptions(options.map((x) => (x.key === o.key ? { ...x, text: e.target.value } : x)))}
                    onKeyDown={(e) => {
                      // Enter on the last option makes the next one, as long as there is room.
                      if (e.key === "Enter" && !e.nativeEvent.isComposing && i === options.length - 1 && o.text.trim() && options.length < POLL_LIMITS.maxOptions) {
                        e.preventDefault();
                        addOption();
                      }
                    }}
                  />
                  {options.length > POLL_LIMITS.minOptions && (
                    <IconButton label={t("poll.removeOption", { number: i + 1 })} onClick={() => setOptions(options.filter((x) => x.key !== o.key))} className="h-8 w-8 text-fg-faint hover:text-danger">
                      <X className="h-4 w-4" />
                    </IconButton>
                  )}
                </div>
              ))}
            </div>
            {options.length < POLL_LIMITS.maxOptions && (
              <Button type="button" variant="ghost" onClick={addOption} className="mt-1.5 -ms-2">
                <Plus className="h-4 w-4" />
                {t("poll.addOption")}
              </Button>
            )}
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm text-fg">{t("poll.multiple")}</span>
            <Switch checked={multiple} onChange={setMultiple} label={t("poll.multiple")} />
          </div>
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm text-fg">{t("poll.anonymous")}</p>
              <p className="text-[13px] text-fg-muted">{t("poll.anonymousHint")}</p>
            </div>
            <Switch checked={anonymous} onChange={setAnonymous} label={t("poll.anonymous")} />
          </div>
          <div>
            <label className={label} htmlFor="poll-closes">
              {t("poll.closes")}
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <select id="poll-closes" value={closes} onChange={(e) => setCloses(e.target.value as Closes)} className={selectClass}>
                <option value="never">{t("poll.closesNever")}</option>
                <option value="day">{t("poll.closesDay")}</option>
                <option value="week">{t("poll.closesWeek")}</option>
                <option value="at">{t("poll.closesAt")}</option>
              </select>
              {closes === "at" && (
                <Input type="datetime-local" value={at} min={localInput(new Date())} onChange={(e) => setAt(e.target.value)} aria-label={t("poll.closesAtLabel")} className="w-auto" />
              )}
            </div>
          </div>
          {((tried && problem) || failure) && <p className="text-sm text-danger">{failure ?? errorWords(problem!)}</p>}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={close}>
            {common("cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !question.trim()}>
            {t("poll.send")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
