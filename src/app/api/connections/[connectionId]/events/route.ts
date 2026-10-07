import { receiveEvent } from "@/server/connections/events";

/** A connection's events (see server/connections/events): signed POSTs from the service. */
export async function POST(request: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  const { connectionId } = await params;
  const result = await receiveEvent(connectionId, request).catch((error: unknown) => {
    console.error("[connections] could not take an event", error);
    return { status: 500, body: { error: "The event could not be taken" } };
  });
  return Response.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}
