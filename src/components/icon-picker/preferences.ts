import { getIconPreferencesAction, setIconPreferencesAction } from "@/app/actions/preferences";
import type { IconColor } from "@/lib/icon-value";

/** The icon picker's remembered skin tone and icon color (server/icon-preferences.ts), read once per page load. */
export type PickerPreferences = { skinTone: number | null; iconColor: IconColor | null };

let current: Promise<PickerPreferences> | null = null;

export function loadPickerPreferences(): Promise<PickerPreferences> {
  current ??= getIconPreferencesAction().catch(() => ({ skinTone: null, iconColor: null }));
  return current;
}

export function savePickerPreferences(patch: Partial<PickerPreferences>) {
  current = loadPickerPreferences().then((p) => ({ ...p, ...patch }));
  void setIconPreferencesAction(patch).catch(() => {});
}
