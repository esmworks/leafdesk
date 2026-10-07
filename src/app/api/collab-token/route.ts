import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { avatarSrc } from "@/lib/avatar";
import { serverBuildId } from "@/server/build-id";
import { issueCollabToken } from "@/server/collab/token";

export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  return Response.json(
    {
      token: issueCollabToken(session.user.id, session.user.name, session.session.id, avatarSrc(session.user.image)),
      // A tab checks it against its own before it loads a page's offline copy (components/collab/freshness).
      build: serverBuildId(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
