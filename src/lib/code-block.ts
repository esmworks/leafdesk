import { createBlockSpec, createCodeBlockConfig, createCodeBlockSpec } from "@blocknote/core";
import { cleanCodeCaption } from "./code-caption";

/**
 * Code blocks with a caption under them (`caption`, empty for none), added from the block's menu.
 * The editor's block (components/page/code-block.tsx) and the server's (server/blocknote.ts) share
 * these props, or the side that doesn't know one drops it. Published pages and PDFs show the
 * caption; Markdown writes it as `<!-- leafdesk:caption … -->` right before the code's fence
 * (lib/content-markdown).
 */

const base = createCodeBlockConfig({ defaultLanguage: "text" });
export const codeBlockConfig = {
  ...base,
  propSchema: { ...base.propSchema, caption: { default: "" } },
} as const;

/**
 * The server's code block: BlockNote's own, with the caption prop; a captioned one's HTML (published
 * pages) is a figure with the code and its caption.
 */
export function serverCodeBlockSpec() {
  const builtIn = createCodeBlockSpec();
  return createBlockSpec(
    codeBlockConfig,
    {
      ...builtIn.implementation,
      toExternalHTML(block, editor, context) {
        const code = builtIn.implementation.toExternalHTML!.call(this as never, block as never, editor as never, context as never) as { dom: HTMLElement; contentDOM?: HTMLElement };
        const caption = cleanCodeCaption(String((block.props as { caption?: unknown }).caption ?? ""));
        if (!caption) return code;
        const figure = document.createElement("figure");
        figure.className = "code-figure";
        const label = document.createElement("figcaption");
        label.textContent = caption;
        figure.append(code.dom, label);
        return { dom: figure, contentDOM: code.contentDOM };
      },
    },
    builtIn.extensions ?? [],
  )();
}
