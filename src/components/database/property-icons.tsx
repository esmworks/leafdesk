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
  Hash,
  History,
  Kanban,
  LayoutDashboard,
  LayoutGrid,
  LayoutList,
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
  Type,
  UserRound,
  UserRoundCog,
  UserRoundPen,
  type LucideIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
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
} as const satisfies Record<PropertyType, { label: string; icon: LucideIcon }>;

/** Translated display name of a property type. */
export function usePropertyTypeLabel() {
  const t = useTranslations("database.types");
  return (type: PropertyType) => t(PROPERTY_TYPE_META[type].label);
}

const VIEW_ICONS = {
  table: Sheet,
  board: Kanban,
  calendar: CalendarDays,
  gallery: LayoutGrid,
  list: LayoutList,
  timeline: ChartGantt,
  map: MapIcon,
  chart: ChartColumnBig,
  dashboard: LayoutDashboard,
  form: ClipboardList,
} as const satisfies Record<ViewType, LucideIcon>;

export function ViewIcon({ type, className }: { type: ViewType; className?: string }) {
  const Icon = VIEW_ICONS[type] ?? Sheet;
  return <Icon className={className ?? "h-3.5 w-3.5"} strokeWidth={1.75} aria-hidden />;
}

export function PropertyTypeIcon({ type, className }: { type: PropertyType | "title"; className?: string }) {
  const Icon = type === "title" ? Type : PROPERTY_TYPE_META[type].icon;
  return <Icon className={className ?? "h-3.5 w-3.5"} strokeWidth={1.75} aria-hidden />;
}
