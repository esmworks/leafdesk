import { afterEach, describe, expect, it, vi } from "vitest";
import { allowedMailHost, connectError, guessSentFolder, MailConnectError, resolveMailHost } from "./connect";

afterEach(() => vi.unstubAllEnvs());

describe("resolveMailHost", () => {
  it("connects to a public address, keeping the name for TLS", async () => {
    const target = await resolveMailHost("imap.example.com", 993, async () => [{ address: "93.184.215.14" }]);
    expect(target).toEqual({ address: "93.184.215.14", servername: "imap.example.com", allowed: false });
  });

  it("refuses private addresses and local names", async () => {
    await expect(resolveMailHost("imap.example.com", 993, async () => [{ address: "10.0.0.5" }])).rejects.toMatchObject({ code: "blocked" });
    await expect(resolveMailHost("127.0.0.1", 993)).rejects.toMatchObject({ code: "blocked" });
    await expect(resolveMailHost("localhost", 993)).rejects.toMatchObject({ code: "blocked" });
    await expect(resolveMailHost("mail.internal", 993)).rejects.toMatchObject({ code: "blocked" });
    await expect(resolveMailHost("mailserver", 993)).rejects.toMatchObject({ code: "blocked" });
  });

  it("refuses a name with any private address, even beside a public one", async () => {
    const resolve = async () => [{ address: "93.184.215.14" }, { address: "192.168.1.2" }];
    await expect(resolveMailHost("imap.example.com", 993, resolve)).rejects.toMatchObject({ code: "blocked" });
  });

  it("says when a name has no address", async () => {
    await expect(
      resolveMailHost("imap.example.com", 993, async () => {
        throw new Error("ENOTFOUND");
      }),
    ).rejects.toMatchObject({ code: "notFound" });
  });

  it("lets the instance allow its own mail servers", async () => {
    vi.stubEnv("MAIL_ALLOWED_HOSTS", "localhost:3143, Mail.Office.Lan");
    expect(allowedMailHost("localhost", 3143)).toBe(true);
    expect(allowedMailHost("localhost", 993)).toBe(false);
    expect(allowedMailHost("mail.office.lan", 25)).toBe(true);
    await expect(resolveMailHost("localhost", 3143, async () => [{ address: "127.0.0.1" }])).resolves.toMatchObject({
      address: "127.0.0.1",
      allowed: true,
    });
  });
});

describe("connectError", () => {
  it("tells a refused sign-in from a server that can't be reached", () => {
    expect(connectError({ authenticationFailed: true, message: "Invalid credentials" }).code).toBe("auth");
    expect(connectError({ code: "EAUTH", responseCode: 535, message: "5.7.8" }).code).toBe("auth");
    expect(connectError(new Error("self signed certificate")).code).toBe("tls");
    expect(connectError(new Error("connect ECONNREFUSED")).code).toBe("unreachable");
    const kept = new MailConnectError("noInbox", "none");
    expect(connectError(kept)).toBe(kept);
  });
});

describe("guessSentFolder", () => {
  /** A folder as the IMAP client lists it, from its path. */
  const folder = (path: string, delimiter = "/", extra: { flags?: string[]; specialUse?: string } = {}) => {
    const parent = path.split(delimiter);
    const name = parent.pop()!;
    return { path, name, parent, flags: new Set(extra.flags ?? []), specialUse: extra.specialUse };
  };
  const guess = (...folders: ReturnType<typeof folder>[]) => guessSentFolder(folders)?.path;
  const inbox = folder("INBOX", "/", { specialUse: "\\Inbox" });

  it("finds a sent folder the server doesn't mark, by its name in any of our languages", () => {
    for (const name of ["Gönderilenler", "Gönderilmiş Öğeler", "Sent Items", "Gesendete Objekte", "Отправленные", "보낸편지함", "已傳送", "送信済みアイテム", "פריטים שנשלחו"]) {
      expect(guess(inbox, folder("Drafts"), folder(name)), name).toBe(name);
    }
  });

  it("ignores case, accents, spacing and invisible marks", () => {
    expect(guess(inbox, folder("GONDERILENLER"))).toBe("GONDERILENLER");
    expect(guess(inbox, folder("Envoyes"))).toBe("Envoyes");
    expect(guess(inbox, folder("sent-mail"))).toBe("sent-mail");
    expect(guess(inbox, folder("보낸 편지함"))).toBe("보낸 편지함");
    // Persian with a zero-width non-joiner between its words.
    expect(guess(inbox, folder("ارسال\u200cشده"))).toBe("ارسال\u200cشده");
  });

  it("finds it under the inbox, whatever the delimiter", () => {
    expect(guess(folder("INBOX", "."), folder("INBOX.Sent", "."))).toBe("INBOX.Sent");
    expect(guess(inbox, folder("INBOX/Gönderilenler"))).toBe("INBOX/Gönderilenler");
  });

  it("prefers the top level, then the more common name", () => {
    expect(guess(inbox, folder("INBOX/Sent"), folder("Sent"))).toBe("Sent");
    expect(guess(inbox, folder("Sent Messages"), folder("Sent"))).toBe("Sent");
  });

  it("leaves folders filed deeper, folders that can't hold mail, and folders with another use", () => {
    expect(guess(inbox, folder("Customers/Acme/Sent"), folder("Archive/Sent"))).toBeUndefined();
    expect(guess(inbox, folder("Sent", "/", { flags: ["\\Noselect"] }))).toBeUndefined();
    expect(guess(inbox, folder("Sent", "/", { flags: ["\\NonExistent"] }))).toBeUndefined();
    expect(guess(inbox, folder("Sent", "/", { specialUse: "\\Drafts" }))).toBeUndefined();
    expect(guess(inbox, folder("Sent to clients"), folder("Outbox"))).toBeUndefined();
  });
});
