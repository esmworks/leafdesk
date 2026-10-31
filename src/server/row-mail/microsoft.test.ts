import { describe, expect, it } from "vitest";
import { grantsMail, microsoftAuthorizationUrl, microsoftIdentity } from "./microsoft";

const idToken = (claims: Record<string, unknown>) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
const app = { clientId: "client", clientSecret: "secret", tenant: "organizations" };

describe("microsoftAuthorizationUrl", () => {
  it("asks the tenant set for mail and a refresh token, with PKCE", () => {
    const url = new URL(microsoftAuthorizationUrl(app, { state: "s", challenge: "c", redirectUri: "https://app.example/cb", loginHint: "ada@contoso.com" }));
    expect(url.origin + url.pathname).toBe("https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize");
    expect(url.searchParams.get("scope")!.split(" ")).toEqual([
      "openid",
      "email",
      "profile",
      "offline_access",
      "https://outlook.office.com/IMAP.AccessAsUser.All",
      "https://outlook.office.com/SMTP.Send",
    ]);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ code_challenge: "c", code_challenge_method: "S256", login_hint: "ada@contoso.com", state: "s" });
  });
});

describe("microsoftIdentity", () => {
  it("reads the address from email, else the user name, and tells personal accounts apart", () => {
    expect(microsoftIdentity(idToken({ email: "ada@contoso.com", preferred_username: "ada.l@contoso.com", tid: "x" }))).toEqual({ email: "ada@contoso.com", personal: false });
    expect(microsoftIdentity(idToken({ preferred_username: "ada@outlook.com", tid: "9188040d-6c67-4c5b-b112-36a304b66dad" }))).toEqual({ email: "ada@outlook.com", personal: true });
  });

  it("takes no token without an address", () => {
    expect(microsoftIdentity(idToken({ preferred_username: "+90 555 000 00 00" }))).toBeNull();
    expect(microsoftIdentity("not a token")).toBeNull();
    expect(microsoftIdentity(undefined)).toBeNull();
  });
});

describe("grantsMail", () => {
  it("finds IMAP and SMTP however Microsoft writes their resource", () => {
    expect(grantsMail("https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send")).toBe(true);
    expect(grantsMail("https://outlook.office365.com/imap.accessasuser.all https://outlook.office365.com/smtp.send openid")).toBe(true);
    expect(grantsMail("IMAP.AccessAsUser.All SMTP.Send")).toBe(true);
    expect(grantsMail("https://outlook.office.com/IMAP.AccessAsUser.All")).toBe(false);
  });
});
