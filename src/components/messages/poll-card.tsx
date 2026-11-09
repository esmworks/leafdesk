"use client";

import { Circle, CircleCheck, Square, SquareCheck } from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { useState } from "react";
import { showToast } from "@/components/toast";
import { cn, Popover } from "@/components/ui";
import { pollClosed, pollShare, withVote } from "@/lib/message-polls";
import type { MessageView, PollView } from "@/lib/message-wire";
import { PersonFace } from "./person";
import { call, MessagesError, messagesState, patchMessage, personName, useView } from "./store";

/**
 * A poll in a message: its question, each option as a row with its share drawn as a bar, the
 * count and percentage, how many voted and when it closes. A click on an option chooses it (or
 * takes the choice back); the count opens who chose it, unless the poll is anonymous. Loaded
 * with the first poll a list shows (a `lazyPart` of message-item.tsx).
 */
export function PollCard({ m, poll, votes }: { m: MessageView; poll: PollView; votes: boolean }) {
  const t = useTranslations("messages");
  const format = useFormatter();
  const s = useView();
  // Ticks every minute, so a poll past its time says so without a reload.
  const now = useNow({ updateInterval: 60_000 });
  const closed = pollClosed(poll, now.getTime());
  const [votersAt, setVotersAt] = useState<Element | null>(null);
  const can = votes && !closed;

  const vote = (optionId: string, on: boolean) => {
    // Shown at once; the server's change follows, or the poll goes back as it was.
    patchMessage(m.id, { poll: withVote(poll, s.me, optionId, on) });
    void call("votePoll", { messageId: m.id, optionId, on }).catch((error) => {
      // Back as it was, unless the server's word on it came meanwhile.
      if (messagesState().messages.get(m.id)?.rev === m.rev) patchMessage(m.id, { poll });
      showToast({ message: t(`errors.${error instanceof MessagesError ? (error.code as "internal") : "internal"}`) });
    });
  };

  const mark = (chosen: boolean) => {
    const className = cn("h-4 w-4 shrink-0", chosen ? "text-accent" : "text-fg-faint");
    if (poll.multiple) return chosen ? <SquareCheck aria-hidden className={className} /> : <Square aria-hidden className={className} />;
    return chosen ? <CircleCheck aria-hidden className={className} /> : <Circle aria-hidden className={className} />;
  };

  return (
    <div className="mt-1 w-full max-w-md rounded-lg border border-border p-3">
      <p className="text-sm font-medium break-words whitespace-pre-wrap text-fg">{poll.question}</p>
      {(poll.multiple || poll.anonymous) && (
        <p className="mt-0.5 text-xs text-fg-faint">{[poll.multiple && t("poll.severalAnswers"), poll.anonymous && t("poll.anonymous")].filter(Boolean).join(" · ")}</p>
      )}
      <div role="group" aria-label={poll.question} className="mt-2 flex flex-col gap-1">
        {poll.options.map((o) => {
          const chosen = poll.mine.includes(o.id);
          const share = pollShare(o.count, poll.voters);
          const names = o.voters?.map((id) => personName(s, id, t("someone"))).join(", ") ?? "";
          return (
            <div key={o.id} className="relative flex min-h-9 items-stretch overflow-hidden rounded-md">
              <span aria-hidden className={cn("absolute inset-y-0 start-0 transition-[width]", chosen ? "bg-accent/20" : "bg-bg-active")} style={{ width: `${share}%` }} />
              <button
                type="button"
                disabled={!can}
                aria-pressed={chosen}
                onClick={() => vote(o.id, !chosen)}
                title={can ? (chosen ? t("poll.takeBack", { option: o.text }) : t("poll.voteFor", { option: o.text })) : undefined}
                className={cn("relative flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm text-fg", can ? "hover:bg-bg-hover" : "cursor-default")}
              >
                {mark(chosen)}
                <span className="min-w-0 flex-1 break-words">{o.text}</span>
                <span className="shrink-0 text-xs text-fg-faint tabular-nums">{share}%</span>
              </button>
              {o.voters && o.count > 0 ? (
                <Popover
                  align="end"
                  at={votersAt}
                  wrapperClassName="relative flex"
                  trigger={({ toggle }) => (
                    <button
                      type="button"
                      onClick={(e) => {
                        setVotersAt(e.currentTarget);
                        toggle();
                      }}
                      title={t("poll.votedBy", { option: o.text, people: names })}
                      aria-label={t("poll.votedBy", { option: o.text, people: names })}
                      className="flex min-w-9 items-center justify-center gap-1 rounded-md px-2 text-xs text-fg-muted tabular-nums hover:bg-bg-hover hover:text-fg"
                    >
                      {o.count}
                    </button>
                  )}
                  className="w-64 p-1"
                >
                  <p className="px-2 py-1 text-xs font-medium text-fg-faint">{o.text}</p>
                  <ul className="max-h-60 overflow-y-auto">
                    {o.voters.map((id) => (
                      <li key={id} className="flex items-center gap-2 px-2 py-1 text-sm text-fg">
                        <PersonFace s={s} userId={id} size="xs" presence={false} />
                        <span className="truncate">{personName(s, id, t("someone"))}</span>
                      </li>
                    ))}
                  </ul>
                </Popover>
              ) : (
                <span className="relative flex min-w-9 items-center justify-center px-2 text-xs text-fg-faint tabular-nums">{o.count}</span>
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-fg-faint tabular-nums">
        {[t("poll.voters", { count: poll.voters }), closed ? t("poll.closed") : poll.closesAt ? t("poll.closesIn", { when: format.relativeTime(new Date(poll.closesAt), now) }) : null].filter(Boolean).join(" · ")}
      </p>
    </div>
  );
}
