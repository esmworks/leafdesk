import { getTranslations } from "next-intl/server";
import type { ExportLabels } from "@/server/export";

/** Labels exported Markdown uses, in the reader's language (route handlers only). */
export async function exportLabels(): Promise<ExportLabels> {
  const [tm, te, tc, ts, ta, tb] = await Promise.all([
    getTranslations("page.mention"),
    getTranslations("page.embed"),
    getTranslations("common"),
    getTranslations("page.syncedBlock"),
    getTranslations("page.agentChat"),
    getTranslations("page.button"),
  ]);
  const note = (state: "noAccess" | "trashed" | "deleted" | "removed") => ts("exportNote", { state: ts(`state.${state}`) });
  return {
    untitled: tc("untitled"),
    noAccess: tm("noAccess"),
    deleted: tm("deleted"),
    unavailable: te("unavailable"),
    synced: { noAccess: note("noAccess"), trashed: note("trashed"), deleted: note("deleted"), removed: note("removed") },
    agentChat: (name) => (name ? ta("exportLine", { name }) : ta("label")),
    button: (label) => tb("blockLabel", { label: label || tb("untitled") }),
  };
}
