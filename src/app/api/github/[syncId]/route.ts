import { redactError } from "@/lib/redact";
import { receiveGithub } from "@/server/github-sync/receive";

/** GitHub's deliveries for a database's setup (see server/github-sync/receive): signed POSTs. */
export async function POST(request: Request, { params }: { params: Promise<{ syncId: string }> }) {
  const { syncId } = await params;
  const result = await receiveGithub(syncId, request).catch((error: unknown) => {
    console.error("[github] could not take a delivery", redactError(error));
    return { status: 500, body: { error: "The delivery could not be taken" } };
  });
  return Response.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}
