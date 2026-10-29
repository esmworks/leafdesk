"use client";

// Loaded only when a map view shows (database-page.tsx imports it lazily): Leaflet and its styles
// stay out of every other page.
import "leaflet/dist/leaflet.css";
import "./map-view.css";
import L from "leaflet";
import { ChevronRight, Loader2, MapPin, Maximize, Plus, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { read } from "@/components/read";
import { Button, cn, PageIcon } from "@/components/ui";
import { pageLabel } from "@/lib/labels";
import { asPlace, formatCoordinates, placeLabel, type MapTiles, type PlaceValue } from "@/lib/place";
import { isHiddenInView, optionOf, SELECT_COLORS } from "@/lib/properties";
import { foldSearchText, searchWords } from "@/lib/row-search";
import { viewPlaceProperty } from "@/lib/views";
import { usePropertyAccess } from "./property-access";
import { RowValue, shownValues } from "./property-cell";
import { openRowProps, useRowOpener } from "./row-panel-context";
import type { Property, Row, View } from "./types";
import type { DatabaseApi } from "./use-database";
import { mapColorProperty } from "./view-settings";

type Pin = { row: Row; place: PlaceValue };
/** A spot pressed and held (or right-clicked) on the map, and the pins within reach of it. */
type Spot = { lat: number; lng: number; nearby: string[] };
/** Where something sits on the map, in the map box's pixels, and the box's size. */
type MapPoint = { x: number; y: number; width: number; height: number };
/** The address at a spot: being looked up, found (null where there is none), or not to be had. */
type SpotAddress = { kind: "finding" } | { kind: "found"; place: PlaceValue | null } | { kind: "failed" };

/** The whole world, for a map without pins. */
const WORLD: L.LatLngExpression = [20, 0];
/** How close fitting the pins zooms in at most (one pin shows its neighbourhood, not one house). */
const FIT_MAX_ZOOM = 15;
const CARD_WIDTH = 288;
/** How long a mouse button held still on the map opens the spot menu (touch has its own, in Leaflet). */
const HOLD_MS = 500;
/** How far a held pointer may wander before it counts as dragging the map. */
const HOLD_SLOP = 6;
/** How near a pin's drop (in pixels) counts as at the spot. */
const NEAR_PX = 24;
/** Rows the spot menu lists before asking to type. */
const MENU_ROWS = 50;

/** Text for HTML Leaflet writes itself (the attribution). */
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Rows on a map: each row with a value in the view's place property is a pin (colored by a select
 * or status when the view says so); clicking one opens a card with the row's title and the
 * properties the view shows, from where the row opens as in other views. Rows without a place are
 * listed under the map. The map fits itself to the pins whenever the set of rows changes.
 *
 * Pressing and holding a spot (or right-clicking it) opens a menu there: the pins at that spot, to
 * pick one of a crowd, and the rows without a place, to put one there; it gets the address at the
 * spot from the server's geocoder (placeAtAction) and the spot's own coordinates.
 */
export default function MapView({
  workspaceId,
  view,
  properties,
  rows,
  tiles,
  api,
  readOnly,
  locked,
  onCreatePlaceProperty,
}: {
  workspaceId: string;
  view: View;
  properties: Property[];
  rows: Row[];
  api: DatabaseApi;
  /** The server's map tiles; null when maps are off there. */
  tiles: MapTiles | null;
  readOnly?: boolean;
  locked?: boolean;
  onCreatePlaceProperty: () => void;
}) {
  const t = useTranslations("database");
  const tc = useTranslations("common");
  const opener = useRowOpener(workspaceId);
  const access = usePropertyAccess();
  const placeProp = viewPlaceProperty(view.config, properties);
  const showIcons = view.config.showIcons !== false;
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
  // Rows the viewer may put on the map: no place yet, and theirs to set.
  const placeable = useMemo(
    () => (readOnly || !placeProp ? [] : unplaced.filter((row) => access.valueAccess(row, placeProp.id) === "edit")),
    [readOnly, placeProp, unplaced, access],
  );

  const box = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<L.Map | null>(null);
  const markers = useRef(new Map<string, L.Marker>());
  const [selected, setSelected] = useState<string | null>(null);
  const [showUnplaced, setShowUnplaced] = useState(false);
  const [spot, setSpot] = useState<Spot | null>(null);
  const [address, setAddress] = useState<SpotAddress>({ kind: "finding" });
  /** When the spot menu last opened: a hold is often followed by its click, or a second menu event. */
  const openedAt = useRef(0);
  const pinsRef = useRef<Pin[]>([]);
  const placeableRef = useRef(placeable);
  placeableRef.current = placeable;

  // Opens the spot menu at a point, with the pins whose drop is within reach of it, nearest first.
  const openSpot = useCallback((m: L.Map, at: L.LatLng) => {
    if (Date.now() - openedAt.current < 800) return;
    openedAt.current = Date.now();
    const p = m.latLngToContainerPoint(at);
    const nearby = pinsRef.current
      .map((pin) => {
        const q = m.latLngToContainerPoint([pin.place.lat, pin.place.lng]);
        // The drop is drawn above its point.
        return { id: pin.row.id, d: Math.hypot(q.x - p.x, q.y - 14 - p.y) };
      })
      .filter((n) => n.d <= NEAR_PX)
      .sort((a, b) => a.d - b.d)
      .map((n) => n.id);
    const wrapped = at.wrap();
    setSelected(null);
    setSpot({ lat: Math.round(wrapped.lat * 1e6) / 1e6, lng: Math.round(wrapped.lng * 1e6) / 1e6, nearby });
  }, []);

  // The map itself, made once per tile server (and taken down with the view).
  const tileUrl = tiles?.url;
  const attribution = tiles?.attribution ?? "";
  const attributionUrl = tiles?.attributionUrl ?? null;
  const zoomIn = t("map.zoomIn");
  const zoomOut = t("map.zoomOut");
  useEffect(() => {
    const el = box.current;
    if (!el || !tileUrl) return;
    // tapHold: a long touch is a contextmenu event wherever touch is (iPads too), not only on phones.
    const m = L.map(el, { zoomControl: false, attributionControl: false, worldCopyJump: true, tapHold: true }).setView(WORLD, 2);
    L.control.zoom({ zoomInTitle: zoomIn, zoomOutTitle: zoomOut }).addTo(m);
    const credit = attributionUrl
      ? `<a href="${escapeHtml(attributionUrl)}" target="_blank" rel="noreferrer noopener">${escapeHtml(attribution)}</a>`
      : escapeHtml(attribution);
    const control = L.control.attribution({ prefix: false }).addTo(m);
    if (attribution) control.addAttribution(credit);
    L.tileLayer(tileUrl, { maxZoom: 19 }).addTo(m);
    m.on("click", () => {
      // A click that ends a hold, or comes right after the menu opened, leaves the menu open.
      if (Date.now() - openedAt.current < 800) return;
      setSelected(null);
      setSpot(null);
    });
    // Right-click, and a long touch (tapHold, or the browser's own).
    m.on("contextmenu", (e: L.LeafletMouseEvent) => openSpot(m, e.latlng));
    // A mouse button held still: Leaflet has no such event.
    let hold: { timer: ReturnType<typeof setTimeout>; x: number; y: number } | null = null;
    const cancelHold = () => {
      if (hold) clearTimeout(hold.timer);
      hold = null;
    };
    const down = (e: PointerEvent) => {
      cancelHold();
      if (e.pointerType !== "mouse" || e.button !== 0 || !(e.target instanceof Element) || e.target.closest(".leaflet-control")) return;
      const at = m.mouseEventToLatLng(e);
      hold = { timer: setTimeout(() => openSpot(m, at), HOLD_MS), x: e.clientX, y: e.clientY };
    };
    const move = (e: PointerEvent) => {
      if (hold && Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > HOLD_SLOP) cancelHold();
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", cancelHold);
    el.addEventListener("pointercancel", cancelHold);
    // The keyboard's menu key (or Shift+F10) opens it at the focused pin, or the map's middle.
    const key = (e: KeyboardEvent) => {
      if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
      e.preventDefault();
      const pin = e.target instanceof Element ? e.target.closest(".leafdesk-pin-icon") : null;
      const id = pin ? [...markers.current].find(([, marker]) => marker.getElement() === pin)?.[0] : undefined;
      openSpot(m, id ? markers.current.get(id)!.getLatLng() : m.getCenter());
    };
    el.addEventListener("keydown", key);
    setMap(m);
    const known = markers.current;
    return () => {
      cancelHold();
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", cancelHold);
      el.removeEventListener("pointercancel", cancelHold);
      el.removeEventListener("keydown", key);
      known.clear();
      m.remove();
      setMap(null);
    };
  }, [tileUrl, attribution, attributionUrl, zoomIn, zoomOut, openSpot]);

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
        if (Date.now() - openedAt.current < 800) return;
        setSpot(null);
        setSelected(row.id);
      });
      // Markers keep their mouse events from the map: a right-click or long touch on a pin opens the
      // spot menu at the pin.
      marker.on("contextmenu", () => openSpot(map, marker.getLatLng()));
      marker.addTo(layer);
      made.set(row.id, marker);
    }
    markers.current = made;
    return () => {
      layer.remove();
    };
  }, [map, pins, colorProp, tc, openSpot]);

  // The selected pin stands out.
  useEffect(() => {
    for (const [id, marker] of markers.current) marker.getElement()?.classList.toggle("is-selected", id === selected);
  }, [selected, pins, map]);

  // Fitted to the pins when the map opens and whenever other rows come to show (a filter changed);
  // an edited place, a row put on the map from the spot menu or a new color leaves the map where
  // the person put it.
  const pinKey = useMemo(() => pins.map((p) => p.row.id).sort().join(","), [pins]);
  const lastPinKey = useRef<string | null>(null);
  /** The row just put on the map from the spot menu, whose pin doesn't refit the map. */
  const placedRow = useRef<string | null>(null);
  pinsRef.current = pins;
  const fit = useCallback(() => {
    if (!map) return;
    const shown = pinsRef.current;
    if (!shown.length) map.setView(WORLD, 2);
    else map.fitBounds(L.latLngBounds(shown.map((p) => [p.place.lat, p.place.lng])), { padding: [48, 48], maxZoom: FIT_MAX_ZOOM });
  }, [map]);
  useEffect(() => {
    const before = lastPinKey.current;
    lastPinKey.current = pinKey;
    const placed = placedRow.current;
    placedRow.current = null;
    if (before !== null && placed && [...before.split(",").filter(Boolean), placed].sort().join(",") === pinKey) return;
    fit();
  }, [fit, pinKey]);

  // The card stays by its pin, and the menu by its spot, while the map moves.
  const pin = selected ? pins.find((p) => p.row.id === selected) : undefined;
  const point = useMapPoint(map, pin?.place ?? null);
  const spotPoint = useMapPoint(map, spot);

  // The address at the spot is looked up as the menu opens, when a row may be put there. The
  // lookup itself is kept apart from the menu: a row put there waits for it after the menu closed.
  const canPlace = placeable.length > 0;
  const lookup = useRef<Promise<SpotAddress> | null>(null);
  useEffect(() => {
    lookup.current = null;
    if (!spot || !canPlace) return;
    let live = true;
    setAddress({ kind: "finding" });
    const asked = read("placeAt", spot.lat, spot.lng).then(
      (result): SpotAddress => (result.ok ? { kind: "found", place: result.place } : { kind: "failed" }),
      (): SpotAddress => ({ kind: "failed" }),
    );
    lookup.current = asked;
    void asked.then((found) => live && setAddress(found));
    return () => {
      live = false;
    };
  }, [spot, canPlace]);

  // Puts a row at the spot: with the address found there, or the spot's coordinates without one.
  const placeRow = async (rowId: string) => {
    if (!spot || !placeProp) return;
    const at = spot;
    const asked = lookup.current;
    setSpot(null);
    // The address is usually back by now; a slow one isn't waited for long.
    const found = asked
      ? await Promise.race([asked, new Promise<SpotAddress>((resolve) => setTimeout(() => resolve({ kind: "failed" }), 6000))])
      : { kind: "failed" as const };
    const value: PlaceValue = found.kind === "found" && found.place ? found.place : { address: formatCoordinates(at.lat, at.lng), lat: at.lat, lng: at.lng };
    placedRow.current = rowId;
    void api.setCell(rowId, placeProp.id, value);
    setSelected(rowId);
  };

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
  const closeSpot = () => {
    setSpot(null);
    box.current?.focus();
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
          {spot && spotPoint && (
            <>
              <span
                aria-hidden
                style={{ left: spotPoint.x, top: spotPoint.y }}
                className="pointer-events-none absolute z-[999] h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-bg bg-accent shadow"
              />
              <SpotMenu
                key={`${spot.lat},${spot.lng}`}
                point={spotPoint}
                nearby={spot.nearby.flatMap((id) => pins.find((p) => p.row.id === id)?.row ?? [])}
                placeable={placeable}
                address={canPlace ? address : null}
                coordinates={formatCoordinates(spot.lat, spot.lng)}
                propertyName={placeProp.name}
                showIcon={showIcons}
                onPick={(id) => {
                  setSpot(null);
                  setSelected(id);
                }}
                onPlace={(id) => void placeRow(id)}
                onClose={closeSpot}
              />
            </>
          )}
          {pin && point && (
            <PinCard
              key={pin.row.id}
              pin={pin}
              point={point}
              showIcon={showIcons}
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
          {showUnplaced && tiles && placeable.length > 0 && <p className="mt-1 px-1.5 text-xs text-fg-muted">{t("map.placeHint")}</p>}
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
                    {showIcons && <PageIcon icon={row.icon} className="shrink-0" />}
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
  showIcon,
  props,
  opener,
  onClose,
  onKeyDown,
}: {
  pin: Pin;
  point: MapPoint;
  /** The view shows rows' page icons (see ViewConfig showIcons). */
  showIcon: boolean;
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
          {showIcon && <PageIcon icon={row.icon} className="shrink-0" />}
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

/** Where a place sits in the map box, kept current while the map moves; null without one. */
function useMapPoint(map: L.Map | null, at: { lat: number; lng: number } | null): MapPoint | null {
  const [point, setPoint] = useState<MapPoint | null>(null);
  const lat = at?.lat;
  const lng = at?.lng;
  useLayoutEffect(() => {
    if (!map || lat === undefined || lng === undefined) {
      setPoint(null);
      return;
    }
    const place = () => {
      const p = map.latLngToContainerPoint([lat, lng]);
      const size = map.getSize();
      setPoint({ x: p.x, y: p.y, width: size.x, height: size.y });
    };
    place();
    map.on("move zoom resize", place);
    return () => {
      map.off("move zoom resize", place);
    };
  }, [map, lat, lng]);
  return point;
}

/**
 * The menu at a spot held on the map: the pins there, to pick one, and the rows without a place,
 * found by typing, to put one there. Arrow keys move through the rows, Enter puts the active one.
 */
function SpotMenu({
  point,
  nearby,
  placeable,
  address,
  coordinates,
  propertyName,
  showIcon,
  onPick,
  onPlace,
  onClose,
}: {
  point: MapPoint;
  /** Rows whose pins are at the spot, nearest first. */
  nearby: Row[];
  /** Rows without a place the viewer may put here. */
  placeable: Row[];
  /** The address at the spot; null when no row may be put here (it isn't looked up). */
  address: SpotAddress | null;
  coordinates: string;
  propertyName: string;
  showIcon: boolean;
  onPick: (rowId: string) => void;
  onPlace: (rowId: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations("database.map");
  const tc = useTranslations("common");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => (input.current ?? ref.current)?.focus(), []);

  const matches = useMemo(() => {
    const words = searchWords(query);
    return words.length ? placeable.filter((row) => words.every((w) => foldSearchText(pageLabel(row.title, "")).includes(w))) : placeable;
  }, [placeable, query]);
  const shown = matches.slice(0, MENU_ROWS);
  const current = Math.min(active, shown.length - 1);
  useEffect(() => {
    ref.current?.querySelector(`[data-index="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    } else if (e.target === input.current && (e.key === "ArrowDown" || e.key === "ArrowUp") && shown.length) {
      e.preventDefault();
      setActive((current + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length);
    } else if (e.target === input.current && e.key === "Enter" && shown[current]) {
      e.preventDefault();
      onPlace(shown[current].id);
    }
  };

  // Above the spot when it sits low in the map, below it otherwise; as tall as the room there.
  const above = point.y > point.height / 2;
  const room = Math.max(160, (above ? point.y : point.height - point.y) - 20);
  const left = Math.min(Math.max(point.x, CARD_WIDTH / 2 + 8), Math.max(CARD_WIDTH / 2 + 8, point.width - CARD_WIDTH / 2 - 8));
  const label = (row: Row) => pageLabel(row.title, tc("untitled"));
  const rowButton = "flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-start text-sm";

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={t("spotMenu")}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      style={{ left, top: above ? point.y - 12 : point.y + 12, width: CARD_WIDTH, maxHeight: room }}
      className={cn(
        "absolute z-[1000] flex -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-border bg-bg shadow-lg outline-none",
        above && "-translate-y-full",
      )}
    >
      <div className="flex items-start gap-2 px-3 pt-2.5 pb-1.5">
        <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-muted" />
        <p className="line-clamp-2 min-w-0 flex-1 text-xs text-fg-muted" aria-live="polite">
          {address?.kind === "finding" ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t("findingAddress")}
            </span>
          ) : address?.kind === "found" && address.place ? (
            address.place.address
          ) : (
            coordinates
          )}
        </p>
        <button
          type="button"
          aria-label={t("closeCard")}
          title={t("closeCard")}
          onClick={onClose}
          className="-me-1.5 -mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
        {nearby.length > 0 && (
          <section aria-label={t("atSpot")} className="pb-1">
            <h3 className="px-1.5 pt-1 pb-0.5 text-xs font-medium text-fg-muted">{t("atSpot")}</h3>
            <ul>
              {nearby.map((row) => (
                <li key={row.id}>
                  <button type="button" onClick={() => onPick(row.id)} className={cn(rowButton, "hover:bg-bg-hover")}>
                    {showIcon && <PageIcon icon={row.icon} className="shrink-0" />}
                    <span className="truncate">{label(row)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {placeable.length > 0 && (
          <section aria-label={t("placeTitle", { property: propertyName })} className={cn(nearby.length > 0 && "border-t border-border pt-1")}>
            <h3 className="px-1.5 pt-1 pb-1 text-xs font-medium text-fg-muted">{t("placeTitle", { property: propertyName })}</h3>
            <input
              ref={input}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              placeholder={t("placeSearch")}
              aria-label={t("placeSearch")}
              aria-controls="map-spot-rows"
              aria-activedescendant={shown[current] ? `map-spot-row-${shown[current].id}` : undefined}
              className="mb-1 h-7 w-full rounded-md border border-border bg-bg px-2 text-sm outline-none placeholder:text-fg-faint focus:border-accent"
            />
            {shown.length ? (
              <ul id="map-spot-rows" role="listbox" aria-label={t("placeTitle", { property: propertyName })}>
                {shown.map((row, i) => (
                  <li
                    key={row.id}
                    id={`map-spot-row-${row.id}`}
                    role="option"
                    aria-selected={i === current}
                    data-index={i}
                    onClick={() => onPlace(row.id)}
                    onMouseMove={() => setActive(i)}
                    className={cn(rowButton, "cursor-pointer", i === current && "bg-bg-hover")}
                  >
                    {showIcon && <PageIcon icon={row.icon} className="shrink-0" />}
                    <span className="truncate">{label(row)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-2 py-1 text-sm text-fg-muted">{t("placeNone")}</p>
            )}
            {matches.length > shown.length && <p className="px-2 pt-1 text-xs text-fg-muted">{t("placeMore", { count: matches.length - shown.length })}</p>}
          </section>
        )}
      </div>
    </div>
  );
}
