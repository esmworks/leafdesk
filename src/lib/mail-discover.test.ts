import { describe, expect, it } from "vitest";
import { mxDomain, pickSrv, readAutoconfig, signInOfAddress, signInOfMx } from "./mail-discover";

const outlook = `<clientConfig version="1.1">
  <emailProvider id="hotmail.com">
    <domain>outlook.com</domain>
    <incomingServer type="pop3">
      <hostname>outlook.office365.com</hostname><port>995</port><socketType>SSL</socketType>
      <!-- <incomingServer type="imap"><hostname>evil.example</hostname></incomingServer> -->
    </incomingServer>
    <incomingServer type="imap">
      <hostname>outlook.office365.com</hostname>
      <port>993</port>
      <socketType>SSL</socketType>
      <authentication>OAuth2</authentication>
      <username>%EMAILADDRESS%</username>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>smtp-mail.outlook.com</hostname>
      <port>587</port>
      <socketType>STARTTLS</socketType>
      <authentication>OAuth2</authentication>
      <username>%EMAILADDRESS%</username>
    </outgoingServer>
  </emailProvider>
</clientConfig>`;

describe("readAutoconfig", () => {
  it("reads the IMAP and SMTP servers and that they take only OAuth", () => {
    expect(readAutoconfig(outlook, "ada@outlook.com")).toEqual({
      servers: { imapHost: "outlook.office365.com", imapPort: 993, imapSecure: true, smtpHost: "smtp-mail.outlook.com", smtpPort: 587, smtpSecure: false },
      username: "ada@outlook.com",
      oauthOnly: true,
    });
  });

  it("fills in the address's parts, prefers TLS from the start and never takes plain text", () => {
    const xml = `<clientConfig><emailProvider id="example.org">
      <incomingServer type="imap"><hostname>mail.%EMAILDOMAIN%</hostname><port>143</port><socketType>STARTTLS</socketType><username>%EMAILLOCALPART%</username><authentication>password-cleartext</authentication></incomingServer>
      <incomingServer type="imap"><hostname>imap.example.org</hostname><port>993</port><socketType>SSL</socketType><username>%EMAILLOCALPART%</username><authentication>password-cleartext</authentication><authentication>OAuth2</authentication></incomingServer>
      <outgoingServer type="smtp"><hostname>smtp.example.org</hostname><port>25</port><socketType>plain</socketType></outgoingServer>
      <outgoingServer type="smtp"><hostname>smtp.example.org</hostname><port>587</port><socketType>STARTTLS</socketType></outgoingServer>
    </emailProvider></clientConfig>`;
    expect(readAutoconfig(xml, "ada@example.org")).toEqual({
      servers: { imapHost: "imap.example.org", imapPort: 993, imapSecure: true, smtpHost: "smtp.example.org", smtpPort: 587, smtpSecure: false },
      username: "ada",
      oauthOnly: false,
    });
  });

  it("gives nothing without a usable pair", () => {
    expect(readAutoconfig("<html>not found</html>", "ada@example.org")).toBeNull();
    const plainOnly = `<clientConfig><emailProvider id="x"><incomingServer type="imap"><hostname>imap.x.org</hostname><port>143</port><socketType>plain</socketType></incomingServer><outgoingServer type="smtp"><hostname>smtp.x.org</hostname><port>587</port><socketType>STARTTLS</socketType></outgoingServer></emailProvider></clientConfig>`;
    expect(readAutoconfig(plainOnly, "ada@x.org")).toBeNull();
    const badHost = plainOnly.replace("plain", "SSL").replace("imap.x.org", "imap.x.org/../evil");
    expect(readAutoconfig(badHost, "ada@x.org")).toBeNull();
  });

  it("reads a long hostile file quickly", () => {
    const start = performance.now();
    readAutoconfig(`<clientConfig><emailProvider><incomingServer type="imap"><hostname>${"a-".repeat(30_000)}!</hostname><port>993</port><socketType>SSL</socketType></incomingServer>`, "a@b.co");
    expect(performance.now() - start).toBeLessThan(200);
  });
});

describe("service records and mail exchangers", () => {
  it("picks the lowest priority, then the heaviest, and none when the domain says it isn't offered", () => {
    expect(
      pickSrv([
        { name: "b.example.org", port: 993, priority: 10, weight: 1 },
        { name: "a.example.org.", port: 993, priority: 0, weight: 5 },
        { name: "c.example.org", port: 993, priority: 0, weight: 1 },
      ]),
    ).toEqual({ host: "a.example.org", port: 993 });
    expect(pickSrv([{ name: ".", port: 0, priority: 0, weight: 0 }])).toBeNull();
    expect(pickSrv([])).toBeNull();
  });

  it("knows the providers that take only their own sign-in", () => {
    expect(signInOfMx("aspmx.l.google.com.")).toBe("google");
    expect(signInOfMx("contoso-com.mail.protection.outlook.com")).toBe("microsoft");
    expect(signInOfMx("mx.yandex.net")).toBeNull();
    expect(signInOfAddress("ada@Hotmail.com")).toBe("microsoft");
    expect(signInOfAddress("ada@gmail.com")).toBe("google");
    expect(signInOfAddress("ada@example.org")).toBeNull();
  });

  it("finds the domain a mail exchanger belongs to", () => {
    expect(mxDomain("mx.yandex.net.")).toBe("yandex.net");
    expect(mxDomain("mx1.mail.example.co.uk")).toBe("example.co.uk");
    expect(mxDomain("localhost")).toBeNull();
  });
});
