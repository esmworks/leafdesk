"use client";

import { SideMenuExtension } from "@blocknote/core/extensions";
import { useBlockNoteEditor, useComponentsContext, useExtensionState, usePortalElement } from "@blocknote/react";
import { useTranslations } from "next-intl";
import { QUOTE_SIZES, type QuoteSize } from "@/lib/quote-block";
import type { PageEditor } from "./embed-blocks";
import { rememberQuoteSize } from "./quote-size";

const LABELS = { default: "quoteSizeDefault", large: "quoteSizeLarge" } as const;

/**
 * "Quote size" in a quote's block menu: the size of the text around it, or large (lib/quote-block).
 * The size picked is what new quotes start with in this browser (quote-size.ts).
 */
export function QuoteSizeItem() {
  const Components = useComponentsContext()!;
  const portalElement = usePortalElement();
  const editor = useBlockNoteEditor() as unknown as PageEditor;
  const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block });
  const t = useTranslations("page.blockMenu");
  if (!block || block.type !== "quote" || !editor.isEditable) return null;
  const current = (block.props as { size?: QuoteSize }).size ?? "default";
  const pick = (size: QuoteSize) => {
    rememberQuoteSize(size);
    if (editor.getBlock(block.id)) editor.updateBlock(block.id, { props: { size } } as never);
  };
  return (
    <Components.Generic.Menu.Root position="right" sub portalElement={portalElement}>
      <Components.Generic.Menu.Trigger sub>
        <Components.Generic.Menu.Item className="bn-menu-item" subTrigger>
          {t("quoteSize")}
        </Components.Generic.Menu.Item>
      </Components.Generic.Menu.Trigger>
      <Components.Generic.Menu.Dropdown sub className="bn-menu-dropdown">
        {QUOTE_SIZES.map((size) => (
          <Components.Generic.Menu.Item key={size} className="bn-menu-item" checked={current === size} onClick={() => pick(size)}>
            {t(LABELS[size])}
          </Components.Generic.Menu.Item>
        ))}
      </Components.Generic.Menu.Dropdown>
    </Components.Generic.Menu.Root>
  );
}
