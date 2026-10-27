import { env } from "@/lib/env";
import { unsubscribeWithToken } from "@/server/dashboard-emails";

/**
 * Leaving a dashboard email (server/dashboard-emails) through its signed link, without signing in:
 * the unsubscribe page's button posts here, as do mail apps' own unsubscribe buttons (RFC 8058
 * one-click, `List-Unsubscribe-Post`). Only POST changes anything: link checkers that open the
 * email's link only reach the page.
 */
export async function POST(request: Request) {
  const url = new URL(request.url);
  let token = url.searchParams.get("token");
  let fromPage = false;
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data")) {
    const form = await request.formData().catch(() => null);
    token = (form?.get("token") as string | null) ?? token;
    fromPage = form?.get("from") === "page";
  }
  const done = await unsubscribeWithToken(token);
  if (fromPage) {
    const back = new URL("/dashboard-emails/unsubscribe", env.appUrl);
    back.searchParams.set("token", token ?? "");
    if (done) back.searchParams.set("done", "1");
    return Response.redirect(back, 303);
  }
  return new Response(null, { status: done ? 200 : 400, headers: { "Cache-Control": "no-store" } });
}

export const dynamic = "force-dynamic";
