"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { updateWorkspaceSettingsAction } from "@/app/actions/workspaces";
import { Button, Input } from "@/components/ui";
import { MAX_AI_MONTHLY_LIMIT_USD, parseAiMonthlyLimit } from "@/lib/ai-usage";
import { SettingsRow } from "./section";
import { useAction } from "./workspace-settings";

/**
 * Settings > AI usage > Monthly limit: owners set the most the workspace's AI may cost in a month,
 * in US dollars, or clear it (empty). Requests past it fail until the next month (server/ai/usage.ts).
 */
export function AiLimitForm({ workspaceId, limit, description }: { workspaceId: string; limit: number | null; description: string }) {
  const t = useTranslations("settings.aiUsage");
  const tc = useTranslations("common");
  const [savedValue, setSavedValue] = useState(limit);
  const [value, setValue] = useState(limit === null ? "" : String(limit));
  const [saved, setSaved] = useState(false);
  const { pending, error, run } = useAction();
  const parsed = parseAiMonthlyLimit(value.trim());
  const valid = parsed !== undefined;
  const dirty = valid && parsed !== savedValue;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!dirty) return;
        setSaved(false);
        run(
          () => updateWorkspaceSettingsAction(workspaceId, { aiMonthlyLimitUsd: parsed }),
          () => {
            setSavedValue(parsed);
            setValue(parsed === null ? "" : String(parsed));
            setSaved(true);
          },
        );
      }}
    >
      <SettingsRow
        title={t("limit")}
        htmlFor="ai-monthly-limit"
        description={
          error ? (
            <span className="text-danger">{error}</span>
          ) : !valid ? (
            <span className="text-danger">{t("limitInvalid", { max: MAX_AI_MONTHLY_LIMIT_USD })}</span>
          ) : saved ? (
            tc("saved")
          ) : (
            description
          )
        }
        control={
          <>
            <div className="relative w-full sm:w-36">
              <span className="pointer-events-none absolute inset-y-0 start-3 flex items-center text-sm text-fg-muted" aria-hidden>
                $
              </span>
              <Input
                id="ai-monthly-limit"
                type="number"
                inputMode="decimal"
                min={0.01}
                max={MAX_AI_MONTHLY_LIMIT_USD}
                step={0.01}
                value={value}
                placeholder={t("noLimit")}
                aria-invalid={!valid}
                className="w-full ps-7"
                onChange={(e) => {
                  setValue(e.target.value);
                  setSaved(false);
                }}
              />
            </div>
            <Button type="submit" variant="primary" disabled={!dirty || pending}>
              {pending ? tc("saving") : tc("save")}
            </Button>
          </>
        }
      />
    </form>
  );
}
