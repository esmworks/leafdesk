import { auth } from "@/lib/auth";
import { MAX_SNIPPET_IMPORT_BYTES, SnippetError } from "@/lib/snippets";
import { AccessError } from "@/server/access";
import { isCrossSite } from "@/server/cross-site";
import { BodyTooLargeError, readBodyLimited } from "@/server/request-body";
import { importSnippets } from "@/server/snippets";

/**
 * Imports snippets (see server/snippets.ts importSnippets): `POST /api/snippets/import` with the
 * file's JSON as the body, into the person's own snippets, or with `?workspaceId=` into the
 * workspace's (owners only). Answered with `{ added, skipped: [{ trigger, reason }] }`, or
 * `{ error, code }`. A route rather than a server action: a full export can be larger than an
 * action takes.
 *
 * Requests need the `X-Leafdesk-Import` header: a cross-site form can't send it, and a cross-site
 * fetch with it needs a CORS preflight this route doesn't answer. A foreign Origin is refused too.
 */
export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
  if (!session) return fail(401, "accessDenied", "Sign in to import snippets");
  if (isCrossSite(request, "x-leafdesk-import")) return fail(403, "accessDenied", "Cross-site imports aren't allowed");
  const workspaceId = new URL(request.url).searchParams.get("workspaceId");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(await readBodyLimited(request, MAX_SNIPPET_IMPORT_BYTES));
  } catch (error) {
    if (error instanceof BodyTooLargeError) return fail(413, "importTooLarge", "The file is too large");
    return fail(400, "importInvalid", "The file isn't UTF-8 text");
  }
  try {
    const result = await importSnippets(session.user.id, workspaceId ? { kind: "workspace", workspaceId } : { kind: "personal" }, text);
    return Response.json({ added: result.added.length, skipped: result.skipped }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof SnippetError) return fail(error.code === "ownersOnly" ? 403 : 400, error.code, error.message);
    if (error instanceof AccessError) return fail(403, "accessDenied", "No access to this workspace");
    throw error;
  }
}

function fail(status: number, code: string, error: string) {
  return Response.json({ error, code }, { status, headers: { "Cache-Control": "no-store" } });
}
