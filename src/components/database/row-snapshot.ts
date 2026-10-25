import type { loadRowAction } from "@/app/actions/databases";
import type { AiCellState } from "@/lib/ai";
import type { FormulaStyle } from "@/lib/formula";
import type { PropertyAccessInfo } from "@/lib/property-access";
import type { PersonRef, Property, RelationTarget } from "./types";

/** A row's values and schema as its page shows them; also what this browser keeps of it offline. */
export type RowSnapshot = {
  databaseTitle: string;
  /** The row's title, which formulas can read. */
  title: string;
  /** The database's schema is locked, or the viewer may change values only: no new properties from here. */
  locked: boolean;
  properties: Property[];
  values: Record<string, unknown>;
  relations: Record<string, RelationTarget>;
  people: PersonRef[];
  viewerId: string;
  /** AI autofill: whether AI is available, and this row's pending and failed values. */
  ai?: { enabled: boolean; states: Record<string, AiCellState> };
  /** Property access: values of this row left out for the viewer, and ones they can't change. */
  hidden?: string[];
  readOnly?: string[];
  /** How styled formula results show. */
  styles?: Record<string, FormulaStyle>;
  /** The viewer's level on each restricted property. */
  propertyAccess?: Record<string, PropertyAccessInfo>;
  /** With full access: the properties that have access rules. */
  restrictedPropertyIds?: string[];
  /** The database shows its rows' properties beside the body (lib/row-layout); missing in copies kept before. */
  beside?: boolean;
  /** Full access: the viewer may set how the database's row pages look. */
  canSetLayout?: boolean;
  /** The row is one of its database's row templates (its values may say "me", "today", "now"). */
  template?: boolean;
};

type LoadedRow = Extract<Awaited<ReturnType<typeof loadRowAction>>, { ok: true }>["data"];

export function rowSnapshotOf(data: LoadedRow): RowSnapshot {
  return {
    databaseTitle: data.databaseTitle,
    title: data.row.title,
    locked: data.databaseLocked || !data.schemaEditable,
    properties: data.properties,
    values: data.row.properties,
    relations: data.relations,
    people: data.people,
    viewerId: data.viewerId,
    ai: data.ai,
    hidden: data.row.hidden,
    readOnly: data.row.readOnly,
    styles: data.row.styles,
    propertyAccess: data.propertyAccess,
    restrictedPropertyIds: data.restrictedPropertyIds,
    beside: data.propertiesBeside,
    canSetLayout: data.canManageAccess,
    template: data.row.template,
  };
}
