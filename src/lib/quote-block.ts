import { addDefaultPropsExternalHTML, createBlockSpec, createQuoteBlockConfig, createQuoteBlockSpec, parseDefaultProps } from "@blocknote/core";

/**
 * The quote block in two sizes: the size of the text around it, or `large` for a pull quote,
 * picked from the block's menu (components/page/quote-size-item.tsx). BlockNote's own quote
 * otherwise (its Mod+Alt+Q and `> ` shortcuts included). Shared by the editor's schema
 * (components/page/embed-blocks.tsx) and the server's (server/blocknote.ts), which must agree on
 * the props or the side that doesn't know one drops it. The block carries `data-size="large"`,
 * which globals.css and published pages draw; Markdown writes `<!-- leafdesk:large-quote -->`
 * before a large one (lib/content-markdown).
 */

export const QUOTE_SIZES = ["default", "large"] as const;
export type QuoteSize = (typeof QUOTE_SIZES)[number];

const base = createQuoteBlockConfig();
export const quoteBlockConfig = {
  ...base,
  propSchema: { ...base.propSchema, size: { default: "default" as QuoteSize, values: QUOTE_SIZES } },
} as const;

const quoteElement = () => {
  const quote = document.createElement("blockquote");
  return { dom: quote, contentDOM: quote };
};

export const quoteBlockSpec = createBlockSpec(
  quoteBlockConfig,
  {
    meta: { isolating: false },
    parse(element) {
      if (element.tagName !== "BLOCKQUOTE") return undefined;
      const { backgroundColor, textColor } = parseDefaultProps(element);
      return { backgroundColor, textColor, ...(element.getAttribute("data-size") === "large" ? { size: "large" as const } : {}) };
    },
    render: quoteElement,
    toExternalHTML(block) {
      const element = quoteElement();
      addDefaultPropsExternalHTML(block.props, element.dom);
      if (block.props.size === "large") element.dom.setAttribute("data-size", "large");
      return element;
    },
  },
  createQuoteBlockSpec().extensions ?? [],
);
