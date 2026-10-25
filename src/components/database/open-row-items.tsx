"use client";

import { AppWindow, ExternalLink, PanelRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { MenuItem } from "@/components/ui";
import type { RowOpener } from "./row-panel-context";

/** "Open" in a row's or card's menu, and "Open as full page" while the view opens rows beside it. */
export function OpenRowItems({ opener, rowId, onDone }: { opener: RowOpener; rowId: string; onDone: () => void }) {
  const t = useTranslations("database.rowMenu");
  return (
    <>
      <MenuItem
        icon={
          opener.centered ? (
            <AppWindow className="h-3.5 w-3.5" />
          ) : opener.inPanel ? (
            <PanelRight className="h-3.5 w-3.5 rtl:-scale-x-100" />
          ) : (
            <ExternalLink className="h-3.5 w-3.5" />
          )
        }
        onClick={() => {
          onDone();
          opener.open(rowId);
        }}
      >
        {t("open")}
      </MenuItem>
      {opener.inPanel && (
        <MenuItem
          icon={<ExternalLink className="h-3.5 w-3.5" />}
          onClick={() => {
            onDone();
            opener.openPage(rowId);
          }}
        >
          {t("openPage")}
        </MenuItem>
      )}
    </>
  );
}
