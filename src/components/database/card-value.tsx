"use client";

import { isReadOnlyType } from "@/lib/property-types";
import { uploadToPage } from "./files-cell";
import { usePropertyAccess } from "./property-access";
import { PropertyCell, RowValue, type CreateOption } from "./property-cell";
import type { Property, Row } from "./types";

/** Changes one value of a row from a card; the same function for every card, so memoized cards stay as they are. */
export type SetCardValue = (rowId: string, propertyId: string, value: unknown) => void;

/** Clicks and keys on a value (and in its editor, a portal of it) are the value's, not the card's. */
const keep = (e: React.SyntheticEvent) => e.stopPropagation();

/**
 * A value shown on a board or gallery card. Whoever may change it edits it right there, in the
 * editor a table cell opens (an option picker, a date, a text field…), without opening the row;
 * everyone else sees it as before.
 */
export function CardValue({
  prop,
  row,
  wrap,
  readOnly,
  onChange,
  onCreateOption,
}: {
  prop: Property;
  row: Row;
  wrap: boolean;
  readOnly?: boolean;
  onChange?: SetCardValue;
  onCreateOption?: CreateOption;
}) {
  const access = usePropertyAccess();
  if (readOnly || !onChange || !onCreateOption || isReadOnlyType(prop.type) || access.valueAccess(row, prop.id) !== "edit") {
    return <RowValue prop={prop} row={row} wrap={wrap} />;
  }
  return (
    <div className="flex max-w-full min-w-0" onClick={keep} onKeyDown={keep} onAuxClick={keep}>
      <PropertyCell
        variant="card"
        prop={prop}
        value={row.properties[prop.id]}
        style={row.styles?.[prop.id]}
        wrap={wrap}
        onChange={(value) => onChange(row.id, prop.id, value)}
        onCreateOption={onCreateOption}
        rowValues={row.properties}
        upload={prop.type === "files" ? uploadToPage(row.id) : undefined}
      />
    </div>
  );
}
