import { readiness } from "@/server/health";

/**
 * Readiness (see server/health): `GET /api/health/ready` answers 200 once the database answers
 * and has the newest migration, else 503 with which check failed, in generic words. No session.
 */
async function handle() {
  const { ready, checks } = await readiness();
  const headers = { "Cache-Control": "no-store" };
  if (ready) return Response.json({ status: "ok" }, { headers });
  return Response.json({ status: "unavailable", checks }, { status: 503, headers });
}

export const dynamic = "force-dynamic";

export { handle as GET, handle as HEAD };
