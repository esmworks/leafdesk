import { IconGlyph } from "@/components/builtin-icon";
import {
  AlignLeft,
  ArrowUpRight,
  Calendar,
  CalendarDays,
  ChartColumnBig,
  ChartGantt,
  CircleChevronDown,
  CircleDotDashed,
  ClipboardList,
  Combine,
  Clock,
  Fingerprint,
  Hash,
  History,
  Kanban,
  LayoutDashboard,
  LayoutGrid,
  LayoutList,
  Newspaper,
  Link as LinkIcon,
  List,
  ListChecks,
  Map as MapIcon,
  MapPin,
  Paperclip,
  Mail,
  Phone,
  Sheet,
  Sigma,
  SquareCheck,
  Star,
  Timer,
  Type,
  UserRound,
  UserRoundCog,
  UserRoundPen,
  type LucideIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import type { NumberFormat } from "@/lib/number-format";
import { PROPERTY_TYPES } from "@/lib/property-types";
import type { ViewType } from "@/db/schema/app";
import type { PropertyType } from "./types";

/** `label` is a message key under `database.types`. */
export const PROPERTY_TYPE_META = {
  text: { label: "text", icon: AlignLeft },
  number: { label: "number", icon: Hash },
  select: { label: "select", icon: CircleChevronDown },
  multi_select: { label: "multiSelect", icon: List },
  date: { label: "date", icon: Calendar },
  checkbox: { label: "checkbox", icon: SquareCheck },
  url: { label: "url", icon: LinkIcon },
  relation: { label: "relation", icon: ArrowUpRight },
  person: { label: "person", icon: UserRound },
  created_by: { label: "createdBy", icon: UserRoundPen },
  status: { label: "status", icon: CircleDotDashed },
  email: { label: "email", icon: Mail },
  phone: { label: "phone", icon: Phone },
  checklist: { label: "checklist", icon: ListChecks },
  files: { label: "files", icon: Paperclip },
  place: { label: "place", icon: MapPin },
  created_time: { label: "createdTime", icon: Clock },
  last_edited_by: { label: "lastEditedBy", icon: UserRoundCog },
  last_edited_time: { label: "lastEditedTime", icon: History },
  formula: { label: "formula", icon: Sigma },
  rollup: { label: "rollup", icon: Combine },
  unique_id: { label: "uniqueId", icon: Fingerprint },
} as const satisfies Record<PropertyType, { label: string; icon: LucideIcon }>;

/** Translated display name of a property type. */
export function usePropertyTypeLabel() {
  const t = useTranslations("database.types");
  return (type: PropertyType) => t(PROPERTY_TYPE_META[type].label);
}

/**
 * Number properties offered as kinds of their own when a property is added: a rating (stars) and a
 * duration (hours and minutes), numbers with that format (see lib/number-format).
 */
export const NUMBER_KINDS = {
  rating: { label: "rating", icon: Star, format: { format: "rating", max: 5 } },
  duration: { label: "duration", icon: Timer, format: { format: "duration" } },
} as const satisfies Record<string, { label: string; icon: LucideIcon; format: NumberFormat }>;
export type NumberKind = keyof typeof NUMBER_KINDS;

/** What the add-property list offers: every type, with the number kinds right after numbers. */
export type NewPropertyKind = PropertyType | NumberKind;

export const NEW_PROPERTY_KINDS: readonly NewPropertyKind[] = PROPERTY_TYPES.flatMap((type): NewPropertyKind[] =>
  type === "number" ? ["number", "rating", "duration"] : [type],
);

export function isNumberKind(kind: string): kind is NumberKind {
  return kind in NUMBER_KINDS;
}

/** Translated display name of a type or number kind. */
export function useNewPropertyKindLabel() {
  const t = useTranslations("database.types");
  return (kind: NewPropertyKind) => t(isNumberKind(kind) ? NUMBER_KINDS[kind].label : PROPERTY_TYPE_META[kind].label);
}

/** The number kind a number format makes a number property look like, if any. */
function numberKindOf(number: NumberFormat | null | undefined): NumberKind | null {
  return number?.format === "rating" || number?.format === "duration" ? number.format : null;
}

const VIEW_ICONS = {
  table: Sheet,
  board: Kanban,
  calendar: CalendarDays,
  gallery: LayoutGrid,
  list: LayoutList,
  feed: Newspaper,
  timeline: ChartGantt,
  map: MapIcon,
  chart: ChartColumnBig,
  dashboard: LayoutDashboard,
  form: ClipboardList,
} as const satisfies Record<ViewType, LucideIcon>;

/** A view's icon: the one chosen for it (`icon`, its config's), else its type's. */
export function ViewIcon({ type, icon, className }: { type: ViewType; icon?: string | null; className?: string }) {
  if (icon) return <ChosenIcon icon={icon} className={className} />;
  const Icon = VIEW_ICONS[type] ?? Sheet;
  return <Icon className={className ?? "h-3.5 w-3.5"} strokeWidth={1.75} aria-hidden />;
}

/** A property's icon: the one chosen for it (`icon`, its options'), else its type's. */
export function PropertyTypeIcon({
  type,
  icon,
  number,
  className,
}: {
  type: NewPropertyKind | "title";
  icon?: string | null;
  /** A number property's format: a rating or a duration shows the icon of its kind. */
  number?: NumberFormat | null;
  className?: string;
}) {
  if (icon) return <ChosenIcon icon={icon} className={className} />;
  const kind = type === "number" ? numberKindOf(number) : null;
  const Icon = type === "title" ? Type : isNumberKind(type) ? NUMBER_KINDS[type].icon : kind ? NUMBER_KINDS[kind].icon : PROPERTY_TYPE_META[type].icon;
  return <Icon className={className ?? "h-3.5 w-3.5"} strokeWidth={1.75} aria-hidden />;
}

/** An emoji or built-in icon in the box of a type's icon, a little smaller than the text. */
function ChosenIcon({ icon, className }: { icon: string; className?: string }) {
  return <IconGlyph icon={icon} className={`inline-flex shrink-0 items-center justify-center text-[0.8125rem] ${className ?? "h-3.5 w-3.5"}`} />;
}
