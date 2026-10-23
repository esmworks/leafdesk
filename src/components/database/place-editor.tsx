"use client";

import { Loader2, MapPin, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { searchPlacesAction } from "@/app/actions/places";
import { cn } from "@/components/ui";
import { asPlace, formatCoordinates, parseCoordinates, placeLabel, placeMapHref, type PlaceValue } from "@/lib/place";

type SearchState =
  | { kind: "idle" }
  | { kind: "searching" }
  | { kind: "done"; query: string; places: PlaceValue[] }
  | { kind: "error"; reason: "off" | "busy" | "failed" };

/** Searches start once typing pauses for this long, and only for this many characters or more. */
const SEARCH_DELAY_MS = 400;
const MIN_QUERY = 3;

/**
 * Edits a place: typing an address or a place's name lists matches from the server's geocoder
 * (picked with a click or the arrow keys and Enter), and typed or pasted coordinates ("41.04,
 * 29.01") are offered as they are. Picking saves right away and closes the editor.
 */
export function PlaceEditor({
  name,
  value,
  onChange,
  onDone,
}: {
  name: string;
  value: unknown;
  onChange: (value: unknown) => void;
  onDone: () => void;
}) {
  const t = useTranslations("database.place");
  const current = asPlace(value);
  const [query, setQuery] = useState("");
  const [state, setState] = useState<SearchState>({ kind: "idle" });
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const latest = useRef(0);
  useEffect(() => input.current?.focus(), []);

  const text = query.trim();
  const coords = parseCoordinates(text);
  useEffect(() => {
    if (parseCoordinates(text) || text.length < MIN_QUERY) {
      setState({ kind: "idle" });
      return;
    }
    const ticket = ++latest.current;
    setState({ kind: "searching" });
    const timer = setTimeout(async () => {
      const result = await searchPlacesAction(text).catch(() => ({ ok: false as const, reason: "failed" as const }));
      // An answer to what was typed before is no longer wanted.
      if (ticket !== latest.current) return;
      setState(result.ok ? { kind: "done", query: text, places: result.places } : { kind: "error", reason: result.reason });
      setActive(0);
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const choices: PlaceValue[] = coords
    ? [{ address: formatCoordinates(coords.lat, coords.lng), ...coords }]
    : state.kind === "done"
      ? state.places
      : [];

  const pick = (place: PlaceValue) => {
    onChange(place);
    onDone();
  };

  return (
    <div>
      <div className="flex items-center gap-1.5 border-b border-border bg-bg-subtle px-2 py-1.5">
        <MapPin className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
        <input
          ref={input}
          value={query}
          placeholder={t("search")}
          aria-label={t("input", { property: name })}
          role="combobox"
          aria-expanded={choices.length > 0}
          aria-controls="place-choices"
          aria-autocomplete="list"
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, choices.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (choices[active]) pick(choices[active]);
            }
          }}
          className="h-6 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-faint"
        />
        {state.kind === "searching" && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-fg-muted" aria-label={t("searching")} />}
      </div>
      <div id="place-choices" role="listbox" aria-label={t("search")} className="max-h-72 overflow-y-auto p-1">
        {choices.map((place, i) => (
          <button
            key={`${place.lat},${place.lng},${i}`}
            type="button"
            role="option"
            aria-selected={i === active}
            onMouseEnter={() => setActive(i)}
            onClick={() => pick(place)}
            className={cn("flex w-full flex-col items-start rounded px-2 py-1.5 text-start", i === active && "bg-bg-hover")}
          >
            {coords ? (
              <span className="text-sm">{t("useCoordinates", { coordinates: place.address })}</span>
            ) : (
              <>
                <span className="w-full truncate text-sm">{placeLabel(place)}</span>
                {place.name && <span className="line-clamp-2 w-full text-xs text-fg-muted">{place.address}</span>}
              </>
            )}
          </button>
        ))}
        {!choices.length && (
          <div className="px-2 py-1.5 text-xs text-fg-faint">
            {state.kind === "searching"
              ? t("searching")
              : state.kind === "error"
                ? t(state.reason)
                : state.kind === "done"
                  ? t("noResults")
                  : t("coordinatesHint")}
          </div>
        )}
      </div>
      {current && (
        <div className="flex items-center gap-2 border-t border-border px-2 py-1.5">
          <div className="min-w-0 flex-1">
            <div className="text-xs text-fg-muted">{t("current")}</div>
            <div className="truncate text-sm" title={current.address}>
              {placeLabel(current)}
            </div>
          </div>
          <a
            href={placeMapHref(current)}
            target="_blank"
            rel="noreferrer noopener"
            className="shrink-0 rounded-md px-2 py-1 text-xs text-fg-muted hover:bg-bg-hover hover:text-fg"
          >
            {t("openMap")}
          </a>
          <button
            type="button"
            onClick={() => {
              onChange(null);
              onDone();
            }}
            className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-fg-muted hover:bg-bg-hover hover:text-fg"
          >
            <X className="h-3 w-3" />
            {t("clear")}
          </button>
        </div>
      )}
    </div>
  );
}
