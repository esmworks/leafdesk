import { describe, expect, it } from "vitest";
import { planImport, resolveLink, rewriteLinks, splitTitle } from "./markdown";
import { bundleFolder, isTextPack, textPackFolder, unpackTextBundles } from "./textbundle";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const files = (entries: Record<string, string>) => new Map(Object.entries(entries).map(([k, v]) => [k, encoder.encode(v)]));
const text = (map: Map<string, Uint8Array>, path: string) => decoder.decode(map.get(path));
/** Where each link of a file points inside the upload. */
const targets = (markdown: string, from: string) => {
  const out: string[] = [];
  rewriteLinks(markdown, from, ({ path }) => {
    out.push(path);
    return null;
  });
  return out;
};

describe("finding TextBundles", () => {
  it("tells bundle folders and packs by their names", () => {
    expect(bundleFolder("Notes/Trip.textbundle/assets/a.png")).toBe("Notes/Trip.textbundle");
    expect(bundleFolder("Trip.TEXTBUNDLE/text.md")).toBe("Trip.TEXTBUNDLE");
    expect(bundleFolder("Trip.textbundle")).toBeNull();
    expect(bundleFolder("Notes/plain.md")).toBeNull();
    expect(isTextPack("a/Trip.textpack")).toBe(true);
    expect(isTextPack("Trip.zip")).toBe(false);
  });

  it("puts a pack's entries in its bundle folder, whether or not they were zipped in one", () => {
    expect(textPackFolder("Trip.textpack", ["Trip.textbundle/text.md", "Trip.textbundle/assets/a.png"])).toBe("");
    expect(textPackFolder("in/Trip.textpack", ["Other.textbundle/text.md"])).toBe("in/");
    expect(textPackFolder("in/Trip.textpack", ["text.md", "assets/a.png", "info.json"])).toBe("in/Trip.textbundle/");
    expect(textPackFolder("Trip.textpack", ["A.textbundle/text.md", "B.textbundle/text.md"])).toBe("");
    expect(textPackFolder("Trip.textpack", ["A.textbundle/text.md", "stray.png"])).toBe("Trip.textbundle/");
  });
});

describe("unpackTextBundles", () => {
  it("makes each bundle's text a Markdown file beside it, its links pointing at the same assets", () => {
    const { files: out, bundles } = unpackTextBundles(
      files({
        "Notes/Trip.textbundle/info.json": JSON.stringify({ version: 2, type: "net.daringfireball.markdown" }),
        "Notes/Trip.textbundle/text.md": "# Paris trip\n\n![Eiffel](assets/eiffel%20tower.png)\n\n[Tickets](assets/tickets.pdf) and <img src=\"assets/map.png\">",
        "Notes/Trip.textbundle/assets/eiffel tower.png": "png",
        "Notes/Trip.textbundle/assets/tickets.pdf": "pdf",
        "Notes/Trip.textbundle/assets/map.png": "png",
        "Notes/other.md": "Plain",
      }),
    );
    expect(bundles).toBe(1);
    expect([...out.keys()].sort()).toEqual([
      "Notes/Trip.md",
      "Notes/Trip.textbundle/assets/eiffel tower.png",
      "Notes/Trip.textbundle/assets/map.png",
      "Notes/Trip.textbundle/assets/tickets.pdf",
      "Notes/other.md",
    ]);
    const markdown = text(out, "Notes/Trip.md");
    expect(markdown).toContain("![Eiffel](Trip.textbundle/assets/eiffel%20tower.png)");
    expect(targets(markdown, "Notes/Trip.md")).toEqual([
      "Notes/Trip.textbundle/assets/eiffel tower.png",
      "Notes/Trip.textbundle/assets/tickets.pdf",
      "Notes/Trip.textbundle/assets/map.png",
    ]);
    // The title is the heading the text starts with (the Markdown import's own rule), out of the body.
    expect(splitTitle(markdown, "Trip")).toEqual({ title: "Paris trip", body: expect.stringMatching(/^!\[Eiffel\]/) });
    // The bundle's folder holds no page: only the new Markdown file is one.
    const plan = planImport([...out.keys()]);
    expect(plan.nodes.map((n) => `${n.key}:${n.title}`)).toEqual(["Notes/:Notes", "Notes/other.md:other", "Notes/Trip.md:Trip"]);
  });

  it("reads text.markdown and text.txt, as info.json's type says, and leaves a bundle without a text alone", () => {
    const { files: out, bundles } = unpackTextBundles(
      files({
        "A.textbundle/text.markdown": "From markdown",
        "B.textbundle/info.json": JSON.stringify({ type: "public.plain-text" }),
        "B.textbundle/text.txt": "Plain text",
        "B.textbundle/text.md": "Not this one",
        "C.textbundle/assets/lonely.png": "png",
        "C.textbundle/info.json": "{}",
      }),
    );
    expect(bundles).toBe(2);
    expect(text(out, "A.md")).toBe("From markdown");
    expect(text(out, "B.md")).toBe("Plain text");
    expect(out.has("B.textbundle/text.md")).toBe(true);
    expect([...out.keys()].filter((p) => p.startsWith("C."))).toEqual(["C.textbundle/assets/lonely.png", "C.textbundle/info.json"]);
  });

  it("numbers a bundle's page when its name is taken, and points links between bundles at their pages", () => {
    const { files: out } = unpackTextBundles(
      files({
        "Plan.md": "Already here",
        "Plan.textbundle/text.md": "See [the trip](../Trip.textbundle) and [its text](../Trip.textbundle/text.md).",
        "Trip.textbundle/text.md": "Trip",
      }),
    );
    expect([...out.keys()].sort()).toEqual(["Plan (2).md", "Plan.md", "Trip.md"]);
    expect(targets(text(out, "Plan (2).md"), "Plan (2).md")).toEqual(["Trip.md", "Trip.md"]);
  });

  it("keeps links outside the bundle pointing where they did, and leaves an upload without bundles as it is", () => {
    const { files: out } = unpackTextBundles(files({ "Notes/Trip.textbundle/text.md": "[Home](../../Home.md) [web](https://example.com)" }));
    const markdown = text(out, "Notes/Trip.md");
    expect(targets(markdown, "Notes/Trip.md")).toEqual(["Home.md"]);
    expect(markdown).toContain("(https://example.com)");
    expect(resolveLink("Notes/Trip.md", "../Home.md")).toBe("Home.md");

    const plain = files({ "a.md": "x" });
    expect(unpackTextBundles(plain)).toEqual({ files: plain, bundles: 0 });
  });
});
