import { auth } from "@/lib/auth";
import { MAX_LOGO_BYTES } from "@/lib/letterheads";
import { isCrossSite } from "@/server/cross-site";
import { LetterheadError, letterheadLogo, setLetterheadLogo } from "@/server/letterheads";

/**
 * A letterhead's logo (server/letterheads.ts). GET serves it to the workspace's members (Settings
 * shows it; PDFs read it from the database, not from here): its URL carries `?v=` the logo's
 * version, so the bytes behind a URL never change. PUT puts one up, the raw PNG or JPEG as the
 * body, and DELETE takes it off; owners only. Both answer with the letterhead, or `{error}` with a
 * LetterheadError code. A cross-site page can't send either (PUT and DELETE need a preflight this
 * route doesn't answer), and a foreign Origin is refused.
 */
const HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy": "default-src 'none'; sandbox",
};

type Params = { params: Promise<{ letterheadId: string }> };

async function userOf(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
  return session?.user.id ?? null;
}

export async function GET(request: Request, { params }: Params) {
  const userId = await userOf(request);
  const { letterheadId } = await params;
  const logo = userId ? await letterheadLogo(userId, letterheadId) : null;
  if (!logo) return new Response("Not found", { status: 404, headers: { ...HEADERS, "Cache-Control": "no-store", "Content-Type": "text/plain" } });
  return new Response(new Uint8Array(logo.bytes), {
    headers: { ...HEADERS, "Content-Type": logo.type, "Cache-Control": "private, max-age=31536000, immutable" },
  });
}

/** The body, up to `limit` bytes; null when it is longer. */
async function readBody(request: Request, limit: number): Promise<Buffer | null> {
  if (!request.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function change(request: Request, { params }: Params, put: boolean) {
  const userId = await userOf(request);
  if (!userId) return Response.json({ error: "notFound" }, { status: 401 });
  if (isCrossSite(request)) return Response.json({ error: "notFound" }, { status: 403 });
  const { letterheadId } = await params;
  try {
    let bytes: Buffer | null = null;
    if (put) {
      const length = Number(request.headers.get("content-length") ?? 0);
      bytes = length > MAX_LOGO_BYTES ? null : await readBody(request, MAX_LOGO_BYTES);
      if (!bytes) return Response.json({ error: "logoSize" }, { status: 413 });
    }
    return Response.json(await setLetterheadLogo(userId, letterheadId, bytes), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof LetterheadError) return Response.json({ error: error.code }, { status: error.code === "notFound" ? 404 : 400 });
    throw error;
  }
}

export const PUT = (request: Request, context: Params) => change(request, context, true);
export const DELETE = (request: Request, context: Params) => change(request, context, false);
