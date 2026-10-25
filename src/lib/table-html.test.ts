import { describe, expect, it } from "vitest";
import { tableHtml } from "./table-html";

describe("tableHtml", () => {
  it("writes the title and cells, escaped, numbers to the end", () => {
    const html = tableHtml("Tasks <all>", ["Name", "Points"], [["<b>Ship</b> & go", 3], ["Plan", null]], "tr");
    expect(html).toContain('<html lang="tr">');
    expect(html).toContain("<title>Tasks &lt;all&gt;</title>");
    expect(html).toContain('<th dir="auto">Name</th><th dir="auto">Points</th>');
    expect(html).toContain('<td dir="auto">&lt;b&gt;Ship&lt;/b&gt; &amp; go</td><td dir="auto" class="number">3</td>');
    expect(html).toContain('<td dir="auto">Plan</td><td dir="auto"></td>');
    expect(html).not.toMatch(/<script|src=|href=/);
  });
});
