/**
 * A stand-in for an OpenAI-compatible server (chat completions with streaming and tool calls,
 * embeddings and speech to text), for tests and the e2e scripts (scripts/semantic-search-e2e.ts, ai-chat-e2e.ts): the
 * app talks to it over HTTP exactly as it would to Ollama, vLLM or OpenAI. Embeddings are a
 * deterministic hashed bag of words, with a few synonyms folded together so "meaning" can be
 * tested without a model. The app itself never imports this.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const FAKE_DIMENSIONS = 256;

/** Words that mean the same to the fake model (each maps to the first of its group). */
const SYNONYMS: string[][] = [
  ["car", "automobile", "vehicle", "cars", "automobiles", "vehicles"],
  ["dog", "puppy", "canine", "dogs", "puppies", "hound"],
  ["money", "budget", "budgets", "funds", "cash", "spending"],
  ["holiday", "vacation", "holidays", "vacations", "leave", "time-off"],
  ["doctor", "physician", "doctors", "physicians"],
];
const CANONICAL = new Map(SYNONYMS.flatMap((group) => group.map((w) => [w, group[0]] as const)));
const STOPWORDS = new Set(
  "a an and are as at be by for from has have how i in is it its of on or our the their them this to was we what when where which who why will with you your do does did about".split(
    " ",
  ),
);

/** The words the fake model sees in a text, synonyms folded. */
export function fakeTokens(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}-]+/gu) ?? [])
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map((w) => CANONICAL.get(w) ?? w);
}

function hash(word: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < word.length; i++) {
    h ^= word.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A deterministic embedding: word counts hashed into FAKE_DIMENSIONS buckets. */
export function fakeEmbedding(text: string, dimensions = FAKE_DIMENSIONS): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  for (const word of fakeTokens(text)) vector[hash(word) % dimensions] += 1;
  return vector;
}

export type FakeChatMessage = {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: string | { type: string; text?: string }[] | null;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
};

export type FakeChatRequest = { model: string; messages: FakeChatMessage[]; tools?: { function: { name: string } }[] };

/**
 * What the fake model answers: text, tool calls, or both, after thinking (streamed as
 * `reasoning_content`) when given. Throwing makes the server answer 500.
 */
export type FakeReply = { text?: string; thinking?: string; toolCalls?: { name: string; arguments: Record<string, unknown> }[] };

export const textOf = (content: FakeChatMessage["content"]) =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => c.text ?? "").join("") : "";

export type FakeOpenAi = {
  /** The `/v1` root, for AI_BASE_URL and AI_EMBEDDINGS_BASE_URL. */
  baseUrl: string;
  chats: FakeChatRequest[];
  /** Every text sent for embedding, in order. */
  embedded: string[];
  /** Every recording sent to be transcribed: its file name, size, model and the language it named. */
  transcribed: { name: string; size: number; model: string; language?: string }[];
  /** What a recording reads as (a function of its size and file name). */
  setTranscript(text: (audio: { name: string; size: number }) => string): void;
  /** Milliseconds between streamed pieces (for cancelling mid-answer). */
  delayMs: number;
  /** The bearer key of every request, in order (null without one). */
  keys: (string | null)[];
  /** Answers 401 to requests without one of these keys; null takes any (the default). */
  setAcceptedKeys(keys: string[] | null): void;
  setChat(reply: (request: FakeChatRequest) => FakeReply | Promise<FakeReply>): void;
  close(): Promise<void>;
};

async function readBody(req: IncomingMessage) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

export async function startFakeOpenAi(
  reply: (request: FakeChatRequest) => FakeReply | Promise<FakeReply> = () => ({ text: "ok" }),
  { port = 0 }: { port?: number } = {},
) {
  let answer = reply;
  let transcript = (_audio: { name: string; size: number }) => "This is a test recording.";
  let accepted: string[] | null = null;
  const state: FakeOpenAi = {
    baseUrl: "",
    chats: [],
    embedded: [],
    transcribed: [],
    delayMs: 0,
    keys: [],
    setAcceptedKeys(next) {
      accepted = next;
    },
    setTranscript(next) {
      transcript = next;
    },
    setChat(next) {
      answer = next;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  const server: Server = createServer(async (req, res) => {
    try {
      const key = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? null;
      state.keys.push(key);
      if (accepted && (!key || !accepted.includes(key))) {
        for await (const _ of req) void _;
        res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "Incorrect API key provided", type: "invalid_request_error" } }));
        return;
      }
      if (req.url === "/v1/audio/transcriptions") {
        // Multipart: the fields are read through the platform's own parser.
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const form = await new Response(Buffer.concat(chunks), { headers: { "Content-Type": req.headers["content-type"] ?? "" } }).formData();
        const file = form.get("file");
        if (!(file instanceof File) || !form.get("model")) {
          res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "file and model are required" } }));
          return;
        }
        const audio = { name: file.name, size: file.size };
        const language = form.get("language");
        state.transcribed.push({ ...audio, model: String(form.get("model")), ...(typeof language === "string" ? { language } : {}) });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ text: transcript(audio) }));
        return;
      }
      const body = await readBody(req);
      if (req.url === "/v1/embeddings") {
        const input = (Array.isArray(body.input) ? body.input : [body.input]) as string[];
        state.embedded.push(...input);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: input.map((t, index) => ({ index, embedding: fakeEmbedding(String(t)) })), usage: { prompt_tokens: input.length } }));
        return;
      }
      if (req.url !== "/v1/chat/completions") {
        res.writeHead(404).end();
        return;
      }
      const request = body as unknown as FakeChatRequest;
      state.chats.push(request);
      const out = await answer(request);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      let closed = false;
      res.on("close", () => (closed = true));
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
        `data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 1, model: request.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      const pause = () => (state.delayMs ? new Promise((r) => setTimeout(r, state.delayMs)) : Promise.resolve());
      res.write(chunk({ role: "assistant", content: "" }));
      for (const piece of (out.thinking ?? "").match(/\S+\s*|\s+/g) ?? []) {
        if (closed) return;
        await pause();
        res.write(chunk({ reasoning_content: piece }));
      }
      // Word by word, as a model streams.
      for (const piece of (out.text ?? "").match(/\S+\s*|\s+/g) ?? []) {
        if (closed) return;
        await pause();
        res.write(chunk({ content: piece }));
      }
      (out.toolCalls ?? []).forEach((call, index) => {
        res.write(
          chunk({ tool_calls: [{ index, id: `call_${state.chats.length}_${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }),
        );
      });
      res.write(chunk({}, out.toolCalls?.length ? "tool_calls" : "stop"));
      res.write(`data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 1, model: request.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    } catch (error) {
      // An error with a `status` answers with it (400 for a prompt the model can't take), others with 500.
      if (!res.headersSent) res.writeHead((error as { status?: number }).status ?? 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: (error as Error).message } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  state.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return state;
}
