"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { read } from "@/components/read";
import { MAX_STEP_MESSAGE } from "@/lib/automations";
import type { DraftActionOf } from "./automations-shared";
import { selectClass } from "./automations-values";
import { TemplateField } from "./automations-variables";

type Choice = { id: string; name: string; kind: "public" | "private" };

/** A "Post in a channel" step: the channel (one the person can post in) and the message. */
export function ChannelMessageEditor({ databaseId, action, onChange }: { databaseId: string; action: DraftActionOf<"channel_message">; onChange: (action: DraftActionOf<"channel_message">) => void }) {
  const t = useTranslations("database.automations");
  const [channels, setChannels] = useState<Choice[] | null>(null);
  useEffect(() => {
    let live = true;
    void read("automationChannels", databaseId).then(
      (res) => live && setChannels(res.ok ? res.data : []),
      () => live && setChannels([]),
    );
    return () => {
      live = false;
    };
  }, [databaseId]);
  const known = !action.channelId || !channels || channels.some((c) => c.id === action.channelId);
  return (
    <div className="space-y-1.5">
      <select value={action.channelId} onChange={(e) => onChange({ ...action, channelId: e.target.value })} aria-label={t("steps.channel")} className={selectClass} disabled={!channels}>
        <option value="">{channels ? t("steps.channelPick") : t("steps.channelLoading")}</option>
        {!known && <option value={action.channelId}>{t("steps.channelUnknown")}</option>}
        {(channels ?? []).map((c) => (
          <option key={c.id} value={c.id}>
            #{c.name}
            {c.kind === "private" ? ` (${t("steps.channelPrivate")})` : ""}
          </option>
        ))}
      </select>
      {channels && !channels.length && <p className="text-xs text-fg-muted">{t("steps.channelNone")}</p>}
      <TemplateField
        rows={3}
        value={action.message}
        maxLength={MAX_STEP_MESSAGE}
        aria-label={t("steps.channelMessage")}
        placeholder={t("steps.slackPlaceholder", { template: "{{trigger.title}}" })}
        onChange={(message) => onChange({ ...action, message })}
      />
      <p className="text-xs text-fg-faint">{t("steps.channelHelp")}</p>
    </div>
  );
}
