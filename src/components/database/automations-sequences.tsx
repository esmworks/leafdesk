"use client";

import { useTranslations } from "next-intl";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { listSequencesAction } from "@/app/actions/sequences";
import { Repeat } from "lucide-react";
import { Button, MenuItem, Popover, selectClass } from "@/components/ui";
import { newKey, optionsOf, type Draft, type DraftActionOf } from "./automations-shared";
import { useSchema } from "./schema-context";
import type { Property } from "./types";

/**
 * Follow-ups in the automations dialog: the database's sequences, which a "Start a follow-up"
 * step picks from, and the example automation that starts one.
 */

export type SequenceChoice = { id: string; name: string };

const SequencesContext = createContext<SequenceChoice[] | null>(null);

/** Loads the database's sequences for the steps below it (null while they load). */
export function SequenceChoicesProvider({ databaseId, children }: { databaseId: string; children: ReactNode }) {
  const [sequences, setSequences] = useState<SequenceChoice[] | null>(null);
  useEffect(() => {
    let live = true;
    listSequencesAction(databaseId)
      .then((res) => live && setSequences(res.ok ? res.data.sequences.map((s) => ({ id: s.id, name: s.name })) : []))
      .catch(() => live && setSequences([]));
    return () => {
      live = false;
    };
  }, [databaseId]);
  return <SequencesContext.Provider value={sequences}>{children}</SequencesContext.Provider>;
}

export const useSequenceChoices = () => useContext(SequencesContext);

/**
 * The sequence a "Start a follow-up" step starts on the row. Only the automation's own database
 * has its sequences listed: a step going over another database's rows can't start one.
 */
export function StartSequenceEditor({
  action,
  sameDatabase,
  onChange,
}: {
  action: DraftActionOf<"start_sequence">;
  /** The step acts on rows of the automation's database. */
  sameDatabase: boolean;
  onChange: (action: DraftActionOf<"start_sequence">) => void;
}) {
  const t = useTranslations("database.automations.form");
  const tc = useTranslations("common");
  const sequences = useSequenceChoices();
  if (!sameDatabase) return <p className="text-xs text-danger">{t("sequenceOtherDatabase")}</p>;
  if (sequences === null) return <p className="text-xs text-fg-muted">{tc("loading")}</p>;
  if (!sequences.length && !action.sequenceId) return <p className="text-sm text-fg-muted">{t("noSequences")}</p>;
  const chosen = sequences.find((s) => s.id === action.sequenceId);
  return (
    <div className="space-y-2">
      <select value={action.sequenceId} aria-label={t("sequence")} onChange={(e) => onChange({ ...action, sequenceId: e.target.value })} className={selectClass}>
        <option value="">{t("chooseSequence")}</option>
        {sequences.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
        {action.sequenceId && !chosen && <option value={action.sequenceId}>{t("deletedSequence")}</option>}
      </select>
      <p className="text-xs text-fg-faint">{t("sequenceHelp")}</p>
    </div>
  );
}

/** A status or select property's option that reads like a quote went out, for the example's trigger. */
const QUOTE = /quote|offer|proposal|teklif|angebot|devis|oferta|presupuesto|preventivo/i;

/**
 * The example automation: when a status or select property becomes an option like "Quote sent"
 * (the first such property and option there are), start the database's first follow-up whose name
 * reads like it (else its first). Without such a property it starts on every new row.
 */
export function followUpExample(properties: Property[], sequences: SequenceChoice[], name: (sequence: string) => string): Draft {
  const sequence = sequences.find((s) => QUOTE.test(s.name)) ?? sequences[0];
  const choices = properties.filter((p) => p.type === "status" || p.type === "select");
  const prop = choices.find((p) => optionsOf(p).some((o) => QUOTE.test(o.name))) ?? choices[0];
  const option = prop ? (optionsOf(prop).find((o) => QUOTE.test(o.name)) ?? null) : null;
  return {
    name: name(sequence?.name ?? ""),
    enabled: true,
    trigger: prop && option ? { type: "property_changed", properties: [prop.id], to: option.id } : { type: "row_created" },
    actions: [{ key: newKey(), id: "follow_up", type: "start_sequence", sequenceId: sequence?.id ?? "", forEach: "" }],
  };
}

/** "Start from an example" under the automations list: for now the one that starts a follow-up, once the database has one. */
export function FollowUpExampleButton({ onPick }: { onPick: (draft: Draft) => void }) {
  const t = useTranslations("database.automations");
  const properties = useSchema();
  const sequences = useSequenceChoices();
  if (!sequences?.length) return null;
  return (
    <Popover
      side="top"
      align="end"
      trigger={({ toggle }) => (
        <Button onClick={toggle} aria-haspopup="menu">
          {t("example")}
        </Button>
      )}
    >
      {(close) => (
        <MenuItem
          icon={<Repeat className="h-3.5 w-3.5" />}
          onClick={() => {
            close();
            onPick(followUpExample(properties, sequences, (sequence) => t("exampleFollowUp", { sequence })));
          }}
        >
          {t("exampleFollowUpItem")}
        </MenuItem>
      )}
    </Popover>
  );
}
