/**
 * A remark plugin that shows `<sup>…</sup>` and `<sub>…</sub>` in Markdown as superscript and
 * subscript, the form page bodies write them in (lib/text-scripts). For renderers that otherwise
 * show raw HTML as text (the AI chat): only these two tags, written exactly so and closed among the
 * same siblings, become elements; every other tag, and a tag left open, stays text.
 */

type MdNode = { type: string; value?: string; children?: MdNode[]; data?: { hName?: string } };

const TAG = /^<(\/?)(sup|sub)>$/i;

function tagOf(node: MdNode): { tag: string; closing: boolean } | null {
  if (node.type !== "html" || typeof node.value !== "string") return null;
  const match = TAG.exec(node.value.trim());
  return match ? { tag: match[2].toLowerCase(), closing: match[1] === "/" } : null;
}

/** Pairs the tags among `children` (nested pairs of the same tag included) and wraps what's between. */
function wrap(children: MdNode[]): MdNode[] {
  const out: MdNode[] = [];
  for (let i = 0; i < children.length; i++) {
    const open = tagOf(children[i]);
    if (!open || open.closing) {
      out.push(children[i]);
      continue;
    }
    let depth = 0;
    let close = -1;
    for (let j = i + 1; j < children.length; j++) {
      const tag = tagOf(children[j]);
      if (!tag || tag.tag !== open.tag) continue;
      if (!tag.closing) depth++;
      else if (depth === 0) {
        close = j;
        break;
      } else depth--;
    }
    if (close < 0) {
      out.push(children[i]);
      continue;
    }
    out.push({ type: "textScript", data: { hName: open.tag }, children: wrap(children.slice(i + 1, close)) });
    i = close;
  }
  return out;
}

function visit(node: MdNode) {
  if (!node.children) return;
  node.children.forEach(visit);
  node.children = wrap(node.children);
}

export function remarkTextScripts() {
  return (tree: MdNode) => visit(tree);
}
