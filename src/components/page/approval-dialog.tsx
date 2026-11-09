"use client";

/**
 * Asks people to approve the page (server/page-approvals.ts): who (people who can open it), whether
 * everyone must approve or any one is enough, an optional due day and note. Loaded when the page
 * menu or the approval history opens it.
 */
import { BadgeCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { requestApprovalAction } from "@/app/actions/page-approvals";
import { PeoplePicker, type PickablePerson } from "@/components/people-picker";
import { read } from "@/components/read";
import { showToast } from "@/components/toast";
import { Button, Dialog, DialogBody, DialogFooter, DialogHeader, Input, textareaClass } from "@/components/ui";
import { localIsoDate } from "@/lib/mentions";
import { APPROVAL_RULES, MAX_APPROVAL_NOTE, MAX_APPROVERS, type ApprovalRule } from "@/lib/page-approvals";

export function ApprovalDialog({
  workspaceId,
  pageId,
  replacing,
  onClose,
  onDone,
}: {
  workspaceId: string;
  pageId: string;
  /** A request waits now: sending this one withdraws it. */
  replacing: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations("page.approval");
  const tc = useTranslations("common");
  const [people, setPeople] = useState<PickablePerson[] | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [rule, setRule] = useState<ApprovalRule>("all");
  const [due, setDue] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    read("approvalCandidates", pageId)
      .then((list) => !cancelled && setPeople(list))
      .catch(() => {
        if (cancelled) return;
        setPeople([]);
        setError(tc("genericError"));
      });
    return () => {
      cancelled = true;
    };
  }, [pageId, tc]);

  const submit = async () => {
    if (!chosen.length) return setError(t("errors.approvers"));
    setSaving(true);
    setError(null);
    try {
      const result = await requestApprovalAction(workspaceId, pageId, { approverIds: chosen, rule, dueDate: due || null, note: note || null });
      if (!result.ok) return setError(result.error);
      showToast({ message: t("sent") });
      onDone();
      onClose();
    } catch {
      setError(tc("genericError"));
    } finally {
      setSaving(false);
    }
  };

  if (typeof document === "undefined") return null;
  // A portal: the page header's blurred background would otherwise hold the fixed overlay inside it.
  return createPortal(
    <Dialog open onClose={saving ? () => {} : onClose} className="max-w-md">
      <DialogHeader icon={<BadgeCheck className="h-4 w-4" />} title={t("title")} description={t("description")} onClose={onClose} closeLabel={tc("close")} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <DialogBody>
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-fg">{t("approvers")}</span>
            {people === null ? (
              <p className="text-[13px] text-fg-muted">{tc("loading")}</p>
            ) : people.length ? (
              <PeoplePicker people={people} selected={chosen} onChange={setChosen} max={MAX_APPROVERS} />
            ) : (
              <p className="text-[13px] text-fg-muted">{t("noPeople")}</p>
            )}
          </div>
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-[13px] font-medium text-fg">{t("ruleLabel")}</legend>
            {APPROVAL_RULES.map((value) => (
              <label key={value} className="flex items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-bg-hover">
                <input type="radio" name="approval-rule" value={value} checked={rule === value} onChange={() => setRule(value)} />
                {t(`rules.${value}`)}
              </label>
            ))}
          </fieldset>
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-fg">{t("dueLabel")}</span>
            <Input type="date" value={due} min={localIsoDate(0)} onChange={(e) => setDue(e.target.value)} className="w-44" />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-fg">{t("noteLabel")}</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={MAX_APPROVAL_NOTE}
              rows={3}
              placeholder={t("notePlaceholder")}
              className={textareaClass}
            />
          </label>
          {replacing && <p className="text-[13px] text-fg-muted">{t("replaces")}</p>}
          {error && (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
            {tc("cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={saving || !chosen.length}>
            {t("send")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>,
    document.body,
  );
}
