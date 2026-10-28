"use client";

import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useMemo, useState, useTransition } from "react";
import { legalHoldCandidatesAction, releaseLegalHoldAction, setLegalHoldAction } from "@/app/actions/legal-holds";
import { Button, Dialog, DialogBody, DialogFooter, DialogTitle, Input, textareaClass } from "@/components/ui";
import { LEGAL_HOLD_NAME_MAX, LEGAL_HOLD_REASON_MAX } from "@/lib/legal-hold";
import { searchFold } from "@/lib/search-fold";
import type { LegalHoldPerson, LegalHoldView } from "@/server/legal-hold";
import { SettingsRow } from "./section";

/**
 * Settings > Security > Legal holds, for owners: the holds that stand, who is on each and why, a
 * new one, and releasing one (server/legal-hold.ts).
 */
export function LegalHolds({ workspaceId, holds }: { workspaceId: string; holds: LegalHoldView[] }) {
  const t = useTranslations("settings.legalHolds");
  return (
    <SettingsRow title={t("holds")} description={t("holdsDescription")} control={<NewLegalHold workspaceId={workspaceId} />}>
      {holds.length === 0 ? (
        <p className="text-sm text-fg-muted">{t("empty")}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border bg-bg">
          {holds.map((hold) => (
            <li key={hold.id} className="flex items-start gap-3 px-3 py-2.5" data-legal-hold={hold.name}>
              <div className="min-w-0 flex-1 text-sm">
                <div className="truncate font-medium">{hold.name}</div>
                <div className="text-xs text-fg-muted">
                  {hold.createdBy
                    ? t("setBy", { name: hold.createdBy, date: new Date(hold.createdAt) })
                    : t("setOn", { date: new Date(hold.createdAt) })}
                </div>
                {hold.reason && <p className="mt-1 whitespace-pre-line text-fg-muted">{hold.reason}</p>}
                <ul className="mt-1.5 flex flex-wrap gap-1" aria-label={t("people", { count: hold.people.length })}>
                  {hold.people.map((person) => (
                    <li key={person.id} className="rounded-md bg-bg-hover px-1.5 py-0.5 text-xs" title={person.email}>
                      {person.name || person.email}
                      <PersonNote person={person} />
                    </li>
                  ))}
                </ul>
              </div>
              <ReleaseLegalHold workspaceId={workspaceId} hold={hold} />
            </li>
          ))}
        </ul>
      )}
    </SettingsRow>
  );
}

/** "(guest)", "(left)": what sets a person apart from the members. */
function PersonNote({ person }: { person: LegalHoldPerson }) {
  const t = useTranslations("settings.legalHolds");
  if (person.role === null) return <span className="text-fg-muted"> · {t("left")}</span>;
  if (person.role === "guest") return <span className="text-fg-muted"> · {t("guest")}</span>;
  return null;
}

function NewLegalHold({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations("settings.legalHolds");
  const tc = useTranslations("common");
  const router = useRouter();
  const ids = useId();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [reason, setReason] = useState("");
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState<LegalHoldPerson[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const start = () => {
    setOpen(true);
    setPeople(null);
    legalHoldCandidatesAction(workspaceId).then(
      (result) => (result.ok ? setPeople(result.data) : setError(result.error)),
      () => setError(tc("genericError")),
    );
  };
  const close = () => {
    setOpen(false);
    setName("");
    setReason("");
    setQuery("");
    setChosen(new Set());
    setError(null);
  };
  const shown = useMemo(() => {
    const wanted = searchFold(query.trim());
    return (people ?? []).filter((p) => !wanted || searchFold(`${p.name} ${p.email}`).includes(wanted));
  }, [people, query]);
  const toggle = (id: string) =>
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <>
      <Button size="sm" onClick={start}>
        <Plus className="h-3.5 w-3.5" aria-hidden />
        {t("new")}
      </Button>
      <Dialog open={open} onClose={close} className="max-w-md">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            startTransition(async () => {
              try {
                const result = await setLegalHoldAction(workspaceId, { name, reason, userIds: [...chosen] });
                if (!result.ok) return setError(result.error);
                close();
                router.refresh();
              } catch {
                setError(tc("genericError"));
              }
            });
          }}
        >
          <DialogBody className="pt-5">
            <div className="space-y-1.5">
              <DialogTitle>{t("form.title")}</DialogTitle>
              <p className="text-sm text-fg-muted">{t("form.description")}</p>
            </div>
            <div className="space-y-1.5">
              <label htmlFor={`${ids}-name`} className="block text-sm font-medium">
                {t("form.name")}
              </label>
              <Input
                id={`${ids}-name`}
                value={name}
                maxLength={LEGAL_HOLD_NAME_MAX}
                required
                autoFocus
                placeholder={t("form.namePlaceholder")}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor={`${ids}-reason`} className="block text-sm font-medium">
                {t("form.reason")}
              </label>
              <textarea
                id={`${ids}-reason`}
                className={textareaClass}
                rows={2}
                value={reason}
                maxLength={LEGAL_HOLD_REASON_MAX}
                placeholder={t("form.reasonPlaceholder")}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
            <fieldset className="space-y-1.5">
              <legend className="block text-sm font-medium">{t("form.people", { count: chosen.size })}</legend>
              <Input type="search" value={query} placeholder={t("form.search")} aria-label={t("form.search")} onChange={(e) => setQuery(e.target.value)} />
              <div className="max-h-56 overflow-y-auto rounded-lg border border-border">
                {people === null ? (
                  <p className="px-3 py-2 text-sm text-fg-muted">{t("form.loading")}</p>
                ) : shown.length === 0 ? (
                  <p className="px-3 py-2 text-sm text-fg-muted">{t("form.nobody")}</p>
                ) : (
                  <ul className="divide-y divide-border">
                    {shown.map((person) => (
                      <li key={person.id}>
                        <label className="flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-sm hover:bg-bg-hover">
                          <input type="checkbox" checked={chosen.has(person.id)} onChange={() => toggle(person.id)} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate">
                              {person.name || person.email}
                              <PersonNote person={person} />
                            </span>
                            {person.name && <span className="block truncate text-xs text-fg-muted">{person.email}</span>}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </fieldset>
            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={close} disabled={pending}>
              {tc("cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={pending || !name.trim() || chosen.size === 0}>
              {t("form.submit")}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>
    </>
  );
}

function ReleaseLegalHold({ workspaceId, hold }: { workspaceId: string; hold: LegalHoldView }) {
  const t = useTranslations("settings.legalHolds");
  const tc = useTranslations("common");
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  if (!confirming) {
    return (
      <Button size="sm" onClick={() => setConfirming(true)}>
        {t("release")}
      </Button>
    );
  }
  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <div className="flex gap-1">
        <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={pending}>
          {tc("cancel")}
        </Button>
        <Button
          size="sm"
          variant="danger"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await releaseLegalHoldAction(workspaceId, hold.id).catch(() => null);
              if (result?.ok) router.refresh();
              else setError(result?.error ?? tc("genericError"));
            })
          }
        >
          {t("confirmRelease", { name: hold.name })}
        </Button>
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
