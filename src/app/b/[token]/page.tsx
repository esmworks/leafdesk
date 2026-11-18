import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { cache } from "react";
import { PublicBooking } from "@/components/published/public-booking";
import { SourceFooter } from "@/components/published/source-footer";
import { CLIENT_IP_HEADER } from "@/lib/client-ip";
import { BookingError, getPublicBooking, issueBookingTicket } from "@/server/booking";

type Params = { params: Promise<{ token: string }> };

// Every visit gets a fresh ticket (see issueBookingTicket) and the slots as they are now.
export const dynamic = "force-dynamic";

const load = cache(async (token: string) => {
  const ip = (await headers()).get(CLIENT_IP_HEADER) ?? "unknown";
  try {
    const booking = await getPublicBooking(token, { ip });
    if (!booking) notFound();
    return booking;
  } catch (error) {
    if (error instanceof BookingError && error.code === "rateLimited") return "busy" as const;
    throw error;
  }
});

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { token } = await params;
  const [booking, t] = await Promise.all([load(token), getTranslations("calendar.booking.public")]);
  return { title: booking === "busy" ? t("busyTitle") : booking.title };
}

export default async function PublicBookingRoute({ params }: Params) {
  const { token } = await params;
  const [booking, t] = await Promise.all([load(token), getTranslations("calendar.booking.public")]);

  return (
    <div className="flex min-h-full flex-col bg-bg text-fg">
      <header className="flex h-11 items-center justify-end border-b border-border px-3">
        <Link href="/" className="text-sm font-semibold tracking-tight text-fg-faint hover:text-fg-muted">
          leafdesk
        </Link>
      </header>
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 pt-10 pb-16 sm:pt-14">
        {booking === "busy" ? (
          <div>
            <h1 className="page-title text-3xl leading-tight tracking-tight">{t("busyTitle")}</h1>
            <p className="mt-3 text-sm text-fg-muted">{t("busyBody")}</p>
          </div>
        ) : (
          <PublicBooking booking={booking} ticket={issueBookingTicket(token)} />
        )}
      </main>
      <SourceFooter />
    </div>
  );
}
