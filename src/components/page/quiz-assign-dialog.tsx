"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { assignQuizAction } from "@/app/actions/quizzes";
import { PeoplePicker } from "@/components/database/automations-values";
import { read } from "@/components/read";
import { Button, Dialog, DialogBody, DialogFooter, DialogHeader, Input } from "@/components/ui";
import type { QuizPerson } from "@/server/quizzes";

/**
 * Asks people to take a quiz (server/quizzes.ts assignQuiz): any of the people who can open its
 * page, by a day or whenever. They hear of it in their inbox. Loaded when first opened.
 */
export function QuizAssignDialog({ quizId, onClose, onDone }: { quizId: string; onClose: () => void; onDone: () => void }) {
  const t = useTranslations("page.quiz.assign");
  const tc = useTranslations("common");
  const [people, setPeople] = useState<QuizPerson[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [due, setDue] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    read("quizPeople", quizId)
      .then((res) => (res.ok ? setPeople(res.data) : setFailed(true)))
      .catch(() => setFailed(true));
  }, [quizId]);

  const send = async () => {
    setSending(true);
    setError(null);
    try {
      const res = await assignQuizAction(quizId, chosen, due || null);
      if (!res.ok) return setError(res.error);
      onDone();
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open onClose={onClose} className="max-w-md">
      <DialogHeader title={t("title")} description={t("description")} onClose={onClose} closeLabel={tc("close")} />
      <DialogBody className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-fg">{t("people")}</span>
          {failed ? (
            <p className="text-sm text-danger">{t("loadFailed")}</p>
          ) : !people ? (
            <p className="text-sm text-fg-muted">{tc("loading")}</p>
          ) : !people.length ? (
            <p className="text-sm text-fg-muted">{t("noPeople")}</p>
          ) : (
            <PeoplePicker people={people} selected={chosen} onChange={setChosen} />
          )}
        </div>
        <label className="flex flex-col gap-1.5 text-[13px] font-medium text-fg">
          {t("due")}
          <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} className="w-44" />
        </label>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>
          {tc("cancel")}
        </Button>
        <Button variant="primary" disabled={!chosen.length || sending} onClick={() => void send()}>
          {t("submit")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
