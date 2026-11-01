"use client";

import { useState } from "react";
import { UserAvatar } from "@/components/user-avatar";
import type { MailSenderMark } from "@/lib/mail-client";
import { userColor } from "@/lib/presence";

/**
 * The mark beside a conversation of the Mail list (lib/sender-marks.ts): the logo of the domain its
 * other party's mail verifiably came from, on a square as brands draw them; else a member's own
 * picture, or the initial of their name on a tint of a color their address always gets.
 */
export function SenderMark({ mark }: { mark: MailSenderMark }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (mark.logo && failed !== mark.logo) {
    const logo = mark.logo;
    return (
      <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-white">
        <img src={logo} alt="" className="h-full w-full object-contain" onError={() => setFailed(logo)} />
      </span>
    );
  }
  const color = userColor(mark.address);
  return (
    <UserAvatar
      name={mark.name || mark.address}
      image={mark.image}
      size="lg"
      colors="font-semibold"
      style={{ backgroundColor: `color-mix(in oklab, ${color} 22%, var(--bg))`, color: `color-mix(in oklab, ${color} 70%, var(--fg))` }}
    />
  );
}
