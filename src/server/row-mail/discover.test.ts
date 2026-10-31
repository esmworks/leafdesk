import { describe, expect, it } from "vitest";
import { discoverMailServers, type DiscoverDeps } from "./discover";

const config = (imap: string, smtp: string) =>
  `<clientConfig version="1.1"><emailProvider id="p"><incomingServer type="imap"><hostname>${imap}</hostname><port>993</port><socketType>SSL</socketType><username>%EMAILADDRESS%</username></incomingServer><outgoingServer type="smtp"><hostname>${smtp}</hostname><port>465</port><socketType>SSL</socketType></outgoingServer></emailProvider></clientConfig>`;

/** DNS and the web stood in for: `files` by address, everything else missing. */
function deps({ files = {}, mx = [], srv = {} }: { files?: Record<string, string>; mx?: string[]; srv?: Record<string, { name: string; port: number }> }) {
  const asked: string[] = [];
  const stand: DiscoverDeps = {
    fetch: async (url) => {
      asked.push(url);
      return files[url] ?? null;
    },
    resolveMx: async () => mx.map((exchange, priority) => ({ exchange, priority })),
    resolveSrv: async (name) => (srv[name] ? [{ ...srv[name], priority: 0, weight: 0 }] : Promise.reject(new Error("ENOTFOUND"))),
  };
  return { stand, asked };
}

describe("discoverMailServers", () => {
  it("takes the domain's own file before the provider database, and sends only the domain", async () => {
    const { stand, asked } = deps({
      files: {
        "https://autoconfig.example.org/mail/config-v1.1.xml": config("imap.own.example.org", "smtp.own.example.org"),
        "https://autoconfig.thunderbird.net/v1.1/example.org": config("imap.db.example.org", "smtp.db.example.org"),
      },
    });
    const found = await discoverMailServers(" Ada@Example.org ", stand);
    expect(found).toMatchObject({ source: "autoconfig", username: "ada@example.org", signIn: null, servers: { imapHost: "imap.own.example.org", smtpPort: 465, smtpSecure: true } });
    expect(asked.every((url) => !url.includes("ada"))).toBe(true);
  });

  it("says when the servers take Microsoft's or Google's sign-in", async () => {
    const outlook = deps({ files: { "https://autoconfig.thunderbird.net/v1.1/hotmail.com": config("outlook.office365.com", "smtp-mail.outlook.com") } });
    expect(await discoverMailServers("ada@hotmail.com", outlook.stand)).toMatchObject({ source: "ispdb", signIn: "microsoft" });
    const tenant = deps({ mx: ["contoso-org.mail.protection.outlook.com"] });
    expect(await discoverMailServers("ada@contoso.org", tenant.stand)).toMatchObject({ source: "mx", signIn: "microsoft", servers: { imapHost: "outlook.office365.com" } });
    const workspace = deps({ mx: ["aspmx.l.google.com", "alt1.aspmx.l.google.com"] });
    expect(await discoverMailServers("ada@acme.org", workspace.stand)).toMatchObject({ source: "mx", signIn: "google", servers: { imapHost: "imap.gmail.com" } });
  });

  it("looks a hosted domain's provider up by its mail exchanger", async () => {
    const { stand } = deps({ mx: ["mx.yandex.net."], files: { "https://autoconfig.thunderbird.net/v1.1/yandex.net": config("imap.yandex.com", "smtp.yandex.com") } });
    expect(await discoverMailServers("ada@acme.com.tr", stand)).toMatchObject({ source: "mx", signIn: null, username: "ada@acme.com.tr", servers: { imapHost: "imap.yandex.com" } });
  });

  it("falls back on service records, TLS from the start first", async () => {
    const { stand } = deps({
      srv: {
        "_imaps._tcp.fast.example": { name: "imap.fast.example.", port: 993 },
        "_imap._tcp.fast.example": { name: "imap.fast.example.", port: 143 },
        "_submission._tcp.fast.example": { name: "smtp.fast.example", port: 587 },
      },
    });
    expect(await discoverMailServers("ada@fast.example", stand)).toEqual({
      servers: { imapHost: "imap.fast.example", imapPort: 993, imapSecure: true, smtpHost: "smtp.fast.example", smtpPort: 587, smtpSecure: false },
      username: "ada@fast.example",
      source: "srv",
      signIn: null,
    });
  });

  it("finds nothing for what isn't an address, or a domain with nothing to say", async () => {
    const { stand, asked } = deps({});
    expect(await discoverMailServers("not an address", stand)).toBeNull();
    expect(await discoverMailServers("ada@[127.0.0.1]", stand)).toBeNull();
    expect(asked).toEqual([]);
    expect(await discoverMailServers("ada@quiet.example", stand)).toBeNull();
  });
});
