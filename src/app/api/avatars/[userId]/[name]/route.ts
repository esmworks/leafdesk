import { auth } from "@/lib/auth";
import { AVATAR_TYPES, avatarStorageKey, parseAvatarParts } from "@/lib/avatar";
import { instanceStorage } from "@/server/storage";

/**
 * Serves an uploaded profile picture (see lib/avatar.ts) to signed-in people: they show next to
 * names in member lists, comments, mentions and presence. The name is random and changes with
 * every upload, so the bytes behind a URL never change; a replaced picture is removed from
 * storage and its URL answers 404.
 */
const HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy": "default-src 'none'; sandbox",
};

function notFound(status = 404) {
  return new Response("Not found", { status, headers: { ...HEADERS, "Cache-Control": "no-store", "Content-Type": "text/plain" } });
}

export async function GET(request: Request, { params }: { params: Promise<{ userId: string; name: string }> }) {
  const { userId, name } = await params;
  const avatar = parseAvatarParts(userId, name);
  if (!avatar) return notFound();
  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
  if (!session) return notFound(401);
  const etag = `"${name}"`;
  const headers = {
    ...HEADERS,
    "Content-Type": AVATAR_TYPES[avatar.format],
    "Cache-Control": "private, max-age=31536000, immutable",
    ETag: etag,
  };
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  const body = await instanceStorage().get(avatarStorageKey(userId, name));
  if (!body) return notFound();
  return new Response(body, { status: 200, headers });
}
