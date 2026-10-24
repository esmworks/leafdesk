import { describe, expect, it } from "vitest";
import { enexDate, ENEX_LIMITS, enmlToHtml, MEDIA_TOKEN, readEnex, withoutDoctype } from "./enex";
import { enexFile, enml, PNG_BASE64 } from "./enex-fixtures";
import { ImportError } from "./result";

const code = (fn: () => unknown) => {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof ImportError ? `${error.code}:${error.params.name ?? error.params.limit}` : "other";
  }
};

const html = (body: string) => enmlToHtml(enml(body), { encrypted: "Encrypted text was left out." });

describe("reading an export", () => {
  it("reads each note's title, times in UTC, tags, author, source URL and attachments", () => {
    const notes = readEnex(
      "Travel.enex",
      enexFile([
        {
          title: "  Packing   list ",
          body: "<div>Socks</div>",
          created: "20231107T101530Z",
          updated: "20240229T235959Z",
          tags: ["trip", "Trip", "summer"],
          author: "Ayşe",
          sourceUrl: "https://example.com/packing?a=1&b=2",
          resources: [{ base64: PNG_BASE64, mime: "Image/PNG", fileName: "photo.png" }],
        },
        { title: "Second", body: "", created: "not a date" },
      ]),
    );
    expect(notes).toHaveLength(2);
    const [first, second] = notes;
    expect(first).toMatchObject({
      title: "Packing list",
      created: "2023-11-07T10:15:30Z",
      updated: "2024-02-29T23:59:59Z",
      tags: ["trip", "summer"],
      author: "Ayşe",
      sourceUrl: "https://example.com/packing?a=1&b=2",
    });
    expect(first.content).toContain("<en-note><div>Socks</div></en-note>");
    expect(first.resources).toHaveLength(1);
    expect(first.resources[0]).toMatchObject({ mime: "image/png", fileName: "photo.png" });
    expect(Buffer.from(first.resources[0].data.replace(/\s+/g, ""), "base64").subarray(1, 4).toString()).toBe("PNG");
    expect(second).toMatchObject({ title: "Second", created: null, updated: null, tags: [], author: null, sourceUrl: null, resources: [] });
  });

  it("reads content written as escaped text as well as CDATA", () => {
    const xml = `<?xml version="1.0"?><en-export><note><title>T</title><content>&lt;en-note&gt;&lt;b&gt;x&lt;/b&gt;&lt;/en-note&gt;</content></note></en-export>`;
    expect(readEnex("a.enex", xml)[0].content).toBe("<en-note><b>x</b></en-note>");
  });

  it("refuses files that aren't well-formed exports", () => {
    expect(code(() => readEnex("Broken.enex", enexFile([{ title: "A", body: "x" }]).slice(0, 200)))).toBe("badEnex:Broken.enex");
    expect(code(() => readEnex("Other.enex", `<?xml version="1.0"?><html><body/></html>`))).toBe("badEnex:Other.enex");
    expect(code(() => readEnex("Empty.enex", ""))).toBe("badEnex:Empty.enex");
    expect(code(() => readEnex("Entity.enex", `<en-export><note><title>&undeclared;</title></note></en-export>`))).toBe("badEnex:Entity.enex");
  });

  it("refuses a DOCTYPE that declares entities (no expansion, nothing fetched)", () => {
    const laughs = `<?xml version="1.0"?>
<!DOCTYPE en-export [
  <!ENTITY lol "lol">
  <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
  <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
]>
<en-export><note><title>&lol3;</title></note></en-export>`;
    expect(code(() => readEnex("Laughs.enex", laughs))).toBe("badEnex:Laughs.enex");
    const external = `<?xml version="1.0"?><!DOCTYPE en-export SYSTEM "x" [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><en-export><note><title>&xxe;</title></note></en-export>`;
    expect(code(() => readEnex("External.enex", external))).toBe("badEnex:External.enex");
    // Inside a note, the same: its content can't be read.
    expect(() => enmlToHtml(`<!DOCTYPE en-note [<!ENTITY a "b">]><en-note>&a;</en-note>`, { encrypted: "" })).toThrow();
  });

  it("passes over a DOCTYPE that only names a DTD", () => {
    expect(withoutDoctype(`<?xml version="1.0"?>\n<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export4.dtd">\n<en-export/>`)).toBe(
      `<?xml version="1.0"?>\n\n<en-export/>`,
    );
    expect(withoutDoctype(`<en-export/>`)).toBe(`<en-export/>`);
  });

  it("takes at most ENEX_LIMITS.notes notes", () => {
    const many = `<en-export>${"<note><title>n</title></note>".repeat(ENEX_LIMITS.notes + 1)}</en-export>`;
    expect(code(() => readEnex("Many.enex", many))).toBe(`tooManyRows:${ENEX_LIMITS.notes}`);
  });
});

describe("enexDate", () => {
  it("reads Evernote's UTC times", () => {
    expect(enexDate("20231107T101530Z")).toBe("2023-11-07T10:15:30Z");
    expect(enexDate("20231307T101530Z")).toBeNull();
    expect(enexDate("20230230T101530Z")).toBeNull();
    expect(enexDate("2023-11-07")).toBeNull();
  });
});

describe("ENML as HTML", () => {
  it("keeps text styles, links and HTML entities", () => {
    expect(
      html(
        `<div>A&nbsp;<b>bold</b> <i>it</i> <u>under</u> <strike>gone</strike> <span style="font-weight: bold; text-decoration: underline">both</span> &amp; &mdash; <code>x</code></div>`,
      ).html,
    ).toBe("<p>A&nbsp;<strong>bold</strong> <em>it</em> <u>under</u> <s>gone</s> <strong><u>both</u></strong> &amp; &mdash; <code>x</code></p>");
    expect(html(`<div><a href="https://example.com/?a=1&amp;b=2">web</a> <a href="evernote:///view/1/s1/g/g/">note</a> <a href="javascript:alert(1)">js</a></div>`).html).toBe(
      `<p><a href="https://example.com/?a=1&amp;b=2">web</a> note js</p>`,
    );
  });

  it("writes headings, empty lines, dividers, quotes and highlights", () => {
    expect(html(`<h1>Title</h1><div><br/></div><div>Text</div><hr/><blockquote><div>Quoted</div></blockquote><h5>Deep</h5>`).html).toBe(
      "<h1>Title</h1><p></p><p>Text</p><hr><blockquote>Quoted</blockquote><h3>Deep</h3>",
    );
    expect(html(`<div><span style="--en-highlight:yellow;background-color: rgb(255, 250, 165);">marked</span></div>`).html).toBe(
      `<p><span data-style-type="backgroundColor" data-value="yellow">marked</span></p>`,
    );
  });

  it("writes to-dos as checklist items", () => {
    expect(html(`<div><en-todo checked="true"/>Milk</div><div><en-todo/>Bread</div>`).html).toBe(
      `<ul><li><input type="checkbox" checked>Milk</li></ul><ul><li><input type="checkbox">Bread</li></ul>`,
    );
    // Several in one line of text, and the checklists newer versions write.
    expect(html(`<div><en-todo checked="false"/>one<br/>plain<br/><en-todo checked="true"/>two</div>`).html).toBe(
      `<ul><li><input type="checkbox">one</li></ul><p>plain</p><ul><li><input type="checkbox" checked>two</li></ul>`,
    );
    expect(html(`<ul style="--en-todo:true;"><li style="--en-checked:true;"><div>done</div></li><li style="--en-checked:false;"><div>open</div></li></ul>`).html).toBe(
      `<ul><li><input type="checkbox" checked>done</li><li><input type="checkbox">open</li></ul>`,
    );
  });

  it("writes lists with their nesting", () => {
    expect(html(`<ol><li><div>first</div><ul><li><div>inner</div></li></ul></li><li>second</li></ol>`).html).toBe(
      "<ol><li>first<ul><li>inner</li></ul></li><li>second</li></ol>",
    );
  });

  it("writes tables, with blocks in a cell as lines", () => {
    expect(html(`<table><tbody><tr><th>Name</th><th colspan="2">Value</th></tr><tr><td><div>a</div><div>b</div></td><td>1</td><td/></tr></tbody></table>`).html).toBe(
      `<table><tr><th>Name</th><th colspan="2">Value</th></tr><tr><td>a<br>b</td><td>1</td><td></td></tr></table>`,
    );
  });

  it("writes code blocks: pre, and Evernote's own a line per div", () => {
    expect(html(`<pre>let a  = 1;\nif (a &lt; 2) {}</pre>`).html).toBe("<pre><code>let a  = 1;\nif (a &lt; 2) {}</code></pre>");
    expect(html(`<div style="-en-codeblock:true;"><div>one()</div><div>two()</div></div>`).html).toBe("<pre><code>one()\ntwo()</code></pre>");
  });

  it("points attachments at their hash and says what was left out", () => {
    const hash = "0123456789abcdef0123456789abcdef";
    const { html: out, report } = html(
      `<div>See <en-media hash="${hash.toUpperCase()}" type="image/png"/></div><en-media hash="${hash}" type="application/pdf"/>` +
        `<en-crypt hint="pin" cipher="AES">c2VjcmV0</en-crypt><div><img src="https://tracker.example/pixel.png"/></div>`,
    );
    // An attachment is a block of its own, also in the middle of a line.
    expect(out).toBe(`<p>See </p><p><img src="${MEDIA_TOKEN}${hash}"></p><p><img src="${MEDIA_TOKEN}${hash}"></p><p><em>Encrypted text was left out.</em></p>`);
    expect(report).toEqual({ encrypted: 1, external: ["https://tracker.example/pixel.png"] });
    expect(out).not.toContain("c2VjcmV0");
  });

  it("refuses content that isn't well-formed", () => {
    expect(() => html(`<div>unclosed`)).toThrow();
    expect(() => html(`<div><b>crossed</div></b>`)).toThrow();
  });

  it("leaves nothing for an empty note", () => {
    expect(enmlToHtml("", { encrypted: "" }).html).toBe("");
    expect(html(`<div><br/></div>`).html).toBe("");
  });
});
