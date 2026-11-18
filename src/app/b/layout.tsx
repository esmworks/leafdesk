import type { Metadata } from "next";

/**
 * Booking links (`/b/<token>`): anyone with the link can pick a free time, signed in or not (see
 * server/booking.ts). Kept out of search engines, and the token in the URL is not sent as a
 * referrer to other sites.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: "same-origin",
};

export default function PublicBookingLayout({ children }: { children: React.ReactNode }) {
  return children;
}
