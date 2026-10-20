/**
 * Grades a saved run's outputs again with the current graders, without calling a model:
 * `pnpm tsx scripts/ai-eval.ts --regrade data/ai-eval/ai-eval-<time>.json`. What can be graded
 * from the saved text is graded again: chat answers whose checks read only the text, the writing
 * assistant's deterministic checks and the language check. The rest keeps its saved checks:
 * autofill, agents and the chat tasks that write (their checks read the database, which is gone),
 * and the judge's verdict (a new one would need the judge model). Writes `<file>-regraded.json`
 * and `.md` next to the file and prints the tasks whose score moved.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { type Check, score, turkishCheck } from "./grade";
import { type TaskContext, TASKS } from "./tasks";

type SavedResult = { id: string; kind: string; attempt: number; score: number; checks: Check[]; output: string; error: string | null };
type SavedReport = { model: string; results: SavedResult[] };
type SavedRun = { reports: SavedReport[] } & Record<string, unknown>;

/** Checks the runner adds around a task's own grader; they are carried over as they were. */
const CARRIED = [/^judge$/, /^asked to change something/, /^usage was read/];

class NeedsDatabase extends Error {}
const offline = new Proxy({} as TaskContext, {
  get() {
    throw new NeedsDatabase();
  },
});

async function regradeOne(result: SavedResult): Promise<Check[]> {
  const task = TASKS.find((t) => t.id === result.id);
  if (!task || result.error) return result.checks;
  const carried = result.checks.filter((c) => CARRIED.some((r) => r.test(c.name)));
  if (task.kind === "writing") return [...task.grade(result.output), turkishCheck(result.output), ...carried];
  if (task.kind !== "chat") return result.checks;
  try {
    const checks = await task.grade({ text: result.output, steps: [], error: null, approvals: 0 }, offline);
    return [...checks, ...carried, turkishCheck(result.output)];
  } catch (error) {
    if (!(error instanceof NeedsDatabase)) throw error;
    // A chat that writes is graded on the rows it left: keep those checks, add the language one.
    return [...result.checks.filter((c) => c.name !== "Türkçe cevap"), turkishCheck(result.output)];
  }
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export async function regrade(file: string) {
  const run = JSON.parse(readFileSync(file, "utf8")) as SavedRun;
  const lines = [`# AI eval ${file}, graded again`, "", "| model | task | attempt | before | after | checks that changed |", "| --- | --- | --- | --- | --- | --- |"];
  const summary = ["", "| model | before | after | chat | writing |", "| --- | --- | --- | --- | --- |"];
  for (const report of run.reports) {
    const before = report.results.map((r) => r.score);
    for (const result of report.results) {
      const old = new Map(result.checks.map((c) => [c.name, c.pass]));
      const checks = await regradeOne(result);
      const now = score(checks);
      // A check that is new counts as a change only when it fails.
      const moved = checks.filter((c) => (old.has(c.name) ? old.get(c.name) !== c.pass : !c.pass)).map((c) => `${c.pass ? "✓" : "✗"} ${c.name}`);
      if (Math.abs(now - result.score) > 1e-9 || moved.length) lines.push(`| ${report.model} | ${result.id} | ${result.attempt} | ${pct(result.score)} | ${pct(now)} | ${moved.join("; ")} |`);
      result.checks = checks;
      result.score = now;
    }
    const byKind = (kind: string) => {
      const scores = report.results.filter((r) => r.kind === kind).map((r) => r.score);
      return scores.length ? pct(mean(scores)) : "–";
    };
    summary.push(`| ${report.model} | ${pct(mean(before))} | ${pct(mean(report.results.map((r) => r.score)))} | ${byKind("chat")} | ${byKind("writing")} |`);
  }
  const base = file.replace(/\.json$/, "");
  const md = `${[...lines, ...summary].join("\n")}\n`;
  writeFileSync(`${base}-regraded.json`, JSON.stringify({ ...run, regradedAt: new Date().toISOString() }, null, 2));
  writeFileSync(`${base}-regraded.md`, md);
  console.log(md);
  console.log(`Results: ${base}-regraded.json and ${base}-regraded.md`);
}
