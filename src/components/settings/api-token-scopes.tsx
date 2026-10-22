"use client";

import { useTranslations } from "next-intl";
import { useId } from "react";
import {
  API_SCOPE_RESOURCES,
  normalizeScopes,
  presetOf,
  readScopeOf,
  SCOPE_PRESETS,
  writeScopeOf,
  type ApiTokenScope,
} from "@/lib/api-scopes";
import { Button, cn, Switch } from "@/components/ui";

/**
 * Chooses what a token may do: read and write toggles per resource, and the two presets. Turning
 * write on turns read on with it, as the server stores it; read can't be turned off under write.
 */
export function ApiTokenScopePicker({
  value,
  onChange,
  disabled,
}: {
  value: ApiTokenScope[];
  onChange: (scopes: ApiTokenScope[]) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("apiTokens.scopes");
  const ids = useId();
  const chosen = new Set(value);
  const preset = presetOf(value);
  const set = (scope: ApiTokenScope, on: boolean, also?: ApiTokenScope | null) => {
    const next = new Set(chosen);
    if (on) next.add(scope);
    else {
      next.delete(scope);
      if (also) next.delete(also);
    }
    onChange(normalizeScopes([...next]));
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {(["readAll", "all"] as const).map((name) => (
          <Button
            key={name}
            size="sm"
            disabled={disabled}
            aria-pressed={preset === name}
            className={cn(preset === name && "ring-1 ring-accent ring-inset")}
            onClick={() => onChange([...SCOPE_PRESETS[name]])}
          >
            {t(`presets.${name}`)}
          </Button>
        ))}
      </div>
      <ul className="divide-y divide-border rounded-md border border-border" data-api-token-scopes>
        {API_SCOPE_RESOURCES.map(({ resource }) => {
          const read = readScopeOf(resource);
          const write = writeScopeOf(resource);
          const writing = write !== null && chosen.has(write);
          return (
            <li key={resource} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <span id={`${ids}-${resource}`} className="block text-sm">
                  {t(`resources.${resource}.name`)}
                </span>
                <span className="block text-xs text-fg-muted">{t(`resources.${resource}.hint`)}</span>
              </div>
              <label className="flex shrink-0 items-center gap-1.5 text-xs text-fg-muted">
                <Switch
                  checked={chosen.has(read)}
                  disabled={disabled || writing}
                  label={t("toggle", { resource: t(`resources.${resource}.name`), access: t("read") })}
                  onChange={(on) => set(read, on, write)}
                />
                <span aria-hidden>{t("read")}</span>
              </label>
              <div className="flex w-[4.75rem] shrink-0 items-center gap-1.5 text-xs text-fg-muted">
                {write && (
                  <>
                    <Switch
                      checked={writing}
                      disabled={disabled}
                      label={t("toggle", { resource: t(`resources.${resource}.name`), access: t("write") })}
                      onChange={(on) => set(write, on)}
                    />
                    <span aria-hidden>{t("write")}</span>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
