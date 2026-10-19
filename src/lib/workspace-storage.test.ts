import { describe, expect, it } from "vitest";
import { normalizeEndpoint, parseS3Input, sameS3Location, StorageInputError } from "./workspace-storage";

const keys = { accessKeyId: "AKIA123", secretAccessKey: "s3cr3t" };
const fieldOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof StorageInputError) return error.field;
    throw error;
  }
  return null;
};

describe("parseS3Input", () => {
  it("tidies what was typed", () => {
    expect(
      parseS3Input({ endpoint: " https://acc.r2.cloudflarestorage.com/ ", region: "auto", bucket: " files ", prefix: "/leafdesk/team/", ...keys }),
    ).toEqual({
      config: { endpoint: "https://acc.r2.cloudflarestorage.com", region: "auto", bucket: "files", prefix: "leafdesk/team", forcePathStyle: true },
      credentials: keys,
    });
  });

  it("means AWS without an endpoint, addressed by bucket name unless told otherwise", () => {
    expect(parseS3Input({ bucket: "my-files", ...keys }).config).toEqual({
      endpoint: null,
      region: "us-east-1",
      bucket: "my-files",
      prefix: null,
      forcePathStyle: false,
    });
    expect(parseS3Input({ endpoint: "https://s3.example.com", bucket: "b-1", forcePathStyle: false, ...keys }).config.forcePathStyle).toBe(false);
  });

  it("names the field that is wrong", () => {
    expect(fieldOf(() => parseS3Input({ endpoint: "ftp://x", bucket: "abc", ...keys }))).toBe("endpoint");
    expect(fieldOf(() => parseS3Input({ endpoint: "https://u:p@x.com", bucket: "abc", ...keys }))).toBe("endpoint");
    expect(fieldOf(() => parseS3Input({ endpoint: "https://x.com/?a=1", bucket: "abc", ...keys }))).toBe("endpoint");
    expect(fieldOf(() => parseS3Input({ region: "US East", bucket: "abc", ...keys }))).toBe("region");
    expect(fieldOf(() => parseS3Input({ bucket: "ab", ...keys }))).toBe("bucket");
    expect(fieldOf(() => parseS3Input({ bucket: "a/b/c", ...keys }))).toBe("bucket");
    expect(fieldOf(() => parseS3Input({ bucket: "abc", prefix: "../up", ...keys }))).toBe("prefix");
    expect(fieldOf(() => parseS3Input({ bucket: "abc", prefix: "a b", ...keys }))).toBe("prefix");
    expect(fieldOf(() => parseS3Input({ bucket: "abc", secretAccessKey: "x" }))).toBe("accessKeyId");
    expect(fieldOf(() => parseS3Input({ bucket: "abc", accessKeyId: "x" }))).toBe("secretAccessKey");
    expect(fieldOf(() => parseS3Input({ bucket: 42, ...keys }))).toBe("bucket");
  });
});

describe("normalizeEndpoint", () => {
  it("keeps the origin and path, and nothing for an empty one", () => {
    expect(normalizeEndpoint("")).toBeNull();
    expect(normalizeEndpoint("https://storage.example.com:8443/s3//")).toBe("https://storage.example.com:8443/s3");
  });
});

describe("sameS3Location", () => {
  it("is the same bucket and folder at the same address, whatever the keys and addressing", () => {
    const a = parseS3Input({ endpoint: "https://s.example.com", bucket: "abc", prefix: "x", ...keys }).config;
    expect(sameS3Location(a, { ...a, forcePathStyle: !a.forcePathStyle })).toBe(true);
    expect(sameS3Location(a, { ...a, prefix: null })).toBe(false);
    expect(sameS3Location(a, { ...a, bucket: "abd" })).toBe(false);
    expect(sameS3Location(a, { ...a, endpoint: "https://t.example.com" })).toBe(false);
  });
});
