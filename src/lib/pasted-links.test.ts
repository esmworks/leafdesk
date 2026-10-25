import { describe, expect, it } from "vitest";
import { pastedPageLinks } from "./pasted-links";

const APP = "https://app.example.com";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const W = "ws1";
const link = (id: string) => `${APP}/w/${W}/p/${id}`;

describe("pastedPageLinks", () => {
  it("reads one link, or several on their own lines", () => {
    expect(pastedPageLinks(link(A), APP)).toEqual({ refs: [{ pageId: A, blockId: "" }], lines: false });
    expect(pastedPageLinks(`${link(A)}\n${link(B)}\n`, APP)).toEqual({
      refs: [
        { pageId: A, blockId: "" },
        { pageId: B, blockId: "" },
      ],
      lines: true,
    });
  });

  it("takes links on one line, and list markers before them", () => {
    expect(pastedPageLinks(`${link(A)} ${link(B)}`, APP)?.lines).toBe(false);
    expect(pastedPageLinks(`- ${link(A)}\r\n2. ${link(B)}`, APP)?.refs.map((r) => r.pageId)).toEqual([A, B]);
  });

  it("is null for anything else in the text", () => {
    expect(pastedPageLinks(`See ${link(A)}`, APP)).toBeNull();
    expect(pastedPageLinks(`${link(A)}\nhttps://other.example.com/x`, APP)).toBeNull();
    expect(pastedPageLinks("  \n ", APP)).toBeNull();
  });
});
