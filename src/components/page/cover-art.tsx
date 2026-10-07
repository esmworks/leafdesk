import { COVER_GRADIENTS, coverObjectPosition, type PageCover } from "@/lib/page-cover";

/**
 * A page's cover as read-only pages show it: published pages and the print view. No hooks, so
 * server components render it too. The page itself uses PageCoverBanner, which also edits it.
 */
export function CoverArt({ cover, className }: { cover: PageCover; className?: string }) {
  return (
    <div
      // Browsers leave backgrounds out of print unless told to keep them.
      className={["w-full overflow-hidden bg-bg-subtle [print-color-adjust:exact]", className].filter(Boolean).join(" ")}
      style={cover.kind === "gradient" ? { background: COVER_GRADIENTS[cover.gradient] } : undefined}
    >
      {cover.kind === "image" && (
        <img
          src={cover.url}
          alt=""
          decoding="async"
          referrerPolicy="no-referrer"
          className="h-full w-full object-cover"
          style={{ objectPosition: coverObjectPosition(cover.y) }}
        />
      )}
    </div>
  );
}
