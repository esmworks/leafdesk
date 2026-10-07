import type { ChecklistItem, PropertyType, SelectOption } from "@/db/schema/app";
import type { AiCellState } from "@/lib/ai";
import type { PropertyAccessInfo } from "@/lib/property-access";
import type { TemplateRepeatSummary } from "@/lib/schedule";
import type {
  DatabaseProperty,
  DatabaseRowWithPosition,
  DatabaseView,
  PersonRef,
  RelationInput,
  RelationTarget,
  RelationTargetRow,
  RollupInput,
} from "@/server/databases";

export type Property = DatabaseProperty;
export type View = DatabaseView;
export type Row = DatabaseRowWithPosition;
export type {
  ChecklistItem,
  PersonRef,
  PropertyType,
  RelationInput,
  RelationTarget,
  RelationTargetRow,
  RollupInput,
  SelectOption,
};

/** Settings of a derived property being added: a formula's expression (with property ids), a rollup's settings. */
export type DerivedInput = { formula?: { expression: string }; rollup?: RollupInput };

export type DatabaseSnapshot = {
  database: {
    id: string;
    workspaceId: string;
    title: string;
    icon: string | null;
    archived: boolean;
    locked: boolean;
    /** The row template "New" starts from; null for blank rows. */
    defaultTemplateId: string | null;
  };
  properties: Property[];
  views: View[];
  rows: Row[];
  /** Row templates of the database (see server/templates.ts), for the menu next to "New". */
  templates: { id: string; title: string; icon: string | null; repeat: TemplateRepeatSummary | null }[];
  /** Related database and its rows, per relation property id. */
  relations: Record<string, RelationTarget>;
  /** People person properties can show and assign (see databases.getPeople). */
  people: PersonRef[];
  /** The signed-in user, who "me" in person filters stands for. */
  viewerId: string;
  /** AI autofill: whether AI is available here, and values still being worked out or that failed. */
  ai?: DatabaseAi;
  /** The viewer's level on each restricted property; missing when none is restricted for them. */
  propertyAccess?: Record<string, PropertyAccessInfo>;
  /** Full access to the database: may set each property's access. */
  canManageAccess?: boolean;
  /** With full access: the properties that have access rules (they don't apply to the viewer). */
  restrictedPropertyIds?: string[];
};

export type DatabaseAi = {
  enabled: boolean;
  /** Per row id, per property id; rows without an entry are done. */
  states: Record<string, Record<string, AiCellState>>;
};

/** Column key for the implicit Name column (matches TITLE_KEY in lib/properties). */
export const TITLE = "title";
