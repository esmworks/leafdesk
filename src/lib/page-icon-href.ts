import { readBuiltinIcon } from "./icon-value";

/**
 * Where the browser tab's icon for a page with this icon is drawn (app/api/page-icon): an emoji or
 * a built-in icon; null for a page without one, which keeps the app's icon. Import-free enough for
 * the page view, which keeps the tab's icon in step with live changes.
 */
export function pageIconHref(icon: string | null | undefined): string | null {
  const value = icon?.trim();
  if (!value || value.length > 100) return null;
  if (!readBuiltinIcon(value) && !/\p{Extended_Pictographic}|\p{Regional_Indicator}{2}|⃣/u.test(value)) return null;
  return `/api/page-icon?icon=${encodeURIComponent(value)}`;
}
