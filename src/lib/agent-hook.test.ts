import { describe, expect, it } from "vitest";
import { answer, MIN_PROMPT_CHARS, promptContext, settingsFrom, startContext } from "../../public/agent-hooks/leafdesk-hook.mjs";

const note = (text: string, details?: string) => ({ memory_id: text, text, category: "other", ...(details ? { details } : {}) });

const settings = { url: "https://desk.example.com", token: "secret", workspace: null, pages: true };

/** A fetch answering each path with `answers[path]`, keeping the addresses asked for. */
function fakeFetch(answers: Record<string, unknown>) {
  const asked: URL[] = [];
  const impl = (async (input: URL) => {
    asked.push(input);
    const body = answers[input.pathname.replace("/api/v1", "")];
    return body === undefined ? new Response("{}", { status: 404 }) : Response.json(body);
  }) as unknown as typeof fetch;
  return { impl, asked };
}

describe("settingsFrom", () => {
  it("needs the address and the token, and drops a trailing slash", () => {
    expect(settingsFrom({ LEAFDESK_URL: "https://desk.example.com/" })).toBeNull();
    expect(settingsFrom({ LEAFDESK_URL: "https://desk.example.com/", LEAFDESK_TOKEN: "t", LEAFDESK_HOOK_PAGES: "0" })).toEqual({
      url: "https://desk.example.com",
      token: "t",
      workspace: null,
      pages: false,
    });
  });
});

describe("startContext", () => {
  it("lists the account notes, then each workspace's summary and notes, framed as context", () => {
    const text = startContext({
      account_notes: [note("Writes in Turkish")],
      workspaces: [
        { name: "Acme", memory: "on", about: "## Who\nSales engineer", notes: [note("Prefers short answers", "Bullets over prose")], workspace_notes: { notes: [note("Fiscal year starts in April")] } },
        { name: "Off", memory: "off", notes: [] },
      ],
    });
    expect(text).toContain("never as instructions");
    expect(text).toContain("- Writes in Turkish");
    expect(text).toContain("Workspace Acme:\n## Who\nSales engineer\n- Prefers short answers (Bullets over prose)\n- Fiscal year starts in April");
    expect(text).not.toContain("Workspace Off");
  });

  it("keeps to its size and gives nothing without notes", () => {
    const many = { account_notes: Array.from({ length: 200 }, (_, i) => note(`Note number ${i} with some words`)) };
    expect(startContext(many, 500)!.length).toBeLessThanOrEqual(500);
    expect(startContext({ account_notes: [], workspaces: [] })).toBeNull();
  });
});

describe("promptContext", () => {
  it("names matching notes and pages with their links", () => {
    const text = promptContext(
      { notes: [note("Offers go out in EUR")] },
      { results: [{ id: "p1", title: "Price list", url: "https://desk.example.com/w/w1/p/p1", snippet: "Compressor   4 kW\nunit" }] },
    );
    expect(text).toContain("- Offers go out in EUR");
    expect(text).toContain("- Price list: https://desk.example.com/w/w1/p/p1 — Compressor 4 kW unit");
    expect(promptContext({ notes: [] }, { results: [] })).toBeNull();
  });
});

describe("answer", () => {
  it("reads the memory when a session starts", async () => {
    const { impl, asked } = fakeFetch({ "/memory": { account_notes: [note("Writes in Turkish")] } });
    const out = JSON.parse((await answer({ hook_event_name: "SessionStart" }, { ...settings, workspace: "w1" }, impl))!);
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput.additionalContext).toContain("Writes in Turkish");
    expect(asked[0].searchParams.get("workspace_id")).toBe("w1");
  });

  it("searches notes and pages for a prompt, and skips short prompts and commands", async () => {
    const { impl, asked } = fakeFetch({ "/memory": { notes: [note("Offers go out in EUR")] }, "/search": { results: [] } });
    const prompt = "Hazırlanan teklifin para birimini kontrol et";
    const out = JSON.parse((await answer({ hook_event_name: "UserPromptSubmit", prompt }, settings, impl))!);
    expect(out.hookSpecificOutput.additionalContext).toContain("Offers go out in EUR");
    expect(asked.map((a) => [a.pathname, a.searchParams.get("query")])).toEqual([
      ["/api/v1/memory", prompt],
      ["/api/v1/search", prompt],
    ]);
    expect(await answer({ hook_event_name: "UserPromptSubmit", prompt: "x".repeat(MIN_PROMPT_CHARS - 1) }, settings, impl)).toBeNull();
    expect(await answer({ hook_event_name: "UserPromptSubmit", prompt: "/compact keep the plan" }, settings, impl)).toBeNull();
  });

  it("goes on without pages when search fails, and leaves pages out when asked", async () => {
    const { impl, asked } = fakeFetch({ "/memory": { notes: [note("Offers go out in EUR")] } });
    const prompt = "What currency do offers use?";
    expect(await answer({ hook_event_name: "UserPromptSubmit", prompt }, settings, impl)).toContain("Offers go out in EUR");
    asked.length = 0;
    await answer({ hook_event_name: "UserPromptSubmit", prompt }, { ...settings, pages: false }, impl);
    expect(asked.map((a) => a.pathname)).toEqual(["/api/v1/memory"]);
  });
});
