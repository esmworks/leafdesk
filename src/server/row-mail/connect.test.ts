import { afterEach, describe, expect, it, vi } from "vitest";
import { allowedMailHost, connectError, MailConnectError, resolveMailHost } from "./connect";

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
