"use client";

import { useEffect, useRef } from "react";
import { buttonClass } from "@/components/ui";

/** Opens the app once on its own; the button is for a browser that asks first or a second try. */
export function OpenAppLink({ href, label }: { href: string; label: string }) {
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    window.location.href = href;
  }, [href]);
  return (
    <a href={href} className={`${buttonClass({ variant: "primary" })} w-full`}>
      {label}
    </a>
  );
}
