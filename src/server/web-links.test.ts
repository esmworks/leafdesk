import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));

const { checkWebLink } = await import("./web-links");
const { ConnectionFetchError } = await import("./connections/fetch");

type Fetcher = NonNullable<Parameters<typeof checkWebLink>[1]>;

/** A fetcher answering each method with the given status, or throwing what it is given. */
function answers(byMethod: Record<string, number | Error>) {
  const calls: string[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    calls.push(method);
    const answer = byMethod[method];
    if (answer instanceof Error) throw answer;
    return new Response(null, { status: answer });
  }) as unknown as Fetcher;
  return { fetcher, calls };
}

describe("checkWebLink", () => {
  it("takes a working HEAD as is", async () => {
    const { fetcher, calls } = answers({ HEAD: 200 });
    expect(await checkWebLink("https://example.com/", fetcher)).toEqual({ status: "ok", httpStatus: 200, reason: null });
    expect(calls).toEqual(["HEAD"]);
  });

  it("asks again with GET when HEAD gets an error", async () => {
    const { fetcher, calls } = answers({ HEAD: 405, GET: 200 });
    expect((await checkWebLink("https://example.com/", fetcher)).status).toBe("ok");
    expect(calls).toEqual(["HEAD", "GET"]);
    expect(await checkWebLink("https://example.com/", answers({ HEAD: 404, GET: 404 }).fetcher)).toEqual({
      status: "broken",
      httpStatus: 404,
      reason: "notFound",
    });
  });

  it("reads failures without an answer by their code", async () => {
    const noHost = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("getaddrinfo"), { code: "ENOTFOUND" }) });
    expect(await checkWebLink("https://gone.example/", answers({ HEAD: noHost }).fetcher)).toEqual({
      status: "unreachable",
      httpStatus: null,
      reason: "noHost",
    });
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    expect((await checkWebLink("https://slow.example/", answers({ HEAD: timeout }).fetcher)).reason).toBe("unreachable");
  });

  it("skips addresses the guard refuses", async () => {
    const blocked = new ConnectionFetchError("blocked", "A private address");
    expect((await checkWebLink("http://10.0.0.1/", answers({ HEAD: blocked }).fetcher)).status).toBe("skipped");
    const privateHost = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("private"), { code: "EBLOCKED" }) });
    expect((await checkWebLink("https://intranet.example/", answers({ HEAD: privateHost }).fetcher)).status).toBe("skipped");
  });
});
