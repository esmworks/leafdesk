import { describe, expect, it } from "vitest";
import {
  answerJson,
  base64Bytes,
  GOOGLE_DOC_MIME,
  googleDocId,
  googleDocIds,
  googleDocsAccess,
  googleDocsQuery,
  readDocList,
  readExport,
} from "./google-docs";

const ID = "1YcBjcuT-UdKNs6z9yUNiZ_nn55nU3azvo0yjRchn3H4";

describe("googleDocId", () => {
  it("reads the id from Docs and Drive links, or takes an id as it is", () => {
    expect(googleDocId(`https://docs.google.com/document/d/${ID}/edit?usp=sharing`)).toBe(ID);
    expect(googleDocId(`https://docs.google.com/document/u/1/d/${ID}/edit`)).toBe(ID);
    expect(googleDocId(`https://drive.google.com/file/d/${ID}/view`)).toBe(ID);
    expect(googleDocId(`https://drive.google.com/open?id=${ID}`)).toBe(ID);
    expect(googleDocId(`  ${ID} `)).toBe(ID);
  });

  it("refuses other sites, plain http and things that aren't ids", () => {
    expect(googleDocId(`https://evil.example/document/d/${ID}`)).toBeNull();
    expect(googleDocId(`https://docs.google.com.evil.example/document/d/${ID}`)).toBeNull();
    expect(googleDocId(`http://docs.google.com/document/d/${ID}`)).toBeNull();
    expect(googleDocId("https://docs.google.com/document/d/short")).toBeNull();
    expect(googleDocId("hello")).toBeNull();
    expect(googleDocId(`${ID}' or title contains 'x`)).toBeNull();
  });

  it("splits pasted text into ids, once each, and what isn't one", () => {
    const pasted = `https://docs.google.com/document/d/${ID}/edit\n${ID}, nonsense\n\n`;
    expect(googleDocIds(pasted)).toEqual({ ids: [ID], invalid: ["nonsense"] });
  });
});

describe("googleDocsQuery", () => {
  it("asks for Google documents, every word in the title, quotes escaped", () => {
    expect(googleDocsQuery("")).toBe(`mimeType = '${GOOGLE_DOC_MIME}'`);
    expect(googleDocsQuery(" O'Brien  plan\\ ")).toBe(
      `mimeType = '${GOOGLE_DOC_MIME}' and title contains 'O\\'Brien' and title contains 'plan\\\\'`,
    );
  });
});

describe("tool answers", () => {
  it("reads JSON from structured content or a text part", () => {
    expect(answerJson({ structuredContent: { a: 1 } })).toEqual({ a: 1 });
    expect(answerJson({ content: [{ type: "image" }, { type: "text", text: "nope" }, { type: "text", text: '{"b":2}' }] })).toEqual({ b: 2 });
    expect(answerJson({ content: [{ type: "text", text: "[1]" }] })).toBeNull();
  });

  it("lists Google documents only, once each, with the next page", () => {
    const list = readDocList({
      files: [
        { id: ID, title: " Plan ", mimeType: GOOGLE_DOC_MIME, modifiedTime: "2026-10-02T08:04:12.433Z", owner: "a@b.c" },
        { id: ID, title: "Again", mimeType: GOOGLE_DOC_MIME },
        { id: "2".repeat(30), title: "Sheet", mimeType: "application/vnd.google-apps.spreadsheet" },
        { id: "bad id", title: "Bad" },
      ],
      nextPageToken: "next",
    });
    expect(list).toEqual({ docs: [{ id: ID, title: "Plan", modifiedTime: "2026-10-02T08:04:12.433Z", owner: "a@b.c" }], next: "next" });
    expect(readDocList({})).toEqual({ docs: [], next: null });
  });

  it("reads an export's content and title", () => {
    expect(readExport({ content: "UEsD\nBA==", title: "Plan" })).toEqual({ content: "UEsDBA==", title: "Plan" });
    expect(readExport({ title: "Plan" })).toBeNull();
    expect(base64Bytes("UEsDBA==")).toBe(4);
    expect(base64Bytes(Buffer.from("hello").toString("base64"))).toBe(5);
  });
});

describe("googleDocsAccess", () => {
  const row = (chatTools: string[], status = "ready") => ({
    status,
    tools: [{ name: "search_files" }, { name: "download_file_content" }],
    chatTools,
  });

  it("lets owners use any ready connection with the tools", () => {
    expect(googleDocsAccess(row([]), "owner")).toEqual({ download: true, search: true });
    expect(googleDocsAccess(row([], "needsAuth"), "owner")).toEqual({ download: false, search: false });
    expect(googleDocsAccess({ status: "ready", tools: [{ name: "read_doc" }], chatTools: [] }, "owner")).toEqual({ download: false, search: false });
  });

  it("lets members use only what an owner allowed the chat, and guests nothing", () => {
    expect(googleDocsAccess(row([]), "member")).toEqual({ download: false, search: false });
    expect(googleDocsAccess(row(["download_file_content"]), "member")).toEqual({ download: true, search: false });
    expect(googleDocsAccess(row(["search_files"]), "member")).toEqual({ download: false, search: false });
    expect(googleDocsAccess(row(["download_file_content", "search_files"]), "member")).toEqual({ download: true, search: true });
    expect(googleDocsAccess(row(["download_file_content", "search_files"]), "guest")).toEqual({ download: false, search: false });
  });
});
