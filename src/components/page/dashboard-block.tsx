"use client";

import { createReactBlockSpec } from "@blocknote/react";
import { useMemo } from "react";
import { dashboardBlockConfig, parseDashboard, serializeDashboard, type DashboardWidget } from "@/lib/dashboard";
import { Dashboard } from "./dashboard-grid";
import { useEmbedHost } from "./database-embed";

/**
 * The dashboard block (see lib/dashboard): widgets in a grid (components/page/dashboard-grid),
 * each a view of a database the reader may see, kept in the block's props.
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
    return <Dashboard widgets={widgets} onChange={onChange} workspaceId={host?.workspaceId ?? null} />;
  },
  toExternalHTML: () => <div />,
});
