import { describe, expect, it, vi } from "vitest";

// What Jira or GitHub answers is read only up to a size, so a site can't fill the server's memory.

vi.mock("@/server/connections/fetch", () => ({ checkConnectionUrl: vi.fn(), ConnectionFetchError: class extends Error {}, connectionFetch: vi.fn() }));

const { answerJson, JiraError } = await import("./client");

/** An answer streamed in chunks, without a Content-Length. */
function streamed(chunks: string[]) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      pull(controller) {
        const next = chunks.shift();
        if (next === undefined) controller.close();
        else controller.enqueue(encoder.encode(next));
      },
    }),
  );
}

describe("answerJson", () => {
  it("reads JSON, and what isn't as nothing", async () => {
    expect(await answerJson(new Response('{"displayName":"Ada"}'), 100)).toEqual({ displayName: "Ada" });
    expect(await answerJson(new Response("<html>sign in</html>"), 100)).toBeUndefined();
    expect(await answerJson(new Response(null, { status: 204 }), 100)).toBeUndefined();
  });

  it("refuses an answer past the limit, declared or streamed", async () => {
    const declared = new Response("[1]", { headers: { "content-length": "1000" } });
    await expect(answerJson(declared, 100)).rejects.toMatchObject({ code: "failed" });
    const big = streamed(['{"a":"', "x".repeat(80), "x".repeat(80), '"}']);
    const error = await answerJson(big, 100).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JiraError);
    expect(error).toMatchObject({ code: "failed" });
  });
});
