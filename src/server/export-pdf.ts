import { and, inArray, sql } from "drizzle-orm";
import { Zip, ZipPassThrough } from "fflate";
import { db } from "@/db";
import { page } from "@/db/schema";
import { MAX_PDF_EXPORT_PAGES } from "@/lib/export-pdf-limits";
import {
  attachment,
  ENGLISH_EXPORT_LABELS,
  ExportError,
  planExport,
  recordExport,
  zipTime,
  type ExportLabels,
  type ExportPlan,
} from "@/server/export";
import { pagePdf } from "@/server/pdf";

/**
 * A whole workspace as a ZIP of PDFs (Settings > Export, "PDF"): one PDF per page the owner can see,
 * made the way the page menu's Export as PDF makes one (server/pdf.ts, in the workspace's default
 * letterhead), in folders that follow the page tree as the Markdown export's do. A database is one
 * PDF of its rows as a table; a row gets a PDF of its own (its values listed under its title) only
 * when its body holds something, since the table shows the rest. Templates are left out, and so
 * are uploaded files: the PDFs show the images they hold.
 *
 * Each page is laid out and drawn on the server, so it holds at most MAX_PDF_EXPORT_PAGES PDFs, and
 * the archive is streamed as they are made, one at a time. A page that can't be drawn is left out
 * (and logged) rather than failing the archive. The export is recorded once in the audit log.
 */


export type PdfExportPlan = ExportPlan & {
  /** The pages that become PDFs, in the plan's order, with whether each is a database row. */
  pdfs: { id: string; row: boolean; path: string; updatedAt: Date }[];
};

/** What a PDF export of the workspace holds for `userId`; ExportError when over the limits. Owners only. */
export async function planPdfExport(userId: string, workspaceId: string, labels: ExportLabels = ENGLISH_EXPORT_LABELS): Promise<PdfExportPlan> {
  const plan = await planExport(userId, { workspaceId }, labels, { files: false });
  const kinds = new Map(plan.pages.map((p) => [p.id, p.kind]));
  const live = plan.pages.filter((p) => !p.isTemplate);
  const rows = live.filter((p) => p.parentId !== null && kinds.get(p.parentId) === "database").map((p) => p.id);
  const withBody = new Set<string>();
  for (let i = 0; i < rows.length; i += 5000) {
    const found = await db
      .select({ id: page.id })
      .from(page)
      .where(and(inArray(page.id, rows.slice(i, i + 5000)), sql`length(btrim(coalesce(${page.contentMarkdown}, ''))) > 0`));
    for (const { id } of found) withBody.add(id);
  }
  const isRow = new Set(rows);
  const pdfs = live
    .filter((p) => !isRow.has(p.id) || withBody.has(p.id))
    .map((p) => ({ id: p.id, row: isRow.has(p.id), path: pdfPath(plan.layout.paths.get(p.id)!), updatedAt: p.updatedAt }));
  if (pdfs.length > MAX_PDF_EXPORT_PAGES) throw new ExportError("tooManyPages", MAX_PDF_EXPORT_PAGES);
  return { ...plan, pdfs };
}

/** A page's place in the Markdown export, as a PDF: `Notes.md` → `Notes.pdf`, `Tasks.csv` → `Tasks.pdf`. */
export function pdfPath(path: string) {
  return path.replace(/\.(md|csv)$/, ".pdf");
}

/** The archive for `plan`, streamed as each PDF is made; `onDone` runs once it is sent, failed or cancelled. */
export function pdfArchive(userId: string, plan: PdfExportPlan, { onDone }: { onDone?: () => void } = {}): ReadableStream<Uint8Array> {
  const queue: Uint8Array[] = [];
  let zipError: Error | null = null;
  const zip = new Zip((error, chunk) => {
    if (error) zipError = error;
    else if (chunk.length) queue.push(chunk);
  });

  async function* build(): AsyncGenerator<void> {
    for (const target of plan.pdfs) {
      const pdf = await pagePdf(userId, target.id, { properties: target.row, record: false }).catch((error: unknown) => {
        console.error(`[export] couldn't make the PDF of ${target.id}`, error);
        return null;
      });
      if (pdf) {
        // PDFs are compressed already: stored as they are.
        const entry = new ZipPassThrough(target.path);
        entry.mtime = zipTime(target.updatedAt);
        zip.add(entry);
        entry.push(new Uint8Array(pdf.bytes), true);
      }
      yield;
    }
    zip.end();
  }

  const steps = build();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    onDone?.();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (!queue.length) {
          const { done } = await steps.next();
          if (zipError) throw zipError;
          if (done) {
            while (queue.length) controller.enqueue(queue.shift()!);
            controller.close();
            finish();
            return;
          }
        }
        while (queue.length) controller.enqueue(queue.shift()!);
      } catch (error) {
        console.error("[export] PDF archive failed", error);
        controller.error(error);
        finish();
      }
    },
    async cancel() {
      await steps.return(undefined).catch(() => {});
      finish();
    },
  });
}

/** The response streaming the PDF archive, holding the export slot until it is sent; recorded first. */
export async function pdfArchiveResponse(userId: string, plan: PdfExportPlan, release: () => void) {
  await recordExport(userId, { workspaceId: plan.workspaceId, page: null, format: "pdf", pages: plan.pdfs.length });
  return new Response(pdfArchive(userId, plan, { onDone: release }), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": attachment(`${plan.title} PDF`, "zip"),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** What a dry run reports for a PDF export. */
export const pdfPlanSummary = (plan: PdfExportPlan) => ({ ok: true, pages: plan.pdfs.length, files: 0, fileBytes: 0 });
