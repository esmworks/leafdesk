"use client";

import { ArrowDown, ArrowUp, Check, ListChecks, Plus, Trash2, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { copyQuizAction, saveQuizAction, submitQuizAction, unassignQuizAction } from "@/app/actions/quizzes";
import { lazyPart } from "@/components/lazy-part";
import { read } from "@/components/read";
import { Button, cn, IconButton, Input, selectClass, textareaClass } from "@/components/ui";
import { UserAvatar } from "@/components/user-avatar";
import { formatIsoDate } from "@/lib/mentions";
import {
  blankQuestion,
  isOverdue,
  MAX_EXPLANATION,
  MAX_OPTION_TEXT,
  MAX_OPTIONS,
  MAX_QUESTION_TEXT,
  MAX_QUESTIONS,
  MIN_OPTIONS,
  newQuizItemId,
  quizDone,
  type QuizAnswers,
  type QuizKind,
  type QuizQuestion,
  type QuizQuestionView,
} from "@/lib/quizzes";
import type { QuizResult, QuizView } from "@/server/quizzes";

/**
 * A quiz in its page (components/page/quiz-block.tsx loads this where one is shown): taking it,
 * and for those who may edit the page its questions and everyone's results. What it shows of the
 * answers is what the server sent (server/quizzes.ts readQuiz).
 */

const AssignDialog = lazyPart(() => import("./quiz-assign-dialog").then((m) => m.QuizAssignDialog));

type Tab = "take" | "questions" | "results";
type OwnView = Extract<QuizView, { foreign: false }>;

/** The viewer's own day, as YYYY-MM-DD. */
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function QuizPanel({ quizId, pageId, editable, onPoint }: { quizId: string; pageId: string; editable: boolean; onPoint: (quizId: string) => void }) {
  const t = useTranslations("page.quiz");
  const tc = useTranslations("common");
  const [view, setView] = useState<QuizView | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("take");
  const [copying, setCopying] = useState(false);

  const load = useCallback(() => {
    setFailed(null);
    read("quiz", quizId, pageId)
      .then((res) => (res.ok ? setView(res.data) : setFailed(res.error)))
      .catch(() => setFailed(t("unavailable")));
  }, [quizId, pageId, t]);
  useEffect(load, [load]);

  if (failed) {
    return (
      <Frame>
        <p className="flex-1 text-sm text-fg-muted">{failed}</p>
        <Button size="sm" variant="ghost" onClick={load}>
          {t("retry")}
        </Button>
      </Frame>
    );
  }
  if (!view) return <div aria-busy="true" aria-label={tc("loading")} className="my-1 h-24 w-full animate-pulse rounded-lg bg-bg-subtle" />;
  if (view.foreign) {
    const copy = async () => {
      setCopying(true);
      try {
        const res = await copyQuizAction(quizId, pageId);
        if (res.ok) onPoint(res.data.id);
        else setFailed(res.error);
      } finally {
        setCopying(false);
      }
    };
    return (
      <Frame>
        <p className="flex-1 text-sm text-fg-muted">{t("foreign")}</p>
        {editable && view.canCopy && (
          <Button size="sm" disabled={copying} onClick={() => void copy()}>
            {t("copyHere")}
          </Button>
        )}
      </Frame>
    );
  }
  const shown: Tab = view.canEdit ? tab : "take";
  return (
    <section className="my-1 w-full rounded-lg border border-border px-4 py-3" aria-label={t("label")}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <ListChecks className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden />
        <h3 className="text-sm font-medium text-fg">{t("label")}</h3>
        <span className="text-xs text-fg-faint tabular-nums">
          {t("summary", { count: view.questions.length, mark: view.passMark })}
          {view.mine.left !== null && <> · {t("attemptsLeft", { count: view.mine.left })}</>}
        </span>
        {view.canEdit && (
          <nav className="ms-auto flex gap-3" role="tablist">
            {(["take", "questions", "results"] as const).map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={shown === key}
                onClick={() => setTab(key)}
                className={cn("border-b-2 py-1 text-sm", shown === key ? "border-fg text-fg" : "border-transparent text-fg-muted hover:text-fg")}
              >
                {t(`tabs.${key}`)}
              </button>
            ))}
          </nav>
        )}
      </header>
      <div className="mt-3">
        {shown === "take" && <TakeQuiz view={view} onView={setView} onEdit={view.canEdit ? () => setTab("questions") : undefined} />}
        {shown === "questions" && <QuizEditor view={view} onView={setView} />}
        {shown === "results" && <QuizResults view={view} />}
      </div>
    </section>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return <div className="my-1 flex w-full flex-wrap items-center gap-2 rounded-lg bg-bg-subtle px-3 py-3">{children}</div>;
}

// ---------------------------------------------------------------------------------------------
// Taking it

function TakeQuiz({ view, onView, onEdit }: { view: OwnView; onView: (view: QuizView) => void; onEdit?: () => void }) {
  const t = useTranslations("page.quiz.take");
  const locale = useLocale();
  const { mine } = view;
  const done = quizDone(mine.passed, mine.attempts, view.maxAttempts);
  // Answering: from Start (or Try again) until the answers are sent.
  const [answering, setAnswering] = useState(false);
  const [answers, setAnswers] = useState<QuizAnswers>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!view.questions.length) {
    return (
      <div className="flex items-center gap-2">
        <p className="flex-1 text-sm text-fg-muted">{t("noQuestions")}</p>
        {onEdit && (
          <Button size="sm" onClick={onEdit}>
            {t("addQuestions")}
          </Button>
        )}
      </div>
    );
  }

  const pick = (question: QuizQuestionView, optionId: string) =>
    setAnswers((current) => {
      const picked = current[question.id] ?? [];
      const next = question.kind === "single" ? [optionId] : picked.includes(optionId) ? picked.filter((id) => id !== optionId) : [...picked, optionId];
      return { ...current, [question.id]: next };
    });
  const complete = view.questions.every((q) => (answers[q.id] ?? []).length > 0);
  const submit = async () => {
    setSending(true);
    setError(null);
    try {
      const res = await submitQuizAction(view.id, answers);
      if (!res.ok) return setError(res.error);
      onView(res.data);
      setAnswering(false);
    } finally {
      setSending(false);
    }
  };
  const start = () => {
    setAnswers({});
    setError(null);
    setAnswering(true);
  };

  const status = mine.passed && mine.passedAt ? (
    <p className="text-sm text-fg">{t("passedOn", { date: formatIsoDate(mine.passedAt, locale), score: mine.best ?? 0 })}</p>
  ) : mine.assigned ? (
    <p className={cn("text-sm", isOverdue(mine.assigned.due, false, today()) ? "text-danger" : "text-fg-muted")}>
      {mine.assigned.due ? t("dueBy", { date: formatIsoDate(mine.assigned.due, locale) }) : t("asked")}
    </p>
  ) : null;

  if (answering) {
    return (
      <div className="flex flex-col gap-5">
        {view.questions.map((question, index) => (
          <QuestionBlock key={question.id} question={question} index={index} picked={answers[question.id] ?? []} onPick={(id) => pick(question, id)} />
        ))}
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" disabled={!complete || sending} title={complete ? undefined : t("answerAll")} onClick={() => void submit()}>
            {t("submit")}
          </Button>
          {!complete && <span className="text-xs text-fg-faint">{t("answerAll")}</span>}
          {error && (
            <span role="alert" className="text-sm text-danger">
              {error}
            </span>
          )}
        </div>
      </div>
    );
  }

  const last = mine.last;
  return (
    <div className="flex flex-col gap-4">
      {status}
      {last && (
        <>
          <p role="status" className="text-sm text-fg">
            {last.passed
              ? t("resultPassed", { score: last.score })
              : done
                ? t("outOfAttempts", { score: mine.best ?? last.score })
                : t("resultFailed", { score: last.score, mark: view.passMark })}
          </p>
          <div className="flex flex-col gap-5">
            {view.questions.map((question, index) => (
              <QuestionBlock
                key={question.id}
                question={question}
                index={index}
                picked={last.answers[question.id] ?? []}
                result={last.right.includes(question.id) ? "right" : "wrong"}
              />
            ))}
          </div>
        </>
      )}
      {!done && (
        <div>
          <Button variant="primary" onClick={start}>
            {last ? t("tryAgain") : t("start")}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * A question to answer (`onPick`) or as it was answered (`result`): the options picked, and when the
 * server sent the right answers (editors, or a reader who is done), which those were and why.
 */
function QuestionBlock({
  question,
  index,
  picked,
  onPick,
  result,
}: {
  question: QuizQuestionView;
  index: number;
  picked: string[];
  onPick?: (optionId: string) => void;
  result?: "right" | "wrong";
}) {
  const t = useTranslations("page.quiz.take");
  const te = useTranslations("page.quiz.editor");
  const name = `quiz-${question.id}`;
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 flex w-full items-start gap-2 text-sm font-medium text-fg">
        <span className="min-w-0 flex-1">
          <span className="text-fg-faint tabular-nums">{index + 1}. </span>
          {question.text}
        </span>
        {result && (
          <span className={cn("inline-flex shrink-0 items-center gap-1 text-xs font-normal", result === "right" ? "text-accent" : "text-danger")}>
            {result === "right" ? <Check className="h-3.5 w-3.5" aria-hidden /> : <X className="h-3.5 w-3.5" aria-hidden />}
            {t(result)}
          </span>
        )}
      </legend>
      {onPick && <span className="text-xs text-fg-faint">{question.kind === "single" ? t("pickOne") : t("pickAll")}</span>}
      {question.options.map((option) => {
        const chosen = picked.includes(option.id);
        const correct = question.correct?.includes(option.id) ?? false;
        return (
          <label
            key={option.id}
            className={cn("flex min-h-8 items-center gap-2 rounded-md px-2 text-sm", onPick ? "cursor-pointer hover:bg-bg-hover" : "cursor-default")}
          >
            <input
              type={question.kind === "single" ? "radio" : "checkbox"}
              name={name}
              checked={chosen}
              disabled={!onPick}
              onChange={() => onPick?.(option.id)}
              className="h-4 w-4 shrink-0 accent-accent"
            />
            <span className="min-w-0 flex-1">{option.text}</span>
            {!onPick && question.correct && correct && <span className="shrink-0 text-xs text-accent">{t("rightAnswer")}</span>}
          </label>
        );
      })}
      {!onPick && question.explanation && (
        <p className="ms-2 text-[13px] text-fg-muted">
          <span className="sr-only">{te("explanation")}: </span>
          {question.explanation}
        </p>
      )}
    </fieldset>
  );
}

// ---------------------------------------------------------------------------------------------
// Editing it

type Draft = { questions: QuizQuestion[]; passMark: string; maxAttempts: string };

const draftOf = (view: OwnView): Draft => ({
  questions: view.questions.map((q) => ({ ...q, correct: q.correct ?? [], explanation: q.explanation ?? "" })),
  passMark: String(view.passMark),
  maxAttempts: view.maxAttempts === null ? "" : String(view.maxAttempts),
});

function QuizEditor({ view, onView }: { view: OwnView; onView: (view: QuizView) => void }) {
  const t = useTranslations("page.quiz.editor");
  const [draft, setDraft] = useState<Draft>(() => draftOf(view));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const changed = useMemo(() => JSON.stringify(draft) !== JSON.stringify(draftOf(view)), [draft, view]);

  const setQuestion = (index: number, change: (q: QuizQuestion) => QuizQuestion) =>
    setDraft((d) => ({ ...d, questions: d.questions.map((q, i) => (i === index ? change(q) : q)) }));
  const move = (index: number, by: number) =>
    setDraft((d) => {
      const questions = [...d.questions];
      const [moved] = questions.splice(index, 1);
      questions.splice(index + by, 0, moved);
      return { ...d, questions };
    });

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await saveQuizAction(view.id, {
        questions: draft.questions,
        passMark: Number(draft.passMark),
        maxAttempts: draft.maxAttempts.trim() ? Number(draft.maxAttempts) : null,
      });
      if (!res.ok) return setMessage({ ok: false, text: res.error });
      onView(res.data);
      if (!res.data.foreign) setDraft(draftOf(res.data));
      setMessage({ ok: true, text: t("saved") });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-6" data-filled-fields>
      {draft.questions.map((question, index) => (
        <div key={question.id} className="flex flex-col gap-2">
          <div className="flex items-center gap-1">
            <span className="flex-1 text-[13px] font-medium text-fg">{t("question", { number: index + 1 })}</span>
            <IconButton label={t("moveUp")} disabled={index === 0} onClick={() => move(index, -1)}>
              <ArrowUp className="h-3.5 w-3.5" />
            </IconButton>
            <IconButton label={t("moveDown")} disabled={index === draft.questions.length - 1} onClick={() => move(index, 1)}>
              <ArrowDown className="h-3.5 w-3.5" />
            </IconButton>
            <IconButton
              label={t("removeQuestion")}
              className="hover:text-danger"
              onClick={() => setDraft((d) => ({ ...d, questions: d.questions.filter((_, i) => i !== index) }))}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </IconButton>
          </div>
          <Input
            value={question.text}
            maxLength={MAX_QUESTION_TEXT}
            placeholder={t("questionPlaceholder")}
            aria-label={t("question", { number: index + 1 })}
            onChange={(e) => setQuestion(index, (q) => ({ ...q, text: e.target.value }))}
          />
          <label className="flex items-center gap-2 text-[13px] text-fg-muted">
            {t("kind")}
            <select
              className={selectClass}
              value={question.kind}
              onChange={(e) => {
                const kind = e.target.value as QuizKind;
                setQuestion(index, (q) => ({ ...q, kind, correct: kind === "single" ? q.correct.slice(0, 1) : q.correct }));
              }}
            >
              <option value="single">{t("single")}</option>
              <option value="multiple">{t("multiple")}</option>
            </select>
          </label>
          <div className="flex flex-col gap-1">
            {question.options.map((option, optionIndex) => (
              <div key={option.id} className="flex items-center gap-2">
                <input
                  type={question.kind === "single" ? "radio" : "checkbox"}
                  name={`quiz-edit-${question.id}`}
                  checked={question.correct.includes(option.id)}
                  aria-label={t("markRight")}
                  title={t("markRight")}
                  onChange={() =>
                    setQuestion(index, (q) => ({
                      ...q,
                      correct:
                        q.kind === "single" ? [option.id] : q.correct.includes(option.id) ? q.correct.filter((id) => id !== option.id) : [...q.correct, option.id],
                    }))
                  }
                  className="h-4 w-4 shrink-0 accent-accent"
                />
                <Input
                  value={option.text}
                  maxLength={MAX_OPTION_TEXT}
                  placeholder={t("optionPlaceholder", { number: optionIndex + 1 })}
                  aria-label={t("optionPlaceholder", { number: optionIndex + 1 })}
                  onChange={(e) =>
                    setQuestion(index, (q) => ({ ...q, options: q.options.map((o) => (o.id === option.id ? { ...o, text: e.target.value } : o)) }))
                  }
                  className="min-w-0 flex-1"
                />
                <IconButton
                  label={t("removeOption")}
                  disabled={question.options.length <= MIN_OPTIONS}
                  className="hover:text-danger"
                  onClick={() =>
                    setQuestion(index, (q) => ({ ...q, options: q.options.filter((o) => o.id !== option.id), correct: q.correct.filter((id) => id !== option.id) }))
                  }
                >
                  <X className="h-3.5 w-3.5" />
                </IconButton>
              </div>
            ))}
            {question.options.length < MAX_OPTIONS && (
              <div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setQuestion(index, (q) => ({ ...q, options: [...q.options, { id: newQuizItemId(), text: "" }] }))}
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden />
                  {t("addOption")}
                </Button>
              </div>
            )}
          </div>
          <textarea
            className={textareaClass}
            rows={2}
            value={question.explanation}
            maxLength={MAX_EXPLANATION}
            placeholder={t("explanationPlaceholder")}
            aria-label={t("explanation")}
            onChange={(e) => setQuestion(index, (q) => ({ ...q, explanation: e.target.value }))}
          />
        </div>
      ))}
      {draft.questions.length < MAX_QUESTIONS && (
        <div>
          <Button size="sm" onClick={() => setDraft((d) => ({ ...d, questions: [...d.questions, blankQuestion()] }))}>
            <Plus className="h-3.5 w-3.5" aria-hidden />
            {t("addQuestion")}
          </Button>
        </div>
      )}
      <div className="flex flex-wrap gap-4">
        <label className="flex flex-col gap-1 text-[13px] font-medium text-fg">
          {t("passMark")}
          <Input type="number" min={0} max={100} step={1} value={draft.passMark} onChange={(e) => setDraft((d) => ({ ...d, passMark: e.target.value }))} className="w-28" />
        </label>
        <label className="flex flex-col gap-1 text-[13px] font-medium text-fg">
          {t("attempts")}
          <Input
            type="number"
            min={1}
            max={100}
            step={1}
            value={draft.maxAttempts}
            placeholder={t("attemptsAny")}
            onChange={(e) => setDraft((d) => ({ ...d, maxAttempts: e.target.value }))}
            className="w-36"
          />
        </label>
      </div>
      <p className="text-[13px] text-fg-muted">{t("answersPrivate")}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" disabled={!changed || saving} onClick={() => void save()}>
          {t("save")}
        </Button>
        {message && (
          <span role={message.ok ? "status" : "alert"} className={cn("text-sm", message.ok ? "text-fg-muted" : "text-danger")}>
            {message.text}
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Results

function QuizResults({ view }: { view: OwnView }) {
  const t = useTranslations("page.quiz.results");
  const locale = useLocale();
  const [rows, setRows] = useState<QuizResult[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [asking, setAsking] = useState(false);

  const load = useCallback(() => {
    setFailed(false);
    read("quizResults", view.id)
      .then((res) => (res.ok ? setRows(res.data) : setFailed(true)))
      .catch(() => setFailed(true));
  }, [view.id]);
  useEffect(load, [load]);

  const unassign = async (userId: string) => {
    const res = await unassignQuizAction(view.id, userId);
    if (res.ok) load();
  };
  const day = today();
  const statusOf = (row: QuizResult) =>
    row.passed ? t("passed") : quizDone(false, row.attempts, view.maxAttempts) ? t("failed") : row.attempts ? t("trying") : t("notStarted");

  return (
    <div className="flex flex-col gap-3">
      <div>
        <Button size="sm" onClick={() => setAsking(true)}>
          {t("assign")}
        </Button>
      </div>
      {failed && <p className="text-sm text-danger">{t("loadFailed")}</p>}
      {rows && !rows.length && <p className="text-sm text-fg-muted">{t("empty")}</p>}
      {rows && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-start text-xs text-fg-faint">
                <th className="py-1.5 pe-3 text-start font-medium">{t("person")}</th>
                <th className="py-1.5 pe-3 text-start font-medium">{t("best")}</th>
                <th className="py-1.5 pe-3 text-start font-medium">{t("attempts")}</th>
                <th className="py-1.5 pe-3 text-start font-medium">{t("status")}</th>
                <th className="py-1.5 pe-3 text-start font-medium">{t("due")}</th>
                <th className="py-1.5" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const overdue = row.assigned && isOverdue(row.due, row.passed, day);
                const name = row.name || t("unknown");
                return (
                  <tr key={row.userId} className="group/result">
                    <td className="py-1.5 pe-3">
                      <span className="flex items-center gap-2">
                        <UserAvatar name={name} image={row.image} size="xs" />
                        <span className="truncate">{name}</span>
                      </span>
                    </td>
                    <td className="py-1.5 pe-3 tabular-nums">{row.best === null ? "–" : `${row.best}%`}</td>
                    <td className="py-1.5 pe-3 tabular-nums">{row.attempts}</td>
                    <td className={cn("py-1.5 pe-3", row.passed ? "text-accent" : "text-fg-muted")}>{statusOf(row)}</td>
                    <td className={cn("py-1.5 pe-3 tabular-nums", overdue ? "text-danger" : "text-fg-muted")}>
                      {row.due ? formatIsoDate(row.due, locale) : ""}
                      {overdue && <span className="ms-1">· {t("overdue")}</span>}
                    </td>
                    <td className="py-1.5 text-end">
                      {row.assigned && (
                        <IconButton
                          label={t("unassign", { name })}
                          className="opacity-0 hover:text-danger focus-visible:opacity-100 group-hover/result:opacity-100 [@media(hover:none)]:opacity-100"
                          onClick={() => void unassign(row.userId)}
                        >
                          <X className="h-3.5 w-3.5" />
                        </IconButton>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {asking && (
        <AssignDialog
          quizId={view.id}
          onClose={() => setAsking(false)}
          onDone={() => {
            setAsking(false);
            load();
          }}
        />
      )}
    </div>
  );
}
