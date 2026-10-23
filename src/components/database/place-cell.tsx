"use client";

import { MapPin } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/components/ui";
import { asPlace, placeLabel, placeMapHref, type PlaceValue } from "@/lib/place";

/**
 * Place properties: the place's name (or address) wherever values show, with a small link that
 * opens it on the map. The editor is in place-editor.tsx, loaded when a place is first edited.
 */

/** A small pin that opens the place on the map, in a new tab. */
export function PlaceMapLink({ place, className }: { place: PlaceValue; className?: string }) {
  const t = useTranslations("database.place");
  return (
    <a
      href={placeMapHref(place)}
      target="_blank"
      rel="noreferrer noopener"
      title={t("openMap")}
      aria-label={t("openMap")}
      onClick={(e) => e.stopPropagation()}
      className={cn("inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-faint hover:bg-bg-hover hover:text-fg", className)}
    >
      <MapPin className="h-3.5 w-3.5" />
    </a>
  );
}

/** A place as a cell shows it; `wrap` (row panels, published pages) adds the address under a name. */
export function PlaceDisplay({ value, wrap }: { value: unknown; wrap?: boolean }) {
  const place = asPlace(value);
  if (!place) return null;
  const label = placeLabel(place);
  return (
    <span className="flex min-w-0 items-center gap-1" title={place.name ? `${place.name}, ${place.address}` : place.address}>
      <span className={cn("min-w-0", wrap ? "flex flex-col" : "truncate")}>
        <span className={wrap ? "break-words" : undefined}>{label}</span>
        {wrap && place.name && <span className="text-xs break-words text-fg-muted">{place.address}</span>}
      </span>
      <PlaceMapLink place={place} />
    </span>
  );
}
