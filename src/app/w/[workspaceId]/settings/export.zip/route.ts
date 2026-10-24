import { AccessError } from "@/server/access";
import {
  archiveResponse,
  ExportError,
  exportErrorResponse,
  exportRunning,
  planExport,
  planSummary,
  startExport,
} from "@/server/export";
import { exportLabels } from "@/server/export-labels";
import { pdfArchiveResponse, pdfPlanSummary, planPdfExport } from "@/server/export-pdf";
import { blockedByWorkspacePolicy, getSession, policyRefusal } from "@/server/session";

/**
 * The whole workspace as a ZIP of Markdown, CSV and uploaded files (see server/export), for owners;
 * anyone else gets 404 so the workspace's existence doesn't leak. Holds the pages the owner can
 * view. `?format=pdf`: a ZIP of PDFs instead, one per page (see server/export-pdf). `?check=1` only
 * answers whether the export can be made (JSON), for the settings page.
 */
export async function GET(request: Request, { params }: { params: Promise<{ workspaceId: string }> }) {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });
  const userId = session.user.id;
  const { workspaceId } = await params;
  const hold = await blockedByWorkspacePolicy(session, workspaceId);
  if (hold) return new Response(policyRefusal(hold), { status: 403 });
  const search = new URL(request.url).searchParams;
  try {
    const labels = await exportLabels();
    if (search.get("format") === "pdf") {
      if (search.get("check") === "1") {
        if (exportRunning(userId)) throw new ExportError("busy");
        return Response.json(pdfPlanSummary(await planPdfExport(userId, workspaceId, labels)), { headers: { "Cache-Control": "no-store" } });
      }
      const release = startExport(userId);
      try {
        const plan = await planPdfExport(userId, workspaceId, labels);
        plan.title = `${plan.title} ${new Date().toISOString().slice(0, 10)}`;
        return await pdfArchiveResponse(userId, plan, release);
      } catch (error) {
        release();
        throw error;
      }
    }
    if (search.get("check") === "1") {
      if (exportRunning(userId)) throw new ExportError("busy");
      return Response.json(planSummary(await planExport(userId, { workspaceId }, labels)), { headers: { "Cache-Control": "no-store" } });
    }
    const release = startExport(userId);
    try {
      const plan = await planExport(userId, { workspaceId }, labels);
      plan.title = `${plan.title} ${new Date().toISOString().slice(0, 10)}`;
      return await archiveResponse(userId, plan, labels, release);
    } catch (error) {
      release();
      throw error;
    }
  } catch (error) {
    if (error instanceof AccessError) return new Response("Not found", { status: 404 });
    if (error instanceof ExportError) return exportErrorResponse(error);
    throw error;
  }
}
