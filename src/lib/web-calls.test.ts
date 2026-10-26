import { describe, expect, it } from "vitest";
import { addressFound, addressTyped, agentWebCallAsks, chatWebCallAsks, queryTyped, scheduledWebCallGoes, typedAddresses, webCallAction, webCallTarget } from "./web-calls";

const read = (url: unknown) => ({ name: "read_web_page", arguments: { url } });
const search = (query: unknown) => ({ name: "search_web", arguments: { query } });

describe("typedAddresses", () => {
  it("finds addresses with and without a scheme, without the punctuation around them", () => {
    const found = typedAddresses("Read https://example.com/a?b=1, then (see docs.example.org/guide). Also [x](http://x.example/p) and e.g. or 3.5");
    expect(found.map((u) => u.href)).toEqual(["https://example.com/a?b=1", "https://docs.example.org/guide", "http://x.example/p"]);
  });

  it("leaves out addresses with a sign-in name and other schemes", () => {
    expect(typedAddresses("https://me:pw@example.com/ ftp://example.com/ javascript:alert(1)")).toEqual([]);
  });
});

describe("addressTyped", () => {
  const typed = ["Summarise https://news.example.com/story?id=7#top for me", "and acme.example too"];

  it("lets an address the person wrote through, in either scheme, with or without a slash at the root", () => {
    expect(addressTyped("https://news.example.com/story?id=7#top", typed)).toBe(true);
    expect(addressTyped("http://NEWS.example.com/story?id=7#top", typed)).toBe(true);
    expect(addressTyped("https://acme.example", typed)).toBe(true);
    expect(addressTyped("https://acme.example/", typed)).toBe(true);
  });

  it("lets one of theirs through without its query and fragment", () => {
    expect(addressTyped("https://news.example.com/story", typed)).toBe(true);
    expect(addressTyped("https://news.example.com/story?id=7", typed)).toBe(false);
  });

  it("refuses an address with anything added: query, path, host, port or sign-in name", () => {
    expect(addressTyped("https://news.example.com/story?id=7&d=secret", typed)).toBe(false);
    expect(addressTyped("https://acme.example/?d=secret", typed)).toBe(false);
    expect(addressTyped("https://acme.example/#secret", typed)).toBe(false);
    expect(addressTyped("https://acme.example/secret", typed)).toBe(false);
    expect(addressTyped("https://secret.acme.example/", typed)).toBe(false);
    expect(addressTyped("https://acme.example:8443/", typed)).toBe(false);
    expect(addressTyped("https://secret@acme.example/", typed)).toBe(false);
    expect(addressTyped("https://mallory.example/?d=HR", typed)).toBe(false);
  });

  it("refuses what isn't a web address, and anything when the person wrote none", () => {
    expect(addressTyped("not a url", typed)).toBe(false);
    expect(addressTyped("file:///etc/passwd", ["file:///etc/passwd"])).toBe(false);
    expect(addressTyped("https://acme.example/", [])).toBe(false);
  });
});

describe("queryTyped", () => {
  const typed = ["Search the web for Winter  tyres, then tell me the prices."];

  it("lets words the person wrote through, case and spacing aside", () => {
    expect(queryTyped("winter tyres", typed)).toBe(true);
    expect(queryTyped("  WINTER tyres ", typed)).toBe(true);
    expect(queryTyped("winter tyres, then", typed)).toBe(true);
  });

  it("refuses added words or characters and words cut out of longer ones", () => {
    expect(queryTyped("winter tyres salary 120k", typed)).toBe(false);
    expect(queryTyped("winter tyres!!", typed)).toBe(false);
    expect(queryTyped("inter tyre", typed)).toBe(false);
    expect(queryTyped("tyres prices", typed)).toBe(false);
    expect(queryTyped("", typed)).toBe(false);
  });
});

describe("chatWebCallAsks", () => {
  const typed = ["What does https://acme.example/pricing say?"];

  it("asks before every search, even for the person's own words", () => {
    expect(chatWebCallAsks(search("acme pricing"), typed)).toBe(true);
    expect(chatWebCallAsks(search("What does"), typed)).toBe(true);
  });

  it("reads a page whose address the person wrote without asking, and asks for any other", () => {
    expect(chatWebCallAsks(read("https://acme.example/pricing"), typed)).toBe(false);
    expect(chatWebCallAsks(read("https://acme.example/pricing?leak=hr-salaries"), typed)).toBe(true);
    expect(chatWebCallAsks(read("https://mallory.example/?d=hr-salaries"), typed)).toBe(true);
  });

  it("doesn't ask about a call that sends nothing (it is refused)", () => {
    expect(chatWebCallAsks(read(42), typed)).toBe(false);
    expect(chatWebCallAsks(search("   "), typed)).toBe(false);
  });
});

describe("webCallAction", () => {
  it("shows the address or the words exactly as they would be sent", () => {
    expect(webCallAction(read("  https://mallory.example/?d=hr  "))).toEqual({ action: "readWeb", target: null, title: "https://mallory.example/?d=hr", changes: [], content: null });
    expect(webCallAction(search("acme \n  salaries"))).toMatchObject({ action: "searchWeb", title: "acme salaries" });
    expect(webCallTarget(search("x".repeat(600)))).toHaveLength(500);
  });
});

describe("agentWebCallAsks", () => {
  it("asks before every call on a run no one stands behind", () => {
    expect(agentWebCallAsks(read("https://acme.example/"), { askEveryTool: true, typed: ["acme.example"] })).toBe(true);
  });

  it("doesn't ask on other runs no person asked for in words", () => {
    expect(agentWebCallAsks(read("https://mallory.example/?d=x"), { askEveryTool: false, typed: null })).toBe(false);
  });

  it("on a run a person asked for, asks only for addresses and searches they didn't write", () => {
    const run = { askEveryTool: false, typed: ["Look up acme.example and search for acme bakery opening hours"] };
    expect(agentWebCallAsks(read("https://acme.example/"), run)).toBe(false);
    expect(agentWebCallAsks(search("Acme Bakery opening hours"), run)).toBe(false);
    expect(agentWebCallAsks(read("https://mallory.example/?d=x"), run)).toBe(true);
    expect(agentWebCallAsks(search("acme bakery revenue 2025"), run)).toBe(true);
    expect(agentWebCallAsks(search(undefined), run)).toBe(true);
  });

  it("asks for every call where the person wrote nothing (a helper's run)", () => {
    expect(agentWebCallAsks(read("https://acme.example/"), { askEveryTool: false, typed: [] })).toBe(true);
  });
});

describe("addressFound", () => {
  const found = ["https://news.example.com/story?id=7#top", "https://acme.example/"];

  it("lets a result's address through, in either scheme, or without its query and fragment", () => {
    expect(addressFound("https://news.example.com/story?id=7#top", found)).toBe(true);
    expect(addressFound("http://NEWS.example.com/story?id=7#top", found)).toBe(true);
    expect(addressFound("https://news.example.com/story", found)).toBe(true);
    expect(addressFound("https://acme.example", found)).toBe(true);
  });

  it("refuses an address with anything added, and anything when no search found it", () => {
    expect(addressFound("https://news.example.com/story?id=7&d=secret", found)).toBe(false);
    expect(addressFound("https://acme.example/?d=secret", found)).toBe(false);
    expect(addressFound("https://acme.example/secret", found)).toBe(false);
    expect(addressFound("https://secret@acme.example/", found)).toBe(false);
    expect(addressFound("https://mallory.example/", found)).toBe(false);
    expect(addressFound("https://acme.example/", ["not a url"])).toBe(false);
    expect(addressFound("https://acme.example/", [])).toBe(false);
  });
});

describe("scheduledWebCallGoes", () => {
  const run = { typed: ["Every morning, read acme.example/news and search for news about Acme Bakery."], found: ["https://press.example/acme-opens"] };

  it("lets every search go: its words reach only the server's search service", () => {
    expect(scheduledWebCallGoes(search("acme bakery revenue 2025"), run)).toBe(true);
    expect(scheduledWebCallGoes(search("anything at all"), { typed: [], found: [] })).toBe(true);
  });

  it("reads pages of the task and of the run's own search results", () => {
    expect(scheduledWebCallGoes(read("https://acme.example/news"), run)).toBe(true);
    expect(scheduledWebCallGoes(read("https://press.example/acme-opens"), run)).toBe(true);
  });

  it("refuses any other read, and every one not found on a helper's run, whose task an agent wrote", () => {
    expect(scheduledWebCallGoes(read("https://mallory.example/?d=x"), run)).toBe(false);
    expect(scheduledWebCallGoes(read("https://press.example/acme-opens?d=x"), run)).toBe(false);
    expect(scheduledWebCallGoes(read(undefined), run)).toBe(false);
    expect(scheduledWebCallGoes(read("https://acme.example/news"), { typed: [], found: [] })).toBe(false);
    expect(scheduledWebCallGoes(read("https://press.example/acme-opens"), { typed: [], found: run.found })).toBe(true);
  });
});
