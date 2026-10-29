"use server";

import { getLocale } from "next-intl/server";
import type { PlaceValue } from "@/lib/place";
import { GeocoderError, geocoder } from "@/server/geocoder";
import { requireUserId } from "@/server/session";

/** Why a search found nothing to show: address search is off, busy, or didn't answer. */
export type PlaceSearchResult = { ok: true; places: PlaceValue[] } | { ok: false; reason: "off" | "busy" | "failed" };

/**
 * Places matching what someone typed into a place cell, in their language, through the server's
 * geocoder (server/geocoder.ts), which limits how often each person may ask.
 */
export async function searchPlacesAction(query: string): Promise<PlaceSearchResult> {
  const userId = await requireUserId();
  if (typeof query !== "string" || !query.trim()) return { ok: true, places: [] };
  try {
    const places = await geocoder().search(query, { userId, language: await getLocale(), limit: 5 });
    return { ok: true, places };
  } catch (error) {
    if (error instanceof GeocoderError) return { ok: false, reason: error.code };
    console.error("[place search]", error);
    return { ok: false, reason: "failed" };
  }
}

export type PlaceAtResult = { ok: true; place: PlaceValue | null } | { ok: false; reason: "off" | "busy" | "failed" };

/**
 * The address at a point picked on a map view (to put a row there), in the person's language;
 * null where the geocoder knows none. Limited per person like a search.
 */
export async function placeAtAction(lat: number, lng: number): Promise<PlaceAtResult> {
  const userId = await requireUserId();
  if (typeof lat !== "number" || typeof lng !== "number") return { ok: true, place: null };
  try {
    return { ok: true, place: await geocoder().reverse(lat, lng, { userId, language: await getLocale() }) };
  } catch (error) {
    if (error instanceof GeocoderError) return { ok: false, reason: error.code };
    console.error("[place at]", error);
    return { ok: false, reason: "failed" };
  }
}
