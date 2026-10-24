import Link from "next/link";
import type { SiteHeaderItem } from "@/server/site";

const cn = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(" ");

/** The links a site's owner put in its header: pages of the site, or web addresses (text only). */
export function SiteHeaderLinks({ links, label, className }: { links: SiteHeaderItem[]; label: string; className?: string }) {
  const item = "inline-flex h-7 max-w-48 items-center truncate rounded-md px-2 text-sm text-fg-muted hover:bg-bg-hover hover:text-fg";
  return (
    <nav aria-label={label} className={cn("items-center gap-0.5", className)}>
      {links.map((link, i) =>
        link.external ? (
          <a key={i} href={link.href} rel="noreferrer" className={item}>
            {link.label}
          </a>
        ) : (
          <Link key={i} href={link.href} className={item}>
            {link.label}
          </Link>
        ),
      )}
    </nav>
  );
}
