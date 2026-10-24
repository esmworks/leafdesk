/**
 * The AI chat on the web, where the workspace's owners turned web search on and the server has a
 * search service (lib/web-search.ts): `search_web` and `read_web_page`, as agents with web access
 * have them (agents/web.ts), read-only. Pages are fetched through the same guard: public http(s)
 * addresses only, checked on every redirect, within a time and size limit. Results come back
 * framed as data from outside and are numbered sources the answer cites by their address.
 *
 * Web text is anyone's: once an answer read from the web, ai-chat.ts asks the person before every
 * change and note for the rest of it, even in Auto; research mode has no tools that change anything.
 *
 * Also the research mode's plan (`plan_research`), the sub-questions a report sets out to answer.
 */
import { WEB_TOOL_NAMES } from "@/lib/agents";
import type { AiTool } from "@/server/ai";
import { chatWebTools, readWebPage, searchWeb, WEB_PAGE_CHARS, WebPageError, webSearchService, type WebFetchGuard } from "@/server/agents/web";
import { formatSources } from "@/server/ai/prompts";
import { registerWeb, type Registry, type ToolOutcome } from "@/server/ai-tools";
import { externalData } from "@/server/connections/tools";
import { workspaceSettings } from "@/server/workspaces";

/** The sub-questions a research plan may have, and the longest one. */
const MAX_PLAN = 8;
const PLAN_QUESTION_CHARS = 300;

export const PLAN_TOOL: AiTool = {
  name: "plan_research",
  description: "Sets out the research: the sub-questions that together answer the question, which are shown to the person. Call it once, first.",
  parameters: {
    type: "object",
    properties: { questions: { type: "array", items: { type: "string" }, description: "2 to 6 short sub-questions, in the language of the question." } },
    required: ["questions"],
    additionalProperties: false,
  },
};

export const isChatWebTool = (name: string) => name === WEB_TOOL_NAMES.search || name === WEB_TOOL_NAMES.read;

/** Whether the workspace's chat may search the web: its owners turned it on, and the server has a search service. */
export async function chatWebOn(workspaceId: string): Promise<boolean> {
  if (!webSearchService()) return false;
  return (await workspaceSettings(workspaceId)).aiWebSearch === true;
}

/** The web tools to offer, where chatWebOn. */
export const chatWebToolset = (): AiTool[] => chatWebTools();

/** Answers plan_research: the plan as a step, and on to the research. */
export function runPlan(call: { arguments: Record<string, unknown> }): ToolOutcome {
  const raw = Array.isArray(call.arguments.questions) ? call.arguments.questions : [];
  const questions = raw
    .filter((q): q is string => typeof q === "string")
    .map((q) => q.replace(/\s+/g, " ").trim().slice(0, PLAN_QUESTION_CHARS))
    .filter(Boolean)
    .slice(0, MAX_PLAN);
  if (!questions.length) return { content: "plan_research needs the sub-questions.", isError: true };
  return { content: "The plan is noted. Now research each sub-question with the tools, then write the report.", step: { kind: "plan", questions } };
}

/**
 * Runs search_web or read_web_page for the chat with at most `room` characters of what comes back,
 * registering what it found as numbered sources. `guard`, `env` and `fetcher` are for tests.
 */
export async function runChatWebTool(
  call: { name: string; arguments: Record<string, unknown> },
  registry: Registry,
  room: number,
  { guard, env, fetcher }: { guard?: WebFetchGuard; env?: Record<string, string | undefined>; fetcher?: typeof fetch } = {},
): Promise<ToolOutcome> {
  if (room < 1_000) return { content: "There is no room left in this request to read more from the web. Answer with what you have.", isError: true };
  if (call.name === WEB_TOOL_NAMES.search) {
    const query = typeof call.arguments.query === "string" ? call.arguments.query.replace(/\s+/g, " ").trim().slice(0, 500) : "";
    if (!query) return { content: `${WEB_TOOL_NAMES.search} needs a query.`, isError: true };
    try {
      const results = await searchWeb(query, { env, fetcher });
      const entries = results.map((r) => registerWeb(registry, { url: r.url, title: r.title || r.url, text: r.snippet || r.title || r.url }));
      const text = entries.length ? formatSources(entries) : "No results.";
      return {
        content: externalData(`The web search results for "${query.replace(/"/g, "'")}" follow; read the best ones with ${WEB_TOOL_NAMES.read}.`, text.slice(0, room)),
        step: { kind: "web", action: "search", query, results: entries.length },
      };
    } catch (error) {
      if (!(error instanceof WebPageError)) throw error;
      return { content: `${error.message}. Don't search the web again for this question.`, isError: true, step: { kind: "web", action: "search", query, results: 0 } };
    }
  }
  const url = typeof call.arguments.url === "string" ? call.arguments.url.trim().slice(0, 2_000) : "";
  if (!url) return { content: `${WEB_TOOL_NAMES.read} needs a url.`, isError: true };
  try {
    const page = await readWebPage(url, { maxChars: Math.max(0, Math.min(WEB_PAGE_CHARS, room - 500)), guard });
    const entry = registerWeb(registry, {
      url: page.url,
      title: page.title || page.url,
      text: page.text || "(no text)",
      note: page.truncated ? "only the start of the page" : undefined,
    });
    return {
      content: externalData(`The web page at ${page.url} follows.`, formatSources([entry])),
      step: { kind: "web", action: "read", url: page.url, title: page.title, outcome: "done" },
    };
  } catch (error) {
    if (!(error instanceof WebPageError)) throw error;
    const why =
      error.code === "blocked"
        ? "only public web pages can be read"
        : error.code === "unsupported"
          ? `${WEB_TOOL_NAMES.read} reads web pages and text only`
          : "don't try it again for this question";
    return { content: `${error.message}: ${why}.`, isError: true, step: { kind: "web", action: "read", url, title: "", outcome: "failed" } };
  }
}
