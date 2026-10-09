import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { encodeSharedNote, SHARED_COOKIE, SHARED_COOKIE_PATH } from "@/lib/shared-note";

/** How long what was shared waits for the quick note page (a sign-in in between, say). */
const SHARED_MAX_AGE_S = 10 * 60;

/**
 * The installed app's share target (app/manifest.ts): `POST /api/share` with the shared `title`,
 * `text` and `url` as a form. They go to the quick note page in a cookie only that page gets, not in
 * its address, so they stay out of server logs and a sign-in's `next` link. A post from anywhere
 * else can do no more than fill that page's fields, as a link to it could; saving is the person's.
 */
export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  const field = (name: string) => {
    const value = form?.get(name);
    return typeof value === "string" ? value.trim() : "";
  };
  // A relative address: the page is on the host the cookie is set for, whatever host that is.
  const response = new NextResponse(null, { status: 303, headers: { Location: "/share", "Cache-Control": "no-store" } });
  const note = { title: field("title"), text: field("text"), url: field("url") };
  if (note.title || note.text || note.url) {
    response.cookies.set(SHARED_COOKIE, encodeSharedNote(note), {
      path: SHARED_COOKIE_PATH,
      maxAge: SHARED_MAX_AGE_S,
      sameSite: "lax",
      secure: env.appUrl.startsWith("https:"),
    });
  }
  return response;
}
