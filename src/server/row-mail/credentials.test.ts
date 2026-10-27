import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saved: unknown[] = [];
vi.mock("@/db", () => ({
  db: {
    update: () => ({
      set: (values: unknown) => {
        saved.push(values);
        return { where: async () => undefined };
      },
    }),
  },
}));
const refresh = vi.fn();
vi.mock("./google", () => ({ refreshGoogleTokens: (...args: unknown[]) => refresh(...args) }));

const { MailConnectError } = await import("./connect");
const { mailCredentials, withMailCredentials } = await import("./credentials");
const { openJson, seal, sealJson } = await import("@/server/secret-box");

type Box = Parameters<typeof mailCredentials>[0];

const box = (over: Partial<Box>): Box =>
  ({
    id: "box-1",
    imapHost: "imap.gmail.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.gmail.com",
    smtpPort: 465,
    smtpSecure: true,
    username: "ada@example.com",
    auth: "password",
    secret: seal("app-password"),
    ...over,
  }) as Box;

const googleBox = (expiresAt: number) => box({ auth: "google", secret: sealJson({ refreshToken: "r1", accessToken: "a1", expiresAt }) });

beforeEach(() => {
  vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-that-is-long-enough-000000000000");
  vi.stubEnv("MAIL_GOOGLE_CLIENT_ID", "client");
  vi.stubEnv("MAIL_GOOGLE_CLIENT_SECRET", "secret");
  saved.length = 0;
  refresh.mockReset();
  refresh.mockResolvedValue({ refreshToken: "r1", accessToken: "a2", expiresAt: Date.now() + 3600_000 });
});

afterEach(() => vi.unstubAllEnvs());

describe("mailCredentials", () => {
  it("signs a password mailbox in with its password", async () => {
    expect(await mailCredentials(box({}))).toMatchObject({ username: "ada@example.com", password: "app-password", servers: { imapHost: "imap.gmail.com" } });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("uses a Google sign-in's access token while it lasts", async () => {
    expect(await mailCredentials(googleBox(Date.now() + 30 * 60_000))).toMatchObject({ accessToken: "a1" });
    expect(refresh).not.toHaveBeenCalled();
    expect(saved).toEqual([]);
  });

  it("renews one about to run out, and keeps the new one sealed", async () => {
    expect(await mailCredentials(googleBox(Date.now() + 30_000))).toMatchObject({ accessToken: "a2" });
    expect(refresh).toHaveBeenCalledWith({ clientId: "client", clientSecret: "secret" }, expect.objectContaining({ refreshToken: "r1" }));
    const { secret } = saved[0] as { secret: string };
    expect(secret).not.toContain("a2");
    expect(openJson<{ accessToken: string }>(secret).accessToken).toBe("a2");
  });

  it("renews when asked to, however long the token has left", async () => {
    expect(await mailCredentials(googleBox(Date.now() + 30 * 60_000), { renew: true })).toMatchObject({ accessToken: "a2" });
  });

  it("asks for signing in again when the server has no Google client any more", async () => {
    vi.stubEnv("MAIL_GOOGLE_CLIENT_ID", "");
    await expect(mailCredentials(googleBox(0))).rejects.toMatchObject({ code: "signIn" });
  });
});

describe("withMailCredentials", () => {
  const refused = () => Object.assign(new Error("Invalid credentials"), { authenticationFailed: true });

  it("tries a Google mailbox once more with a new token when the server refused the first", async () => {
    const tokens: string[] = [];
    const result = await withMailCredentials(googleBox(Date.now() + 30 * 60_000), async (c) => {
      tokens.push("accessToken" in c ? c.accessToken : "");
      if (tokens.length === 1) throw refused();
      return "read";
    });
    expect(result).toBe("read");
    expect(tokens).toEqual(["a1", "a2"]);
  });

  it("gives up after the second refusal", async () => {
    let tries = 0;
    await expect(
      withMailCredentials(googleBox(Date.now() + 30 * 60_000), async () => {
        tries++;
        throw refused();
      }),
    ).rejects.toMatchObject({ authenticationFailed: true });
    expect(tries).toBe(2);
  });

  it("doesn't try a refused password again", async () => {
    let tries = 0;
    await expect(
      withMailCredentials(box({}), async (c) => {
        tries++;
        expect("password" in c && c.password).toBe("app-password");
        throw refused();
      }),
    ).rejects.toBeTruthy();
    expect(tries).toBe(1);
  });

  it("passes a sign-in Google took back straight on", async () => {
    refresh.mockRejectedValue(new MailConnectError("signIn", "Google refused the sign-in"));
    const signedIn = vi.fn();
    await expect(withMailCredentials(googleBox(0), signedIn)).rejects.toMatchObject({ code: "signIn" });
    expect(signedIn).not.toHaveBeenCalled();
  });
});
