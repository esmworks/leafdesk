/**
 * Liveness for container probes and load balancers: `GET /api/health` answers 200 whenever the
 * server handles requests. It reads no session or database and says nothing about the instance.
 * Readiness, with the database, is /api/health/ready.
 */
function handle() {
  return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}

export const dynamic = "force-dynamic";

export { handle as GET, handle as HEAD };
