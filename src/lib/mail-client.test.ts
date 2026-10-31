import { describe, expect, it } from "vitest";
import { folderRoles, forwardSubject, isReplySubject, listsFolder, mailQueryMarks, parseMailQuery, previewText, subjectKey, type ListedMailFolder } from "./mail-client";

const folder = (path: string, extra: Partial<ListedMailFolder> = {}): ListedMailFolder => {
  const parts = path.split("/");
  return { path, name: parts[parts.length - 1], delimiter: "/", parent: parts.slice(0, -1), flags: new Set(), ...extra };
};

describe("folderRoles", () => {
  it("takes the server's marks first", () => {
    const roles = folderRoles([folder("INBOX"), folder("Gesendet", { specialUse: "\\Sent" }), folder("Sent"), folder("Papierkorb", { specialUse: "\\Trash" })]);
    expect(roles.get("INBOX")).toBe("inbox");
    expect(roles.get("Gesendet")).toBe("sent");
    expect(roles.has("Sent")).toBe(false);
    expect(roles.get("Papierkorb")).toBe("trash");
  });

  it("reads names in Leafdesk's languages at the top or under the inbox only", () => {
    const roles = folderRoles([
      folder("INBOX"),
      folder("INBOX/Taslaklar"),
      folder("Gereksiz E-posta"),
      folder("Çöp Kutusu"),
      folder("Müşteriler/Arşiv"),
      folder("[Gmail]/Spam"),
    ]);
    expect(roles.get("INBOX/Taslaklar")).toBe("drafts");
    expect(roles.get("Gereksiz E-posta")).toBe("junk");
    expect(roles.get("Çöp Kutusu")).toBe("trash");
    expect(roles.has("Müşteriler/Arşiv")).toBe(false);
    expect(roles.has("[Gmail]/Spam")).toBe(false);
  });

  it("gives each role to one folder, the shallowest", () => {
    const roles = folderRoles([folder("INBOX"), folder("INBOX/Archive"), folder("Archive")]);
    expect(roles.get("Archive")).toBe("archive");
    expect(roles.has("INBOX/Archive")).toBe(false);
  });
});

describe("listsFolder", () => {
  it("leaves out folders that can't be opened and those that mirror others", () => {
    expect(listsFolder(folder("[Gmail]", { flags: new Set(["\\Noselect"]) }))).toBe(false);
    expect(listsFolder(folder("[Gmail]/All Mail", { specialUse: "\\All" }))).toBe(false);
    expect(listsFolder(folder("[Gmail]/Starred", { flags: new Set(["\\Flagged"]) }))).toBe(false);
    expect(listsFolder(folder("Teklifler"))).toBe(true);
  });
});

describe("subjectKey", () => {
  it("drops reply and forward marks in several languages, and list tags", () => {
    expect(subjectKey("Re: RE: Fwd: Teklif")).toBe("teklif");
    expect(subjectKey("YNT: İLT: Teklif")).toBe("teklif");
    expect(subjectKey("AW: [proj] Re[2]: Plan  B")).toBe("plan b");
    expect(subjectKey("Montaj tarihi")).toBe("montaj tarihi");
  });

  it("tells a reply's subject", () => {
    expect(isReplySubject("Re: Montaj")).toBe(true);
    expect(isReplySubject("Montaj")).toBe(false);
    expect(forwardSubject("Fwd: x")).toBe("Fwd: x");
    expect(forwardSubject("x")).toBe("Fwd: x");
  });
});

describe("previewText", () => {
  it("is one line without the quoted earlier message", () => {
    expect(previewText("Merhaba,\n\nTeklif ekte.\n\n> Eski ileti\n> devam")).toBe("Merhaba, Teklif ekte.");
    expect(previewText("Kısa\n-----Original Message-----\nFrom: x")).toBe("Kısa");
    expect(previewText("a".repeat(500))).toHaveLength(200);
    expect(previewText("Rica ederiz.\n\n31 Eki 2026 15:54 tarihinde Erkal Acar şunu yazdı:\n> Teşekkürler")).toBe("Rica ederiz.");
    expect(previewText("Teşekkürler.\n\nOn Fri, Erhan wrote:\n\n> Teklif")).toBe("Teşekkürler.");
  });
});

describe("mailQueryMarks", () => {
  it("marks each part where the search looked for it", () => {
    expect(mailQueryMarks('kimden:selin konu:"soğuk oda" kompresör is:unread')).toEqual({ senders: ["kompresör", "selin"], subject: ["kompresör", "soğuk oda"], preview: ["kompresör"] });
    expect(mailQueryMarks("is:unread has:attachment")).toBeNull();
  });
});

describe("parseMailQuery", () => {
  it("reads keys, quoted values and words", () => {
    expect(parseMailQuery('from:selin "revize teklif" is:unread has:attachment konu:"soğuk oda" kompresör')).toEqual({
      words: ["revize teklif", "kompresör"],
      from: "selin",
      subject: "soğuk oda",
      unread: true,
      attachment: true,
    });
  });

  it("keeps a word with a colon it doesn't know", () => {
    expect(parseMailQuery("saat:10 after:2026-10-01 before:bad").words).toEqual(["10", "bad"]);
    expect(parseMailQuery("after:2026-10-01").after).toBe("2026-10-01");
  });
});
