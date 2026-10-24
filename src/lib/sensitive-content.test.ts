import { describe, expect, it } from "vitest";
import {
  findSensitive,
  isCardNumber,
  isIban,
  isTurkishNationalId,
  luhnValid,
  maskCard,
  maskIban,
  maskNationalId,
  maskToken,
  MAX_SCAN_CHARS,
  type SensitiveMatch,
  valueText,
} from "./sensitive-content";

// The real fingerprint is a keyed hash; here the value itself, to see what was found.
const print = (kind: string, value: string) => `${kind}:${value}`;
const find = (text: string) => findSensitive(text, print);
const kinds = (matches: SensitiveMatch[]) => matches.map((m) => m.kind);

const PRIVATE_KEY_BODY = "MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MaqJ5Ry4hWcq8bL1g3oT1bA6xXn9k2Zv1yQkq8m7";
const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";

describe("checks", () => {
  it("checks card numbers with Luhn and the issuer's prefix and length", () => {
    expect(luhnValid("4242424242424242")).toBe(true);
    expect(luhnValid("4242424242424241")).toBe(false);
    for (const card of ["4242424242424242", "4111111111111111", "5555555555554444", "2223003122003222", "378282246310005", "6011111111111117", "3530111333300000"]) {
      expect(isCardNumber(card), card).toBe(true);
    }
    expect(isCardNumber("4242424242424241")).toBe(false);
    // Luhn-valid, but no issuer has this prefix and length.
    expect(isCardNumber("1234567812345670")).toBe(false);
    expect(isCardNumber("0000000000000000")).toBe(false);
    expect(isCardNumber("424242424242")).toBe(false);
  });

  it("checks IBANs by country length and mod 97", () => {
    expect(isIban("TR330006100519786457841326")).toBe(true);
    expect(isIban("DE89370400440532013000")).toBe(true);
    expect(isIban("GB82WEST12345698765432")).toBe(true);
    expect(isIban("TR330006100519786457841327")).toBe(false);
    expect(isIban("DE8937040044053201300")).toBe(false);
    expect(isIban("XX89370400440532013000")).toBe(false);
  });

  it("checks Turkish national ID numbers by both check digits", () => {
    expect(isTurkishNationalId("10000000146")).toBe(true);
    expect(isTurkishNationalId("10000000147")).toBe(false);
    expect(isTurkishNationalId("10000000156")).toBe(false);
    expect(isTurkishNationalId("01000000146")).toBe(false);
    expect(isTurkishNationalId("1000000014")).toBe(false);
  });
});

describe("masking", () => {
  it("keeps only what tells one value from another", () => {
    expect(maskCard("4242424242424242")).toBe("**** **** **** 4242");
    expect(maskIban("TR330006100519786457841326")).toBe("TR** **** **** 1326");
    expect(maskNationalId("10000000146")).toBe("*********46");
    expect(maskToken("ghp_", "ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toBe("ghp_…6789");
  });
});

describe("findSensitive", () => {
  it("finds card numbers written compact, in groups and followed by more digits", () => {
    const found = find("Card: 4242 4242 4242 4242 12/26, also 5555-5555-5555-4444 and 4111111111111111.");
    expect(found.map((m) => m.masked)).toEqual(["**** **** **** 4242", "**** **** **** 4444", "**** **** **** 1111"]);
    expect(kinds(found)).toEqual(["card", "card", "card"]);
    expect(kinds(find("Exp: 4242 4242 4242 4242 12 26"))).toEqual(["card"]);
  });

  it("leaves numbers that only look like cards", () => {
    expect(find("Order 4242424242424241, tracking 1234 5678 9012 3456, ref 1111111111111111")).toEqual([]);
    // Mixed separators make no one number.
    expect(find("4242 4242-4242 4242")).toEqual([]);
    // Inside a longer token.
    expect(find("id_4242424242424242x")).toEqual([]);
    expect(find("Phone +90 532 123 45 67, invoice 2026-10-24")).toEqual([]);
  });

  it("finds IBANs, compact or in groups, and doesn't read their digits again", () => {
    const found = find("Pay to TR33 0006 1005 1978 6457 8413 26 or DE89370400440532013000.");
    expect(found.map((m) => m.masked)).toEqual(["TR** **** **** 1326", "DE** **** **** 3000"]);
    expect(kinds(found)).toEqual(["iban", "iban"]);
    expect(find("TR33 0006 1005 1978 6457 8413 27")).toEqual([]);
  });

  it("finds national ID numbers only written as one run", () => {
    expect(find("TCKN: 10000000146")).toEqual([{ kind: "national_id", masked: "*********46", fingerprint: "national_id:10000000146" }]);
    expect(find("10000000147 and 100 000 001 46")).toEqual([]);
  });

  it("finds private keys and tokens", () => {
    const text = [
      `-----BEGIN RSA PRIVATE KEY-----\n${PRIVATE_KEY_BODY}\n${PRIVATE_KEY_BODY}\n-----END RSA PRIVATE KEY-----`,
      "aws AKIAIOSFODNN7EXAMPLE",
      "gh ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789",
      "slack xoxb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx",
      "openai sk-proj-Ab3dEf7hIjK1mNoPqRsTuVwXyZab12CdEf",
      `jwt ${JWT}`,
      "own esi_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789AbCd",
    ].join("\n");
    const found = find(text);
    expect(found.map((m) => [m.kind, m.masked])).toEqual([
      ["private_key", "BEGIN RSA PRIVATE KEY"],
      ["aws_key", "AKIA…MPLE"],
      ["github_token", "ghp_…6789"],
      ["slack_token", "xoxb-…UvWx"],
      ["api_key", "sk-proj-…CdEf"],
      ["jwt", "eyJ…sR8U"],
      ["api_key", "esi_…AbCd"],
    ]);
    // No masked form holds the value.
    for (const m of found) expect(m.masked).not.toContain(m.fingerprint.slice(m.kind.length + 1));
  });

  it("leaves what only looks like a token", () => {
    expect(find("-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----")).toEqual([]);
    expect(find("sk-this-is-a-long-kebab-case-identifier-name")).toEqual([]);
    expect(find("AKIA1234")).toEqual([]);
    // Three base64url parts whose first isn't a JSON header.
    expect(find("eyJub3QtYS1oZWFkZXI.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9P")).toEqual([]);
  });

  it("names each kind and value once, and stops at the limit", () => {
    expect(find("4242424242424242 again 4242 4242 4242 4242")).toHaveLength(1);
    const many = Array.from({ length: 80 }, () => "TCKN 10000000146").join(" ");
    expect(find(many)).toHaveLength(1);
    const cards = ["4242424242424242", "4111111111111111", "5555555555554444"].join(" ");
    expect(findSensitive(cards, print, 2)).toHaveLength(2);
  });

  it("reads only the first MAX_SCAN_CHARS", () => {
    expect(find(`${" ".repeat(MAX_SCAN_CHARS)} 4242424242424242`)).toEqual([]);
  });
});

describe("valueText", () => {
  it("collects every string of a row's values", () => {
    const text = valueText({ a: "one", b: 2, c: ["two", { address: "three", lat: 1 }], d: null, e: true });
    expect(text.split("\n")).toEqual(["one", "two", "three"]);
    expect(find(valueText({ card: "4242424242424242", notes: [{ text: "IBAN TR330006100519786457841326" }] })).map((m) => m.kind)).toEqual([
      "card",
      "iban",
    ]);
  });
});
