"use client";

import { SideMenuExtension } from "@blocknote/core/extensions";
import { useBlockNoteEditor, useComponentsContext, useExtensionState } from "@blocknote/react";
import { usePortalElement } from "@blocknote/react";
import { useTranslations } from "next-intl";
import { styledCalloutProps, type CalloutStyle } from "@/lib/callout-styles";
import { CALLOUT_BLOCK } from "@/lib/content-blocks";
import { useCalloutStyleName, useOfferedCalloutStyles } from "./callout-styles-context";
import { CALLOUT_TITLE_FIELD } from "./content-blocks";
import type { PageEditor } from "./embed-blocks";

/** Blocks of text a callout can take the place of, keeping their text and nested blocks. */
const TURNS_INTO_CALLOUT = new Set(["paragraph", "heading", "quote", "bulletListItem", "numberedListItem", "checkListItem", "toggleListItem"]);

/** A style's icon in a menu: its emoji, or an empty box for none. */
function StyleIcon({ style }: { style: CalloutStyle | undefined }) {
  return (
    <span
      className="leafdesk-callout-swatch inline-flex h-5 w-5 items-center justify-center rounded text-xs"
      data-callout-color={style?.color ?? "gray"}
      data-callout-border={style?.border}
    >
      {style ? style.icon : "💡"}
    </span>
  );
}

/**
 * The callout's style in its block menu: a plain callout or one of the styles (the workspace's,
 * then the built-in ones). On a block of text the same list turns it into a callout of that style.
 */
export function CalloutStyleItem() {
  const Components = useComponentsContext()!;
  const portalElement = usePortalElement();
  const editor = useBlockNoteEditor() as unknown as PageEditor;
  const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block });
  const styles = useOfferedCalloutStyles();
  const nameOf = useCalloutStyleName();
  const t = useTranslations("page.blockMenu");
  if (!block || !editor.isEditable) return null;
  const isCallout = block.type === CALLOUT_BLOCK;
  if (!isCallout && !TURNS_INTO_CALLOUT.has(block.type)) return null;
  const current = isCallout ? String((block.props as { styleKey?: unknown }).styleKey ?? "") : null;
  const pick = (style: CalloutStyle | undefined) => {
    if (!editor.getBlock(block.id)) return;
    if (isCallout) {
      // The callout keeps its own icon and color when it leaves a style, as it had them before.
      editor.updateBlock(block.id, { props: style ? styledCalloutProps(style) : { styleKey: "" } });
    } else {
      editor.updateBlock(block.id, { type: CALLOUT_BLOCK, props: styledCalloutProps(style) } as never);
    }
  };
  const options: (CalloutStyle | undefined)[] = [undefined, ...styles];
  return (
    <Components.Generic.Menu.Root position="right" sub portalElement={portalElement}>
      <Components.Generic.Menu.Trigger sub>
        <Components.Generic.Menu.Item className="bn-menu-item" subTrigger>
          {isCallout ? t("calloutStyle") : t("turnIntoCallout")}
        </Components.Generic.Menu.Item>
      </Components.Generic.Menu.Trigger>
      <Components.Generic.Menu.Dropdown sub className="bn-menu-dropdown">
        {options.map((style) => (
          <Components.Generic.Menu.Item
            key={style?.key ?? ""}
            className="bn-menu-item"
            icon={<StyleIcon style={style} />}
            checked={isCallout ? current === (style?.key ?? "") : undefined}
            onClick={() => pick(style)}
          >
            {style ? nameOf(style) : t("plainCallout")}
          </Components.Generic.Menu.Item>
        ))}
      </Components.Generic.Menu.Dropdown>
    </Components.Generic.Menu.Root>
  );
}

/** "Add title" / "Remove title" in a callout's block menu (lib/content-blocks `title`). */
export function CalloutTitleItem() {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor() as unknown as PageEditor;
  const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block });
  const t = useTranslations("page.blockMenu");
  const tc = useTranslations("page.blocks.callout");
  if (!block || block.type !== CALLOUT_BLOCK || !editor.isEditable) return null;
  const title = String((block.props as { title?: unknown }).title ?? "");
  return (
    <Components.Generic.Menu.Item
      className="bn-menu-item"
      onClick={() => {
        if (!editor.getBlock(block.id)) return;
        if (title) {
          editor.updateBlock(block.id, { props: { title: "" } });
          return;
        }
        // A title to type over, selected in its field once the callout has drawn it.
        editor.updateBlock(block.id, { props: { title: tc("titlePlaceholder") } });
        setTimeout(() => {
          const field = editor.domElement?.querySelector<HTMLInputElement>(`input[${CALLOUT_TITLE_FIELD}="${CSS.escape(block.id)}"]`);
          field?.focus();
          field?.select();
        }, 50);
      }}
    >
      {title ? t("removeTitle") : t("addTitle")}
    </Components.Generic.Menu.Item>
  );
}
