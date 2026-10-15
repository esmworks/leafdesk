import { describe, expect, it } from "vitest";
import { BodyTooLargeError, readBodyLimited, readFormLimited } from "./request-body";

/** A body sent in chunks with no Content-Length, counting how much of it was pulled. */
function chunked(chunks: number, size: number) {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled === chunks) return controller.close();
      pulled++;
      controller.enqueue(new Uint8Array(size));
    },
  });
  const request = new Request("http://app.test/", { method: "POST", body, duplex: "half" } as RequestInit);
  return { request, pulled: () => pulled };
}

describe("readBodyLimited", () => {
  it("reads a body within the limit", async () => {
    const bytes = await readBodyLimited(new Request("http://app.test/", { method: "POST", body: "hello" }), 5);
    expect(new TextDecoder().decode(bytes)).toBe("hello");
    expect((await readBodyLimited(new Request("http://app.test/"), 5)).byteLength).toBe(0);
  });

  it("refuses a declared length over the limit before reading", async () => {
    const request = new Request("http://app.test/", { method: "POST", body: "x", headers: { "content-length": "1000" } });
    await expect(readBodyLimited(request, 10)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(request.bodyUsed).toBe(false);
  });

  it("stops reading a chunked body one chunk past the limit", async () => {
    const { request, pulled } = chunked(1000, 1024);
    await expect(readBodyLimited(request, 4 * 1024)).rejects.toThrow(BodyTooLargeError);
    expect(pulled()).toBeLessThan(10);
  });
});

describe("readFormLimited", () => {
  it("parses form data within the limit and refuses it beyond", async () => {
    const form = new FormData();
    form.set("name", "memo");
    form.set("audio", new File(["abc"], "memo.webm", { type: "audio/webm" }));
    const parsed = await readFormLimited(new Request("http://app.test/", { method: "POST", body: form }), 10_000);
    expect(parsed.get("name")).toBe("memo");
    expect(await (parsed.get("audio") as File).text()).toBe("abc");

    const big = new FormData();
    big.set("audio", new File([new Uint8Array(20_000)], "memo.webm"));
    // Encoded first: a FormData body streamed by fetch fails on its own once the reader cancels.
    const encoded = new Response(big);
    const request = new Request("http://app.test/", {
      method: "POST",
      body: await encoded.arrayBuffer(),
      headers: { "content-type": encoded.headers.get("content-type")! },
    });
    await expect(readFormLimited(request, 10_000)).rejects.toBeInstanceOf(BodyTooLargeError);
  });
});
