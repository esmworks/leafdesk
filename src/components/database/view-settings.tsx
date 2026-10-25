"use client";

import { SlidersHorizontal } from "lucide-react";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { ViewConfig } from "@/db/schema/app";
import { isGroupable } from "@/lib/properties";
import { holdsTimestamp } from "@/lib/property-types";
import { opensRows, viewDateProperty } from "@/lib/views";
import type { DependencyInput } from "@/lib/dependencies";
import { Floating, useFloating } from "./floating";
import type { Property, View } from "./types";

// Opened from the menu now and then, so they load when first opened.
const ColorRulesDialog = dynamic(() => import("./color-rules-dialog").then((m) => m.ColorRulesDialog));
const loadOptions = () => void import("./view-layout-options");
const ViewLayoutOptions = dynamic(() => import("./view-layout-options").then((m) => m.ViewLayoutOptions));

/** Whether a timeline can start bars at `property`: a date, or a created or edited time (read-only there). */
const isTimelineStart = (property: Property) => property.type === "date" || holdsTimestamp(property.type);

/** Date properties a timeline can start bars at. */
export function timelineStartProps(properties: Property[]) {
  return properties.filter(isTimelineStart);
}

/**
 * The timeline's start and end properties: the saved ones, else the first date property. An end
 * equal to the start (or not a date) counts as none.
 */
export function timelineDates(view: View, properties: Property[]) {
  const start = viewDateProperty(view.config, properties, isTimelineStart) ?? null;
  const end =
    properties.find((p) => p.id === view.config.endDateBy && p.type === "date" && p.id !== start?.id) ?? null;
  return { start, end };
}

/** The timeline's swimlane property, when it has one that can still group. */
export function timelineGroupProperty(view: View, properties: Property[]) {
  return properties.find((p) => p.id === view.config.groupBy && isGroupable(p.type)) ?? null;
}

/** Turns dependencies on or off, or changes their settings (see lib/dependencies). */
export type DependenciesHandler = (on: boolean, input?: { propertyId?: string; settings?: DependencyInput }) => void;

export type ViewLayoutMenuProps = {
  view: View;
  properties: Property[];
  onConfig: (config: ViewConfig) => void;
  onCreateDateProperty: () => void;
  /** Map views: adds a place property for the map to put rows on; missing when the user can't. */
  onCreatePlaceProperty?: () => void;
  /** Turns sub-items on (new properties, or the given relation) or off; missing when the user can't. */
  onSubItems?: (on: boolean, propertyId?: string) => void;
  /** Missing when the user can't change dependencies. */
  onDependencies?: DependenciesHandler;
  /** Opens the database's sprints (see lib/sprints); missing when the user can't change them. */
  onSprints?: () => void;
  readOnly?: boolean;
  locked?: boolean;
};

/**
 * Layout settings of gallery, timeline and chart views (card size and cover; dates, swimlanes and
 * table; the chart), sub-items in table, list and timeline views, dependencies in timelines, and
 * where every view with rows opens them. The settings load when the menu is first opened
 * (view-layout-options), being changed now and then: the button is on every database page.
 */
export function ViewLayoutMenu(props: ViewLayoutMenuProps) {
  const { view, properties, onConfig, readOnly } = props;
  const t = useTranslations("database.layout");
  const menu = useFloating<HTMLButtonElement>();
  const [colorRules, setColorRules] = useState(false);
  if (readOnly || (!opensRows(view.type) && view.type !== "chart")) return null;

  return (
    <>
      <button
        ref={menu.ref}
        type="button"
        title={t("label")}
        aria-label={t("label")}
        onClick={menu.toggle}
        onPointerEnter={loadOptions}
        onFocus={loadOptions}
        className="inline-flex h-7 min-w-7 items-center justify-center rounded-md px-1.5 text-fg-muted hover:bg-bg-hover hover:text-fg"
      >
        <SlidersHorizontal className="h-4 w-4" />
      </button>
      <Floating open={menu.open} anchor={menu.el} onClose={menu.close} align="end">
        <ViewLayoutOptions {...props} close={menu.close} onColorRules={() => setColorRules(true)} />
      </Floating>
      {colorRules && <ColorRulesDialog view={view} properties={properties} onConfig={onConfig} onClose={() => setColorRules(false)} />}
    </>
  );
}

/** The select or status property a map colors its pins by, while it still is one. */
export function mapColorProperty(view: View, properties: Property[]) {
  return properties.find((p) => p.id === view.config.groupBy && (p.type === "select" || p.type === "status")) ?? null;
}
