"use client";

import Link from "next/link";
import type { ComponentProps } from "react";
import { openInbox } from "@/lib/inbox-event";

/**
 * What a Calendar item opens: its page, or, for a reminder about no page (`href` null), the inbox's
 * Scheduled tab, where it can be moved or cancelled too. A link either way, so it drags alike.
 */
export function ItemLink({ href, onClick, ...props }: Omit<ComponentProps<typeof Link>, "href"> & { href: string | null }) {
  if (href) return <Link href={href} onClick={onClick} {...props} />;
  return (
    <a
      href="#scheduled"
      onClick={(e) => {
        onClick?.(e);
        e.preventDefault();
        openInbox("scheduled");
      }}
      {...props}
    />
  );
}
