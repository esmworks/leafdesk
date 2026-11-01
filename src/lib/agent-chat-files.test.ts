import { describe, expect, it } from "vitest";
import { AGENT_CHAT_FILE_LIMITS, ANSWER_FILE_LIMITS, agentChatFileType, answerFile, checkChatFiles } from "./agent-chat-files";

describe("agent chat files", () => {
  it("takes text files by extension, or by type without one", () => {
    expect(agentChatFileType("Orders.CSV")).toBe("text/csv");
    expect(agentChatFileType("notes.md", "application/octet-stream")).toBe("text/markdown");
    expect(agentChatFileType("data.json")).toBe("application/json");
    expect(agentChatFileType("report.pdf", "text/plain")).toBeNull();
    expect(agentChatFileType("README", "text/plain")).toBe("text/plain");
    expect(agentChatFileType("README", "image/png")).toBeNull();
  });

  it("checks a message's files: kind, text, size and count, naming repeats apart", () => {
    const ok = checkChatFiles([
      { name: "a.csv", text: "x,y\n1,2" },
      { name: "A.csv", text: "ç" },
    ]);
    expect(ok).toEqual({
      ok: true,
      files: [
        { name: "a.csv", size: 7, text: "x,y\n1,2" },
        { name: "A (2).csv", size: 2, text: "ç" },
      ],
    });
    expect(checkChatFiles([{ name: "x.exe", text: "MZ" }])).toEqual({ ok: false, problem: "type", name: "x.exe" });
    expect(checkChatFiles([{ name: "x.txt", text: "a\u0000b" }])).toEqual({ ok: false, problem: "binary", name: "x.txt" });
    expect(checkChatFiles([{ name: "big.txt", text: "a".repeat(AGENT_CHAT_FILE_LIMITS.bytes + 1) }])).toMatchObject({ ok: false, problem: "tooLarge" });
    const many = Array.from({ length: AGENT_CHAT_FILE_LIMITS.perMessage + 1 }, (_, i) => ({ name: `${i}.txt`, text: "a" }));
    expect(checkChatFiles(many)).toEqual({ ok: false, problem: "tooMany" });
  });

  it("counts a file's size in UTF-8 bytes, not characters", () => {
    const text = "ş".repeat(AGENT_CHAT_FILE_LIMITS.bytes / 2 + 1);
    expect(checkChatFiles([{ name: "tr.txt", text }])).toMatchObject({ ok: false, problem: "tooLarge" });
  });

  it("checks a file the agent attaches, a name without an extension becoming text", () => {
    expect(answerFile("Late orders.csv", "a,b")).toEqual({ ok: true, name: "Late orders.csv", contentType: "text/csv", size: 3 });
    expect(answerFile("summary", "Hello")).toMatchObject({ ok: true, name: "summary.txt", contentType: "text/plain" });
    expect(answerFile("../etc/passwd.md", "x")).toMatchObject({ ok: true, name: ".. etc passwd.md" });
    expect(answerFile("page.html", "<b>x</b>")).toEqual({ ok: false, problem: "type" });
    expect(answerFile("empty.md", "  \n")).toEqual({ ok: false, problem: "empty" });
    expect(answerFile("big.txt", "a".repeat(ANSWER_FILE_LIMITS.bytes + 1))).toEqual({ ok: false, problem: "tooLarge" });
  });
});
