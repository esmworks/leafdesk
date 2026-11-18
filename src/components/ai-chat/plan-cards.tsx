"use client";

/**
 * The cards a planning turn ends with (plan first, server/ai-chat-plan.ts), drawn under the
 * answer: the questions the assistant asks, with options and a field for the person's own words,
 * or the plan it proposes, with Run this plan and Change. Loaded by chat-thread.tsx only when
 * such an answer is shown. A card is live while it is the conversation's last answer and nothing
 * is on its way; after that it stays as a record, without buttons.
 */
import { ListChecks, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button, cn } from "@/components/ui";
import type { ChatPlanMode } from "@/db/schema/ai";
import { answered, answersMessage, type PlanCard, type QuestionAnswer } from "@/lib/chat-plan";

type Props = {
  card: PlanCard;
  live: boolean;
  /** Asks the next question: the answers (`first`), or the go-ahead (`run`). Missing where the chat can't (an agent's). */
  onReply?: (text: string, plan: ChatPlanMode) => void;
  /** Change: back to the box. */
  onChange: () => void;
};

const box = "mt-2 rounded-lg border border-border bg-bg-subtle px-3 py-2.5";

export default function PlanCardView({ card, live, onReply, onChange }: Props) {
  return card.kind === "questions" ? <Questions card={card} live={live && Boolean(onReply)} onReply={onReply} /> : <Proposal card={card} live={live && Boolean(onReply)} onReply={onReply} onChange={onChange} />;
}

function Questions({ card, live, onReply }: { card: Extract<PlanCard, { kind: "questions" }>; live: boolean; onReply?: Props["onReply"] }) {
  const t = useTranslations("ai.chat.plan");
  const [answers, setAnswers] = useState<QuestionAnswer[]>(() => card.questions.map(() => ({ option: null, text: "" })));
  const set = (i: number, next: QuestionAnswer) => setAnswers((list) => list.map((a, j) => (j === i ? next : a)));
  return (
    <form
      className={box}
      onSubmit={(e) => {
        e.preventDefault();
        if (live && answered(card, answers)) onReply?.(answersMessage(card, answers), "first");
      }}
    >
      <p className="flex items-center gap-1.5 text-xs font-medium text-fg-muted">
        <ListChecks className="h-3.5 w-3.5 shrink-0" />
        {t("questionsHeading")}
      </p>
      <div className="mt-2 space-y-3">
        {card.questions.map((q, i) => (
          <fieldset key={i} disabled={!live} className="min-w-0">
            <legend className="mb-1.5 text-sm font-medium">{q.question}</legend>
            <div role="radiogroup" aria-label={q.question} className="flex flex-wrap gap-1.5">
              {q.options.map((option, j) => {
                const on = answers[i].option === j && answers[i].text.trim() === "";
                return (
                  <button
                    key={j}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => set(i, { option: j, text: "" })}
                    className={cn(
                      "rounded-md border px-2.5 py-1 text-start text-sm transition-colors disabled:cursor-default",
                      on ? "border-fg bg-bg-active text-fg" : "border-border bg-bg text-fg-muted enabled:hover:bg-bg-hover enabled:hover:text-fg",
                    )}
                  >
                    {option}
                  </button>
                );
              })}
            </div>
            <input
              type="text"
              value={answers[i].text}
              onChange={(e) => set(i, { option: answers[i].option, text: e.target.value })}
              placeholder={t("otherPlaceholder")}
              aria-label={`${q.question}: ${t("other")}`}
              className="mt-1.5 block w-full rounded-md border border-border bg-bg px-2.5 py-1 text-sm outline-none focus:border-fg-faint disabled:opacity-60"
            />
          </fieldset>
        ))}
      </div>
      {live && (
        <div className="mt-3 flex justify-end">
          <Button type="submit" size="sm" variant="primary" disabled={!answered(card, answers)}>
            {t("submit")}
          </Button>
        </div>
      )}
    </form>
  );
}

function Proposal({ card, live, onReply, onChange }: { card: Extract<PlanCard, { kind: "proposal" }>; live: boolean; onReply?: Props["onReply"]; onChange: () => void }) {
  const t = useTranslations("ai.chat.plan");
  return (
    <section className={box} aria-label={card.title}>
      <p className="text-sm font-medium">{card.title}</p>
      <p className="mt-2.5 mb-1 text-xs font-medium text-fg-muted">{t("stepsHeading")}</p>
      <ol className="list-decimal space-y-1 ps-5 text-sm marker:text-fg-faint">
        {card.steps.map((s, i) => (
          <li key={i} className="min-w-0 break-words">
            {s.what}
            {s.where && <span className="ms-1.5 text-xs text-fg-muted">{s.where}</span>}
          </li>
        ))}
      </ol>
      {card.risks.length > 0 && (
        <>
          <p className="mt-2.5 mb-1 flex items-center gap-1.5 text-xs font-medium text-fg-muted">
            <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
            {t("risksHeading")}
          </p>
          <ul className="list-disc space-y-1 ps-5 text-sm marker:text-fg-faint">
            {card.risks.map((r, i) => (
              <li key={i} className="min-w-0 break-words">
                {r}
              </li>
            ))}
          </ul>
        </>
      )}
      {live && (
        <div className="mt-3 flex justify-end gap-1.5">
          <Button size="sm" variant="secondary" onClick={onChange}>
            {t("change")}
          </Button>
          <Button size="sm" variant="primary" onClick={() => onReply?.(t("runMessage"), "run")}>
            {t("run")}
          </Button>
        </div>
      )}
    </section>
  );
}
