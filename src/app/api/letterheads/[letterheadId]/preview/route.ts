import { getTranslations } from "next-intl/server";
import { auth } from "@/lib/auth";
import { LetterheadError } from "@/server/letterheads";
import { letterheadPreviewPdf } from "@/server/pdf";

/**
 * A letterhead's PDF on a sample page (server/pdf.ts letterheadPreviewPdf), for its workspace's
 * owners: Settings shows it in a frame beside the theme being edited. `?v=` changes with each save,
 * so the frame reloads; the answer itself is never cached.
 */
type Params = { params: Promise<{ letterheadId: string }> };

export async function GET(request: Request, { params }: Params) {
  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
  const notFound = () => new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
  if (!session) return notFound();
  const { letterheadId } = await params;
  const t = await getTranslations("settings.letterheads.preview");
  try {
    const bytes = await letterheadPreviewPdf(session.user.id, letterheadId, {
      title: t("title"),
      text: t("text"),
      item: t("item"),
      quantity: t("quantity"),
      price: t("price"),
      amount: t("amount"),
      rows: [t("row1"), t("row2"), t("row3")],
    });
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": "inline",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
      },
    });
  } catch (error) {
    if (error instanceof LetterheadError) return notFound();
    throw error;
  }
}
