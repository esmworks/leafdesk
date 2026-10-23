import { createExtension, NON_FORMATTING_MARK_GROUP } from "@blocknote/core";
import { Mark } from "@tiptap/core";
import { DELETION, INSERTION, MODIFICATION } from "@/lib/suggestions";

/**
 * The suggestion marks (lib/suggestions) in the page editor's schema, on the browser and the
 * server. Every editor of a page body has them: without them, text carrying one would read as
 * empty, and the editor's Yjs binding would delete it from the document.
 *
 * Like comments they are annotations (allowed in code blocks too) that BlockNote's block JSON
 * leaves out (`blocknoteIgnore`). Nothing parses them from pasted HTML: suggestions are made by
 * suggesting, never pasted in.
 */

const idAttribute = {
  id: {
    default: null,
    renderHTML: (attributes: { id?: unknown }) => ({ "data-suggestion": typeof attributes.id === "string" ? attributes.id : "" }),
    parseHTML: () => null,
  },
};

const ignored = () => ({ blocknoteIgnore: true });

const Insertion = Mark.create({
  name: INSERTION,
  inclusive: false,
  excludes: `${INSERTION} ${DELETION} ${MODIFICATION}`,
  group: NON_FORMATTING_MARK_GROUP,
  addAttributes: () => idAttribute,
  renderHTML: ({ HTMLAttributes }) => ["ins", { ...HTMLAttributes, class: "suggestion-insertion" }, 0],
  parseHTML: () => [],
  extendMarkSchema: ignored,
});

const Deletion = Mark.create({
  name: DELETION,
  inclusive: false,
  excludes: `${INSERTION} ${DELETION}`,
  group: NON_FORMATTING_MARK_GROUP,
  addAttributes: () => idAttribute,
  renderHTML: ({ HTMLAttributes }) => ["del", { ...HTMLAttributes, class: "suggestion-deletion" }, 0],
  parseHTML: () => [],
  extendMarkSchema: ignored,
});

/** `previous`: the text's formatting marks before the change, as JSON. */
const Modification = Mark.create({
  name: MODIFICATION,
  inclusive: false,
  excludes: `${INSERTION} ${MODIFICATION}`,
  group: NON_FORMATTING_MARK_GROUP,
  addAttributes: () => ({
    ...idAttribute,
    previous: { default: [], renderHTML: () => ({}), parseHTML: () => [] },
  }),
  renderHTML: ({ HTMLAttributes }) => ["span", { ...HTMLAttributes, class: "suggestion-modification" }, 0],
  parseHTML: () => [],
  extendMarkSchema: ignored,
});

export const suggestionMarkExtensions = [Insertion, Deletion, Modification];

/** The marks as a BlockNote extension, for editors that only show or store page bodies. */
export const suggestionMarks = createExtension({ key: "suggestionMarks", tiptapExtensions: suggestionMarkExtensions });
