import { decodeRead, encodeRead } from "@/lib/read-wire";
import { READS } from "../reads";

export const dynamic = "force-dynamic";

/**
 * One of READS (../reads.ts), with its arguments as the request body. Only from the app's own
 * pages, as Next checks for server actions: the request's Origin must be the address it came to.
 */
export async function POST(request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  if (!Object.hasOwn(READS, name)) return new Response(null, { status: 404 });
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host")?.split(",")[0].trim() || request.headers.get("host");
  if (!origin || !host || new URL(origin).host !== host) return new Response(null, { status: 403 });

  let args: unknown;
  try {
    args = decodeRead(await request.text());
  } catch {
    return new Response(null, { status: 400 });
  }
  if (!Array.isArray(args)) return new Response(null, { status: 400 });
  try {
    const read = READS[name as keyof typeof READS] as (...args: unknown[]) => Promise<unknown>;
    return new Response(encodeRead(await read(...args)), {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch (error) {
    // requireUserId's, for a session that ended.
    if (error instanceof Error && error.message === "Unauthorized") return new Response(null, { status: 401 });
    console.error(`read ${name}:`, error);
    return new Response(null, { status: 500 });
  }
}
