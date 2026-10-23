"use client";

// Loaded only when a map view shows (database-page.tsx imports it lazily): Leaflet and its styles
// stay out of every other page.
import "leaflet/dist/leaflet.css";
import "./map-view.css";
import L from "leaflet";
import { ChevronRight, Maximize, Plus, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Button, cn, PageIcon } from "@/components/ui";
import { pageLabel } from "@/lib/labels";
import { asPlace, placeLabel, type MapTiles, type PlaceValue } from "@/lib/place";
import { isHiddenInView, optionOf, SELECT_COLORS } from "@/lib/properties";
import { viewPlaceProperty } from "@/lib/views";
import { RowValue, shownValues } from "./property-cell";
import { openRowProps, useRowOpener } from "./row-panel-context";
import type { Property, Row, View } from "./types";
import { mapColorProperty } from "./view-settings";

type Pin = { row: Row; place: PlaceValue };

/** The whole world, for a map without pins. */
const WORLD: L.LatLngExpression = [20, 0];
/** How close fitting the pins zooms in at most (one pin shows its neighbourhood, not one house). */
const FIT_MAX_ZOOM = 15;
const CARD_WIDTH = 288;

/** Text for HTML Leaflet writes itself (the attribution). */
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Rows on a map: each row with a value in the view's place property is a pin (colored by a select
 * or status when the view says so); clicking one opens a card with the row's title and the
 * properties the view shows, from where the row opens as in other views. Rows without a place are
 * listed under the map. The map fits itself to the pins whenever the set of rows changes.
 */
export default function MapView({
  workspaceId,
  view,
  properties,
  rows,
  tiles,
  readOnly,
  locked,
  onCreatePlaceProperty,
}: {
  workspaceId: string;
  view: View;
  properties: Property[];
  rows: Row[];
  /** The server's map tiles; null when maps are off there. */
  tiles: MapTiles | null;
  readOnly?: boolean;
  locked?: boolean;
  onCreatePlaceProperty: () => void;
}) {
  const t = useTranslations("database");
  const tc = useTranslations("common");
  const opener = useRowOpener(workspaceId);
  const placeProp = viewPlaceProperty(view.config, properties);
  const colorProp = mapColorProperty(view, properties);
  const cardProps = useMemo(
    () => properties.filter((p) => p.id !== placeProp?.id && !isHiddenInView(view, p)),
    [properties, placeProp?.id, view],
  );

  const { pins, unplaced } = useMemo(() => {
    const pins: Pin[] = [];
    const unplaced: Row[] = [];
    for (const row of rows) {
      const place = placeProp ? asPlace(row.properties[placeProp.id]) : null;
      if (place) pins.push({ row, place });
      else unplaced.push(row);
    }
    return { pins, unplaced };
  }, [rows, placeProp]);

  const box = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<L.Map | null>(null);
  const markers = useRef(new Map<string, L.Marker>());
  const [selected, setSelected] = useState<string | null>(null);
  const [showUnplaced, setShowUnplaced] = useState(false);

  // The map itself, made once per tile server (and taken down with the view).
  const tileUrl = tiles?.url;
  const attribution = tiles?.attribution ?? "";
  const attributionUrl = tiles?.attributionUrl ?? null;
  const zoomIn = t("map.zoomIn");
  const zoomOut = t("map.zoomOut");
  useEffect(() => {
    const el = box.current;
    if (!el || !tileUrl) return;
    const m = L.map(el, { zoomControl: false, attributionControl: false, worldCopyJump: true }).setView(WORLD, 2);
    L.control.zoom({ zoomInTitle: zoomIn, zoomOutTitle: zoomOut }).addTo(m);
    const credit = attributionUrl
      ? `<a href="${escapeHtml(attributionUrl)}" target="_blank" rel="noreferrer noopener">${escapeHtml(attribution)}</a>`
      : escapeHtml(attribution);
    const control = L.control.attribution({ prefix: false }).addTo(m);
    if (attribution) control.addAttribution(credit);
    L.tileLayer(tileUrl, { maxZoom: 19 }).addTo(m);
    m.on("click", () => setSelected(null));
    setMap(m);
    const known = markers.current;
    return () => {
      known.clear();
      m.remove();
      setMap(null);
    };
  }, [tileUrl, attribution, attributionUrl, zoomIn, zoomOut]);

  // Pins follow the rows: one marker per row with a place, in its option's color.
  useEffect(() => {
    if (!map) return;
    const layer = L.layerGroup().addTo(map);
    const made = new Map<string, L.Marker>();
    for (const { row, place } of pins) {
      const option = colorProp ? optionOf(colorProp, row.properties[colorProp.id]) : undefined;
      const color = option && (SELECT_COLORS as readonly string[]).includes(option.color) ? option.color : null;
      const title = `${pageLabel(row.title, tc("untitled"))}, ${placeLabel(place)}`;
      const marker = L.marker([place.lat, place.lng], {
        icon: L.divIcon({
          className: "leafdesk-pin-icon",
          html: `<span class="leafdesk-pin"${color ? ` style="--pin: var(--chart-${color})"` : ""}></span>`,
          iconSize: [24, 24],
          iconAnchor: [12, 26],
        }),
        title,
        alt: title,
        riseOnHover: true,
      });
      marker.on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        setSelected(row.id);
      });
      marker.addTo(layer);
      made.set(row.id, marker);
    }
    markers.current = made;
    return () => {
      layer.remove();
    };
  }, [map, pins, colorProp, tc]);

  // The selected pin stands out.
  useEffect(() => {
    for (const [id, marker] of markers.current) marker.getElement()?.classList.toggle("is-selected", id === selected);
  }, [selected, pins, map]);

  // Fitted to the pins when the map opens and whenever other rows come to show (a filter changed);
  // an edited place or a new color leaves the map where the person put it.
  const pinKey = useMemo(() => pins.map((p) => p.row.id).join(","), [pins]);
  const pinsRef = useRef(pins);
  pinsRef.current = pins;
  const fit = useCallback(() => {
    if (!map) return;
    const shown = pinsRef.current;
    if (!shown.length) map.setView(WORLD, 2);
    else map.fitBounds(L.latLngBounds(shown.map((p) => [p.place.lat, p.place.lng])), { padding: [48, 48], maxZoom: FIT_MAX_ZOOM });
  }, [map]);
  useEffect(() => {
    fit();
  }, [fit, pinKey]);

  // The card stays by its pin while the map moves.
  const pin = selected ? pins.find((p) => p.row.id === selected) : undefined;
  const [point, setPoint] = useState<{ x: number; y: number; width: number } | null>(null);
  useLayoutEffect(() => {
    if (!map || !pin) {
      setPoint(null);
      return;
    }
    const place = () => {
      const p = map.latLngToContainerPoint([pin.place.lat, pin.place.lng]);
      setPoint({ x: p.x, y: p.y, width: map.getSize().x });
    };
    place();
    map.on("move zoom resize", place);
    return () => {
      map.off("move zoom resize", place);
    };
  }, [map, pin]);

  if (!placeProp) {
    return (
      <div className="page-gutter">
        <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-border px-6 py-10">
          <div>
            <p className="text-sm font-medium">{t("map.needsPlaceTitle")}</p>
            <p className="mt-1 text-sm text-fg-muted">{t("map.needsPlaceBody")}</p>
          </div>
          {!readOnly && !locked && (
            <Button size="sm" onClick={onCreatePlaceProperty}>
              <Plus className="h-3.5 w-3.5" />
              {t("map.addPlaceProperty", { name: t("map.defaultPlaceProperty") })}
            </Button>
          )}
        </div>
      </div>
    );
  }

  const closeOnEscape = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      setSelected(null);
      markers.current.get(selected ?? "")?.getElement()?.focus();
    }
  };

  return (
    <div className="page-gutter pb-6">
      {tiles ? (
        <div className="relative isolate h-[min(70vh,640px)] min-h-72 overflow-hidden rounded-lg border border-border">
          <div ref={box} dir="ltr" role="region" aria-label={t("map.label", { property: placeProp.name })} className="leafdesk-map absolute inset-0" />
          <button
            type="button"
            onClick={fit}
            title={t("map.fit")}
            aria-label={t("map.fit")}
            className="absolute end-2.5 top-2.5 z-[1000] inline-flex h-[30px] w-[30px] items-center justify-center rounded-md border border-border bg-bg text-fg-muted shadow-sm hover:bg-bg-hover hover:text-fg"
          >
            <Maximize className="h-4 w-4" />
          </button>
          {pin && point && (
            <PinCard
              key={pin.row.id}
              pin={pin}
              point={point}
              props={cardProps}
              opener={opener}
              onClose={() => setSelected(null)}
              onKeyDown={closeOnEscape}
            />
          )}
        </div>
      ) : (
        <div role="status" className="rounded-lg border border-dashed border-border px-6 py-10 text-sm text-fg-muted">
          {t("map.off")}
        </div>
      )}
      {unplaced.length > 0 && (
        <div className="mt-3">
          <button
            type="button"
            aria-expanded={showUnplaced}
            onClick={() => setShowUnplaced((v) => !v)}
            className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-sm text-fg-muted hover:bg-bg-hover hover:text-fg"
          >
            <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", showUnplaced ? "rotate-90" : "rtl:rotate-180")} />
            {t("map.noLocation", { count: unplaced.length, property: placeProp.name })}
          </button>
          {showUnplaced && (
            <ul aria-label={t("map.noLocationTitle", { property: placeProp.name })} className="mt-1 grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-1.5">
              {unplaced.map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    {...openRowProps(opener, row.id)}
                    onClick={(e) => opener.open(row.id, e)}
                    className="flex w-full min-w-0 items-center gap-1.5 rounded-md border border-border bg-bg px-2 py-1.5 text-start text-sm hover:bg-bg-hover"
                  >
                    <PageIcon icon={row.icon} className="shrink-0" />
                    <span className="truncate">{pageLabel(row.title, tc("untitled"))}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** The card a pin opens: the row's title and shown properties, and the way to open the row. */
function PinCard({
  pin,
  point,
  props,
  opener,
  onClose,
  onKeyDown,
}: {
  pin: Pin;
  point: { x: number; y: number; width: number };
  props: Property[];
  opener: ReturnType<typeof useRowOpener>;
  onClose: () => void;
  onKeyDown: (e: ReactKeyboardEvent) => void;
}) {
  const t = useTranslations("database.map");
  const tc = useTranslations("common");
  const { row, place } = pin;
  const shown = shownValues(props, row);
  const label = pageLabel(row.title, tc("untitled"));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
  // Above the pin while there is room, else below it; never past the map's sides.
  const above = point.y > 220;
  const left = Math.min(Math.max(point.x, CARD_WIDTH / 2 + 8), Math.max(CARD_WIDTH / 2 + 8, point.width - CARD_WIDTH / 2 - 8));
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onClick={(e) => e.stopPropagation()}
      style={{ left, top: above ? point.y - 34 : point.y + 8, width: CARD_WIDTH }}
      className={cn(
        "absolute z-[1000] -translate-x-1/2 rounded-lg border border-border bg-bg p-3 shadow-lg outline-none",
        above && "-translate-y-full",
      )}
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          {...openRowProps(opener, row.id)}
          onClick={(e) => opener.open(row.id, e)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-start text-sm font-medium hover:underline"
        >
          <PageIcon icon={row.icon} className="shrink-0" />
          <span className="truncate">{label}</span>
        </button>
        <button
          type="button"
          aria-label={t("closeCard")}
          title={t("closeCard")}
          onClick={onClose}
          className="-me-1 -mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <p className="mt-0.5 line-clamp-2 text-xs text-fg-muted" title={place.address}>
        {place.name && place.name !== label && !place.address.startsWith(place.name) ? `${place.name}, ${place.address}` : place.address}
      </p>
      {shown.length > 0 && (
        <dl className="mt-2 flex max-h-48 flex-col gap-1 overflow-y-auto">
          {shown.map((p) => (
            <div key={p.id} className="flex min-w-0 items-center gap-2 text-sm">
              <dt className="w-24 shrink-0 truncate text-xs text-fg-muted">{p.name}</dt>
              <dd className="flex min-w-0 flex-1 items-center">
                <RowValue prop={p} row={row} />
              </dd>
            </div>
          ))}
        </dl>
      )}
      <div className="mt-3 flex justify-end">
        <Button size="sm" {...openRowProps(opener, row.id)} onClick={(e) => opener.open(row.id, e)}>
          {t("open")}
        </Button>
      </div>
    </div>
  );
}
