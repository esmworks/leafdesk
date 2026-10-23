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
