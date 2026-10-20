/**
 * The AI quality eval: runs the Turkish tasks of scripts/ai-eval/tasks.ts through Leafdesk's own
 * code paths (chat, AI autofill, the writing assistant, agents) against a demo workspace seeded
 * fresh for each model, grades them, and writes a timestamped JSON and a Markdown table (score,
 * tokens, cost and time per task and model) to data/ai-eval/. See scripts/ai-eval/README.md.
 *
 *   pnpm tsx scripts/ai-eval.ts                                   # dry run on the fake model
 *   pnpm tsx scripts/ai-eval.ts --model fake,fake-wrong           # …and show the graders fail
 *   pnpm tsx scripts/ai-eval.ts --model claude-haiku-5-5 --spend  # a real model (costs money)
 *
 * Flags: --model a,b (fake, fake-wrong or an Anthropic model id; AI_EVAL_MODELS), --judge <model>
 * (claude-opus-5-5; the fake models are judged by a fake), --tasks <id prefixes>, --repeat <n>,
 * --set KEY=VALUE (extra AI_* settings for the model under test), --spend (needed for any real
 * model), --keep (leave the seeded workspaces), --seed-only (seed one demo workspace and stop),
 * --out <dir>, --regrade <results.json> (grade a saved run's outputs again, no model called).
 *
 * Env: AI_EVAL_DATABASE_URL (default postgres://leafdesk:leafdesk@localhost:5432/leafdesk_aieval;
 * DATABASE_URL is never used, so the eval can't write into another database by accident; only a
 * local server is accepted), ANTHROPIC_API_KEY (or AI_API_KEY) for real models. Run it with no app
 * server on the same database: the server's workers would take the agents' runs.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// ------------------------------------------------------------------------------------ flags

const argv = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const next = argv[i + 1];
  return next && !next.startsWith("--") ? next : "";
}
const flags = (name: string) => argv.flatMap((a, i) => (a === `--${name}` && argv[i + 1] ? [argv[i + 1]] : []));

const models = (flag("model") || process.env.AI_EVAL_MODELS || "fake").split(",").map((m) => m.trim()).filter(Boolean);
const judgeModel = flag("judge") || "claude-opus-5-5";
const taskFilter = (flag("tasks") || "").split(",").map((t) => t.trim()).filter(Boolean);
const repeat = Math.max(1, Number(flag("repeat") || 1));
const spend = flag("spend") !== undefined;
const keep = flag("keep") !== undefined;
const seedOnly = flag("seed-only") !== undefined;
const outDir = flag("out") || "data/ai-eval";
const regradeFile = flag("regrade");
const extraEnv = Object.fromEntries(flags("set").map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));

const isFake = (model: string) => model === "fake" || model === "fake-wrong";
const real = [...models.filter((m) => !isFake(m)), ...(models.some((m) => !isFake(m)) ? [judgeModel] : [])];
if (real.length && !spend) {
  console.error(`Real models (${[...new Set(real)].join(", ")}) cost money. Run the fake model first, then add --spend to call them.`);
  process.exit(2);
}
const apiKey = process.env.AI_EVAL_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? process.env.AI_API_KEY;
if (real.length && !apiKey) {
  console.error("Set ANTHROPIC_API_KEY (or AI_EVAL_API_KEY) for the real models.");
  process.exit(2);
}

// The eval's own database, always local.
const databaseUrl = process.env.AI_EVAL_DATABASE_URL ?? "postgres://leafdesk:leafdesk@localhost:5432/leafdesk_aieval";
const host = new URL(databaseUrl).hostname;
if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
  console.error(`AI_EVAL_DATABASE_URL must point at a local database, not ${host}.`);
  process.exit(2);
}
process.env.DATABASE_URL = databaseUrl;
process.env.BETTER_AUTH_SECRET ??= "ai-eval-local-only-secret-0000000000000000000";
process.env.APP_URL ??= "http://localhost:3000";
// The server's AI settings and own AI accounts play no part: each model is set up below.
process.env.OWN_AI_KEYS_ENABLED = "false";

// Imported after the environment is set: the database client reads DATABASE_URL when it is created.
const { mkdirSync, writeFileSync } = await import("node:fs");
const { and, eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { aiPropertyState, page } = await import("@/db/schema");
const { getCollab, registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { addProperty } = await import("@/server/databases");
const { complete, isAiError } = await import("@/server/ai");
const { setAiEnv, resetAi } = await import("@/server/ai/testing");
const { startFakeOpenAi } = await import("@/server/ai/fake-openai");
type FakeChatRequest = import("@/server/ai/fake-openai").FakeChatRequest;
type FakeReply = import("@/server/ai/fake-openai").FakeReply;
const { startChat } = await import("@/server/ai-chat");
const { decideChange } = await import("@/server/ai-chat-approvals");
const { startEditorAction } = await import("@/server/ai-writing");
const { isQueued, requestAutofill, setAutofill } = await import("@/server/ai-properties");
const agents = await import("@/server/agents/manage");
const { requestAgentRun } = await import("@/server/agents/requests");
const { flushAgentRuns } = await import("@/server/agents/run");
const { deleteEvalWorkspaces, seedEvalWorkspace } = await import("./ai-eval/seed");
const { TASKS } = await import("./ai-eval/tasks");
const { fold, JUDGE_SYSTEM, judgePrompt, readVerdict, score, turkishCheck } = await import("./ai-eval/grade");
type EvalSeed = import("./ai-eval/seed").EvalSeed;
type EvalTask = import("./ai-eval/tasks").EvalTask;
type RowView = import("./ai-eval/tasks").RowView;
type TaskContext = import("./ai-eval/tasks").TaskContext;
type Variant = import("./ai-eval/tasks").Variant;
type Check = import("./ai-eval/grade").Check;

// Grading a saved run again needs neither the fake model nor the collaboration service.
if (regradeFile) {
  const { regrade } = await import("./ai-eval/regrade");
  await regrade(regradeFile);
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
  process.exit(0);
}

const { hocuspocus, service } = createCollab();
registerCollab(service);

/** Prices in USD per million tokens (pi-ai's catalog, Oct 2026), for the estimate of a real run. */
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
};

const LIMITS = { AI_RATE_LIMIT: "100000", AI_WORKSPACE_RATE_LIMIT: "100000", AI_TIMEOUT_SECONDS: "240" };

// --------------------------------------------------------------------------- usage from logs

type Usage = { requests: number; inputTokens: number; outputTokens: number; costUsd: number; failed: number };
const zero = (): Usage => ({ requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, failed: 0 });
let sink: Usage | null = null;

// Every AI request logs one "[ai] feature=… in=… out=… cost=$…" line: the eval reads its usage
// from there, so it counts every request a feature makes (an agent's turns, each autofill cell).
for (const level of ["log", "warn"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    const line = typeof args[0] === "string" ? args[0] : "";
    if (line.startsWith("[ai] feature=")) {
      if (sink) {
        sink.requests++;
        sink.inputTokens += Number(/\bin=(\d+)/.exec(line)?.[1] ?? 0);
        sink.outputTokens += Number(/\bout=(\d+)/.exec(line)?.[1] ?? 0);
        sink.costUsd += Number(/\bcost=\$([\d.]+)/.exec(line)?.[1] ?? 0);
        if (!/\bstatus=ok\b/.test(line)) sink.failed++;
      }
      if (!/\bstatus=ok\b/.test(line)) original(line);
      return;
    }
    original(...args);
  };
}

// ------------------------------------------------------------------------------- the fake model

const fake = await startFakeOpenAi();
/** What the fake model sent and got per task, for the cost estimate. */
type Traffic = { requests: number; inputChars: number; outputChars: number };
let traffic: Traffic = { requests: 0, inputChars: 0, outputChars: 0 };
let fakeReply: (request: FakeChatRequest) => FakeReply = () => ({ text: "?" });
fake.setChat((request) => {
  const reply = fakeReply(request);
  traffic.requests++;
  traffic.inputChars += JSON.stringify(request.messages).length + JSON.stringify(request.tools ?? []).length;
  traffic.outputChars += (reply.text ?? "").length + JSON.stringify(reply.toolCalls ?? []).length;
  return reply;
});

const lastUserText = (request: FakeChatRequest) => {
  const users = request.messages.filter((m) => m.role === "user");
  const c = users[users.length - 1]?.content;
  return typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => x.text ?? "").join("") : "";
};

function selectModel(model: string) {
  if (isFake(model)) {
    setAiEnv({ AI_PROVIDER: "openai-compatible", AI_MODEL: "fake-eval", AI_BASE_URL: fake.baseUrl, ...LIMITS, ...extraEnv });
  } else {
    setAiEnv({ AI_PROVIDER: "anthropic", AI_MODEL: model, AI_API_KEY: apiKey, ...LIMITS, ...extraEnv });
  }
}

// ----------------------------------------------------------------------------------- reading

async function readRows(seed: EvalSeed, where: ReturnType<typeof eq>): Promise<RowView[]> {
  const found = await db.select({ id: page.id, title: page.title, parentId: page.parentId, properties: page.properties }).from(page).where(where);
  const titles = new Map(
    (await db.select({ id: page.id, title: page.title }).from(page).where(eq(page.workspaceId, seed.workspaceId))).map((p) => [p.id, p.title]),
  );
  const names: Record<string, string> = {};
  for (const props of Object.values(seed.props)) for (const [name, id] of Object.entries(props)) names[id] = name;
  return found.map((r) => {
    const values: Record<string, unknown> = {};
    for (const [id, value] of Object.entries(r.properties ?? {})) {
      const name = names[id] ?? id;
      if (Array.isArray(value)) values[name] = value.map((v) => (typeof v === "string" ? (titles.get(v) ?? seed.optionNames[v] ?? v) : v));
      else if (typeof value === "string" && seed.optionNames[value]) values[name] = seed.optionNames[value];
      else values[name] = value;
    }
    return { id: r.id, title: r.title, values };
  });
}

function contextFor(seed: EvalSeed): TaskContext & { snapshot(): Promise<void> } {
  const databases = Object.values(seed.databases);
  let before = new Map<string, string>();
  const all = () => readRows(seed, inArray(page.parentId, databases));
  return {
    seed,
    row: async (rowId) => (await readRows(seed, eq(page.id, rowId)))[0],
    rows: (databaseId) => readRows(seed, eq(page.parentId, databaseId)),
    async snapshot() {
      before = new Map((await all()).map((r) => [r.id, JSON.stringify([r.title, r.values])]));
    },
    async changed() {
      return (await all()).filter((r) => before.get(r.id) !== JSON.stringify([r.title, r.values])).map((r) => r.title);
    },
  };
}

// ------------------------------------------------------------------------------------ running

type TaskResult = {
  id: string;
  kind: EvalTask["kind"];
  title: string;
  attempt: number;
  score: number;
  checks: Check[];
  output: string;
  error: string | null;
  ms: number;
  usage: Usage;
  judge?: { score: number; reason: string; usage: Usage } | null;
  traffic?: Traffic;
};

const errorText = (error: unknown) => (isAiError(error) ? `${error.code}: ${error.message}` : error instanceof Error ? `${error.name}: ${error.message}` : String(error));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runChat(task: Extract<EvalTask, { kind: "chat" }>, seed: EvalSeed) {
  let text = "";
  let error: string | null = null;
  let approvals = 0;
  const steps: string[] = [];
  const events = await startChat(seed.ownerId, {
    workspaceId: seed.workspaceId,
    message: task.question,
    mode: task.mode ?? "ask",
    ...(task.scope ? { scope: { pageId: task.scope(seed) } } : {}),
  });
  for await (const event of events) {
    if (event.type === "text") text += event.text;
    if (event.type === "reset") text = "";
    if (event.type === "step") steps.push(event.step.kind);
    if (event.type === "error") error = event.code;
    // A question that only reads: a change it asks to make is declined (and counted).
    if (event.type === "approval") {
      approvals++;
      decideChange(seed.ownerId, event.id, "decline");
    }
  }
  return { text, steps, error, approvals };
}

async function settleAutofill(propertyId: string, rowIds: string[], timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const pending = await db
      .select({ rowId: aiPropertyState.rowId })
      .from(aiPropertyState)
      .where(and(eq(aiPropertyState.propertyId, propertyId), eq(aiPropertyState.status, "pending")));
    if (!pending.length && rowIds.every((id) => !isQueued(id, propertyId))) return;
    await sleep(100);
  }
  throw new Error("AI values did not settle in time");
}

async function runTask(task: EvalTask, seed: EvalSeed, ctx: ReturnType<typeof contextFor>, agentId: string, variant: Variant | null): Promise<Omit<TaskResult, "attempt" | "usage" | "ms">> {
  if (variant) {
    if (task.kind === "chat" || task.kind === "agent") fakeReply = task.fake(seed, variant);
    else if (task.kind === "autofill") {
      const answer = task.fake(variant);
      fakeReply = (request) => ({ text: answer(lastUserText(request)) });
    } else {
      const answer = task.fake(variant);
      fakeReply = () => ({ text: answer });
    }
  }
  const base = { id: task.id, kind: task.kind, title: task.title };
  try {
    switch (task.kind) {
      case "chat": {
        const out = await runChat(task, seed);
        const checks = out.error ? [{ name: `the chat failed (${out.error})`, pass: false }] : await task.grade(out, ctx);
        if (out.approvals && task.mode !== "auto") checks.push({ name: "asked to change something on a question that only reads", pass: false, detail: String(out.approvals) });
        if (!out.error) checks.push(turkishCheck(out.text));
        return { ...base, score: out.error ? 0 : score(checks), checks, output: out.text, error: out.error };
      }
      case "autofill": {
        const databaseId = seed.databases[task.database];
        const property = await addProperty(seed.ownerId, databaseId, { name: task.property, type: "text" });
        await setAutofill(seed.ownerId, property.id, { mode: "custom", prompt: task.prompt, includeBody: task.includeBody ?? false });
        const cases = task.cases(seed);
        await requestAutofill(seed.ownerId, property.id, cases.map((c) => c.rowId));
        await settleAutofill(property.id, cases.map((c) => c.rowId), 10 * 60_000);
        const checks: Check[] = [];
        const lines: string[] = [];
        for (const c of cases) {
          const [row] = await db.select({ properties: page.properties }).from(page).where(eq(page.id, c.rowId));
          const value = String(row.properties[property.id] ?? "").trim();
          const pass =
            task.compare === "word"
              ? fold(value.replace(/[.!]+$/, "")) === fold(c.expected)
              : task.compare === "email"
                ? value.toLowerCase() === c.expected.toLowerCase()
                : value === c.expected;
          checks.push({ name: `${c.label}: ${c.expected}`, pass, detail: value });
          lines.push(`${c.label}: ${value}`);
        }
        return { ...base, score: score(checks), checks, output: lines.join("\n"), error: null };
      }
      case "writing": {
        const answer = await startEditorAction(seed.ownerId, {
          pageId: task.page ? task.page(seed) : seed.pages.drafts,
          action: task.action,
          ...(task.text ? { text: task.text } : {}),
          ...(task.instruction ? { instruction: task.instruction } : {}),
        });
        const { text } = await answer.result();
        const checks = [...task.grade(text), turkishCheck(text)];
        return { ...base, score: score(checks), checks, output: text, error: null };
      }
      case "agent": {
        const run = await requestAgentRun(seed.ownerId, agentId, { task: task.task, rowId: task.row(seed), via: "api" });
        await flushAgentRuns();
        const done = await agents.getAgentRun(seed.ownerId, agentId, run.id);
        const out = { status: done.status, code: done.code, answer: done.answer, steps: done.steps.length };
        const checks = await task.grade(out, ctx);
        return { ...base, score: score(checks), checks, output: done.answer || `${done.status}${done.code ? ` (${done.code})` : ""}`, error: done.code };
      }
    }
  } catch (error) {
    return { ...base, score: 0, checks: [{ name: "the task ran", pass: false, detail: errorText(error) }], output: "", error: errorText(error) };
  }
}

const AGENT_INSTRUCTIONS =
  "Örnek Soğutma'nın operasyon asistanısın. Teklif, iş ve müşteri kayıtlarını düzenli tutarsın. Yalnızca görevde istenen değişikliği yap; emin olmadığın bir şeyi değiştirme.";

async function setUpAgent(seed: EvalSeed) {
  const agent = await agents.createAgent(seed.ownerId, seed.workspaceId, { name: "Operasyon asistanı", instructions: AGENT_INSTRUCTIONS });
  for (const id of Object.values(seed.databases)) await agents.setAgentAccess(seed.ownerId, agent.id, id, "edit");
  for (const id of Object.values(seed.pages)) await agents.setAgentAccess(seed.ownerId, agent.id, id, "view");
  return agent.id;
}

/** The judge's verdict on a writing task's output, with what it cost. */
async function judge(task: Extract<EvalTask, { kind: "writing" }>, result: TaskResult, seed: EvalSeed, variant: Variant | null) {
  const usage = zero();
  sink = usage;
  try {
    if (variant) fakeReply = () => ({ text: JSON.stringify({ score: variant === "right" ? 5 : 2, reason: "fake judge" }) });
    // A summary is judged against the page it summarizes, title included: the model sees the title too.
    const page = !task.text && task.page ? await getCollab().readPage(task.page(seed)) : null;
    const input = task.text ?? (page ? `Page title: ${page.title}\n\n${page.markdown}` : "");
    const answer = await complete({
      feature: "eval.judge",
      userId: seed.ownerId,
      workspaceId: seed.workspaceId,
      system: JUDGE_SYSTEM,
      messages: [{ role: "user", content: judgePrompt({ task: task.judge.task, rubric: task.judge.rubric, input, output: result.output }) }],
      thinking: "low",
    });
    const verdict = readVerdict(answer.text);
    return verdict ? { ...verdict, usage } : { score: 0, reason: `unreadable verdict: ${answer.text.slice(0, 200)}`, usage };
  } catch (error) {
    return { score: 0, reason: `judge failed: ${errorText(error)}`, usage };
  } finally {
    sink = null;
  }
}

// ------------------------------------------------------------------------------------- main

const startedAt = new Date();
const stamp = startedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19);
const runs: string[] = [];
const selected = TASKS.filter((t) => !taskFilter.length || taskFilter.some((f) => t.id.startsWith(f)));
type ModelReport = { model: string; judge: string; workspaceRun: string; results: TaskResult[]; totals: Usage & { ms: number; judgeCostUsd: number } };
const reports: ModelReport[] = [];
let failed = false;

try {
  if (seedOnly) {
    const run = `aieval-demo-${Date.now().toString(36)}`;
    const seed = await seedEvalWorkspace(run, "AI değerlendirme demo");
    await setUpAgent(seed);
    console.log(`Seeded workspace ${seed.workspaceId} (owner ${seed.ownerId}) in ${databaseUrl}. Delete it with: DELETE FROM workspace WHERE id = '${seed.workspaceId}';`);
  } else {
    console.log(`AI eval: ${selected.length} tasks × ${repeat} on ${models.join(", ")} (judge: ${models.every(isFake) ? "fake" : judgeModel})\n`);
    for (const model of models) {
      const variant: Variant | null = model === "fake" ? "right" : model === "fake-wrong" ? "wrong" : null;
      const results: TaskResult[] = [];
      let run = "";
      console.log(`── ${model}`);
      // Every attempt starts from freshly seeded data, in a workspace of its own.
      for (let attempt = 1; attempt <= repeat; attempt++) {
        run = `aieval-${model.replace(/[^a-z0-9]+/gi, "-")}-${Date.now().toString(36)}`;
        runs.push(run);
        const seed = await seedEvalWorkspace(run, `AI değerlendirme · ${model} · ${stamp}${repeat > 1 ? ` · ${attempt}` : ""}`);
        const agentId = await setUpAgent(seed);
        const ctx = contextFor(seed);
        if (repeat > 1) console.log(`   attempt ${attempt}`);
        for (const task of selected) {
          selectModel(model);
          await ctx.snapshot();
          const usage = zero();
          traffic = { requests: 0, inputChars: 0, outputChars: 0 };
          sink = usage;
          const started = performance.now();
          const outcome = await runTask(task, seed, ctx, agentId, variant);
          const ms = performance.now() - started;
          sink = null;
          const result: TaskResult = { ...outcome, attempt, usage, ms, ...(variant ? { traffic: { ...traffic } } : {}) };
          // Every task asks the model at least once: no usage read means the "[ai]" log line changed.
          if (!usage.requests && !result.error) {
            result.checks.push({ name: "usage was read from the [ai] log line (its format changed?)", pass: false });
            result.score = score(result.checks);
          }
          if (task.kind === "writing" && !result.error) {
            if (!variant) selectModel(judgeModel);
            const verdict = await judge(task, result, seed, variant);
            result.judge = verdict;
            result.checks.push({ name: "judge", pass: verdict.score >= 4, score: Math.max(0, (verdict.score - 1) / 4), weight: 2, detail: verdict.reason });
            result.score = score(result.checks);
          }
          results.push(result);
          const misses = result.checks.filter((c) => !c.pass).map((c) => c.name);
          console.log(`   ${(result.score * 100).toFixed(0).padStart(3)}%  ${task.id.padEnd(26)} ${(ms / 1000).toFixed(1).padStart(6)}s  ${misses.length ? `✗ ${misses.join("; ")}` : ""}`);
        }
      }
      const totals = results.reduce(
        (t, r) => ({
          requests: t.requests + r.usage.requests,
          inputTokens: t.inputTokens + r.usage.inputTokens,
          outputTokens: t.outputTokens + r.usage.outputTokens,
          costUsd: t.costUsd + r.usage.costUsd,
          failed: t.failed + r.usage.failed,
          ms: t.ms + r.ms,
          judgeCostUsd: t.judgeCostUsd + (r.judge?.usage.costUsd ?? 0),
        }),
        { ...zero(), ms: 0, judgeCostUsd: 0 },
      );
      reports.push({ model, judge: variant ? "fake" : judgeModel, workspaceRun: run, results, totals });
      const mean = results.reduce((n, r) => n + r.score, 0) / (results.length || 1);
      console.log(`   mean ${(mean * 100).toFixed(1)}%, ${totals.requests} requests, ${totals.inputTokens} in / ${totals.outputTokens} out tokens, $${totals.costUsd.toFixed(4)} (+ judge $${totals.judgeCostUsd.toFixed(4)})\n`);
      if (variant === "right" && results.some((r) => r.score < 1)) failed = true;
      if (variant === "wrong") {
        const blind = results.filter((r) => r.score >= 1);
        if (blind.length) {
          failed = true;
          console.log(`   graders that did not catch the wrong answers: ${blind.map((r) => r.id).join(", ")}\n`);
        }
      }
    }

    const estimate = reports.find((r) => r.model === "fake") ? estimateCost(reports.find((r) => r.model === "fake")!.results) : null;
    mkdirSync(outDir, { recursive: true });
    const base = `${outDir}/ai-eval-${stamp}`;
    writeFileSync(`${base}.json`, JSON.stringify({ startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), repeat, tasks: selected.map((t) => t.id), extraEnv, reports, estimate }, null, 2));
    writeFileSync(`${base}.md`, markdown(reports, estimate));
    console.log(markdown(reports, estimate));
    console.log(`Results: ${base}.json and ${base}.md`);
  }
} finally {
  if (!keep) await deleteEvalWorkspaces(runs);
  else if (runs.length) console.log(`Kept the workspaces of ${runs.join(", ")}.`);
  resetAi();
  await fake.close();
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
process.exit(failed ? 1 : 0);

// ------------------------------------------------------------------------------ the report

/**
 * What one run of the tasks would cost on each real model, from what the dry run sent: input
 * tokens from the characters of every request (Turkish text and JSON at about 3 characters a
 * token, no prompt caching counted), output from the answers' characters plus room for thinking.
 * The fake model takes the shortest path to each answer; a real one may search and read more, so
 * the high end gives chat and agents twice the turns. The judge's requests are priced at the judge
 * model.
 */
function estimateCost(results: TaskResult[]) {
  const CHARS_PER_TOKEN = 3;
  const lines = results.map((r) => {
    const t = r.traffic ?? { requests: 0, inputChars: 0, outputChars: 0 };
    const thinking = r.kind === "autofill" ? 300 : 1500;
    const turns = r.kind === "chat" || r.kind === "agent" ? 2 : 1;
    return {
      id: r.id,
      requests: t.requests,
      inputTokens: Math.round(t.inputChars / CHARS_PER_TOKEN),
      inputHigh: Math.round((turns * t.inputChars) / CHARS_PER_TOKEN),
      outputLow: Math.round(t.outputChars / CHARS_PER_TOKEN + 100 * t.requests),
      outputHigh: Math.round(t.outputChars / CHARS_PER_TOKEN + (100 + thinking) * turns * t.requests),
    };
  });
  const sum = (key: "inputTokens" | "inputHigh" | "outputLow" | "outputHigh" | "requests") => lines.reduce((n, l) => n + l[key], 0);
  const writing = results.filter((r) => r.kind === "writing");
  // The judge reads the rubric, the input and the output and answers in a sentence.
  const judgeIn = writing.reduce((n, r) => n + Math.round((JUDGE_SYSTEM.length + 1500 + 2 * r.output.length) / CHARS_PER_TOKEN), 0);
  const judgePrice = PRICES[judgeModel] ?? PRICES["claude-opus-5-5"];
  const judgeCost = [judgeIn * judgePrice.input + writing.length * 150 * judgePrice.output, judgeIn * judgePrice.input + writing.length * 450 * judgePrice.output].map((x) => x / 1e6);
  const perModel = Object.fromEntries(
    Object.entries(PRICES).map(([model, p]) => {
      const low = (sum("inputTokens") * p.input + sum("outputLow") * p.output) / 1e6;
      const high = (sum("inputHigh") * p.input + sum("outputHigh") * p.output) / 1e6;
      return [model, { lowUsd: low, highUsd: high, withJudgeLowUsd: low + judgeCost[0], withJudgeHighUsd: high + judgeCost[1] }];
    }),
  );
  return {
    assumptions: `~${CHARS_PER_TOKEN} chars/token, no prompt caching. Low: the dry run's requests, output = answer + 100 tokens a request. High: chat and agents take twice the turns, + up to 1,500 thinking tokens a request (300 for autofill). Judge: ${judgeModel}.`,
    requests: sum("requests"),
    inputTokens: [sum("inputTokens"), sum("inputHigh")],
    outputTokens: [sum("outputLow"), sum("outputHigh")],
    judge: { requests: writing.length, inputTokens: judgeIn, costUsd: judgeCost },
    perModel,
    perTask: lines,
  };
}

function markdown(list: ModelReport[], estimate: ReturnType<typeof estimateCost> | null) {
  const out: string[] = [`# AI eval ${startedAt.toISOString()}`, ""];
  const ids = [...new Set(list.flatMap((r) => r.results.map((x) => x.id)))];
  const cell = (r: ModelReport, id: string) => {
    const xs = r.results.filter((x) => x.id === id);
    if (!xs.length) return "–";
    const avg = (f: (x: TaskResult) => number) => xs.reduce((n, x) => n + f(x), 0) / xs.length;
    const tokens = avg((x) => x.usage.inputTokens + x.usage.outputTokens);
    return `${(avg((x) => x.score) * 100).toFixed(0)}% · ${Math.round(tokens)} tok · $${avg((x) => x.usage.costUsd).toFixed(4)} · ${(avg((x) => x.ms) / 1000).toFixed(1)}s`;
  };
  out.push(`| task | ${list.map((r) => r.model).join(" | ")} |`, `| --- | ${list.map(() => "---").join(" | ")} |`);
  for (const id of ids) out.push(`| ${id} | ${list.map((r) => cell(r, id)).join(" | ")} |`);
  out.push("", "| model | mean score | by feature | requests | tokens in / out | cost | judge cost | time |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of list) {
    const mean = (xs: TaskResult[]) => (xs.length ? (xs.reduce((n, x) => n + x.score, 0) / xs.length) * 100 : 0);
    const kinds = ["chat", "autofill", "writing", "agent"]
      .map((k) => {
        const xs = r.results.filter((x) => x.kind === k);
        return `${k} ${xs.length ? `${mean(xs).toFixed(0)}%` : "–"}`;
      })
      .join(", ");
    out.push(
      `| ${r.model} | ${mean(r.results).toFixed(1)}% | ${kinds} | ${r.totals.requests} | ${r.totals.inputTokens} / ${r.totals.outputTokens} | $${r.totals.costUsd.toFixed(4)} | $${r.totals.judgeCostUsd.toFixed(4)} | ${(r.totals.ms / 1000).toFixed(0)}s |`,
    );
  }
  if (estimate) {
    out.push("", `## Estimated cost of one real run (${estimate.requests} requests in the dry run, ~${estimate.inputTokens[0]}–${estimate.inputTokens[1]} input tokens)`, "", estimate.assumptions, "", "| model | tasks | tasks + judge |", "| --- | --- | --- |");
    for (const [model, e] of Object.entries(estimate.perModel)) {
      out.push(`| ${model} | $${e.lowUsd.toFixed(2)}–$${e.highUsd.toFixed(2)} | $${e.withJudgeLowUsd.toFixed(2)}–$${e.withJudgeHighUsd.toFixed(2)} |`);
    }
  }
  return `${out.join("\n")}\n`;
}
