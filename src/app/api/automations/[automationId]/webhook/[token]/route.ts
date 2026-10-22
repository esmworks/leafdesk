import { redactError } from "@/lib/redact";
import { receiveHook } from "@/server/automations/incoming";

/** An automation's incoming webhook (see server/automations/incoming): a JSON POST starts a run. */
export async function POST(request: Request, { params }: { params: Promise<{ automationId: string; token: string }> }) {
  const { automationId, token } = await params;
  const result = await receiveHook(automationId, token, request).catch((error: unknown) => {
    console.error("[automations] could not take a webhook", redactError(error));
    return { status: 500, body: { error: "The request could not be taken" }, headers: undefined };
  });
  return Response.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store", ...result.headers } });
}
