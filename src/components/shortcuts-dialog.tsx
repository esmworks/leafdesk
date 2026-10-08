"use client";

import { useTranslations } from "next-intl";
import { Fragment, useMemo } from "react";
import { Dialog } from "@/components/ui";
import { isMac, keyLabels, SHORTCUT_GROUPS, type Combo } from "@/lib/shortcuts";

/** The keyboard shortcuts (lib/shortcuts), in groups, with the keys this computer has. */
export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations("shortcuts");
  // Only drawn once opened, in the browser.
  const mac = useMemo(() => open && isMac(), [open]);
  return (
    <Dialog open={open} onClose={onClose} className="max-w-lg">
      <h2 className="border-b border-border px-4 py-3 text-sm font-medium">{t("title")}</h2>
      <div className="max-h-[70vh] space-y-4 overflow-y-auto px-4 py-3">
        {SHORTCUT_GROUPS.map((group) => (
          <section key={group.id} aria-labelledby={`shortcuts-${group.id}`}>
            <h3 id={`shortcuts-${group.id}`} className="mb-1 text-xs font-medium text-fg-muted">
              {t(`groups.${group.id}`)}
            </h3>
            <dl className="divide-y divide-border">
              {group.shortcuts.map((shortcut) => (
                <div key={shortcut.id} className="flex items-center justify-between gap-4 py-1.5 text-sm">
                  <dt className="min-w-0">{t(`items.${shortcut.id}`)}</dt>
                  <dd className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                    {shortcut.combos.map((combo, i) => (
                      <Fragment key={i}>
                        {i > 0 && <span className="text-xs text-fg-muted">{t("or")}</span>}
                        <Keys combo={combo} mac={mac} />
                      </Fragment>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}

function Keys({ combo, mac }: { combo: Combo; mac: boolean }) {
  return (
    <span className="flex items-center gap-0.5">
      {keyLabels(combo, mac).map((label, i) => (
        <kbd
          key={i}
          className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-bg-subtle px-1 font-sans text-xs text-fg-muted"
        >
          {label}
        </kbd>
      ))}
    </span>
  );
}
