"use client";

import { createReactBlockSpec } from "@blocknote/react";
import dynamic from "next/dynamic";
import { useMemo } from "react";
import { dashboardBlockConfig, dashboardLayout, parseDashboard, serializeDashboard, type DashboardWidget } from "@/lib/dashboard";
import { Dashboard } from "./dashboard-grid";
import { useEmbedHost } from "./database-embed";

// Loaded when a page shows a dashboard laid out as tabs.
const DashboardTabs = dynamic(() => import("./dashboard-tabs").then((module) => module.DashboardTabs), {
  loading: () => <div aria-hidden className="my-2 h-32 animate-pulse rounded-md bg-bg-subtle" />,
});

/**
 * The dashboard block (see lib/dashboard): widgets in a grid (components/page/dashboard-grid) or
 * as tabs (components/page/dashboard-tabs), each a view of a database the reader may see, kept in
 * the block's props.
 */
export const DashboardBlock = createReactBlockSpec(dashboardBlockConfig, {
  meta: { selectable: false },
  render: function DashboardBlockView({ block, editor }) {
    const host = useEmbedHost();
    const widgets = useMemo(() => parseDashboard(block.props.widgets), [block.props.widgets]);
    // The widgets live in the block, so they sync, undo and version with the page. Readers who
    // can't edit the page can't change them (the collab server would drop the edit anyway).
    const editable = host?.editable ?? false;
    const onChange = useMemo(
      () =>
        editable
          ? (next: DashboardWidget[]) => {
              if (editor.getBlock(block.id)) editor.updateBlock(block.id, { props: { widgets: serializeDashboard(next) } });
            }
          : undefined,
      [editable, editor, block.id],
    );
    const workspaceId = host?.workspaceId ?? null;
    if (dashboardLayout(block.props.layout) === "tabs") return <DashboardTabs widgets={widgets} onChange={onChange} workspaceId={workspaceId} />;
    return <Dashboard widgets={widgets} onChange={onChange} workspaceId={workspaceId} />;
  },
  toExternalHTML: () => <div />,
});
