# AI quality eval

A small, repeatable eval of Leafdesk's AI features, to judge a model or prompt change (for example
a cheaper model for some features) on measurements. It seeds a Turkish demo workspace, runs 25
tasks through the same code a person sets off in the app, grades them and writes the results.

- `seed.ts`: the demo workspace, a made-up refrigeration and air-conditioning firm: customers,
  quotes in TRY, EUR and USD, jobs, two quarterly balance sheets, a fixed exchange-rate page and
  meeting notes. Seeded fresh for every model (and every `--repeat`), so tasks that write never
  change what the next model sees.
- `tasks.ts`: the tasks and their graders.
  - AI chat (`startChat`): a question on a page's own chat, lookups, answers that combine several
    pages and databases, arithmetic over amounts (sums, exchange rates, a discount, balance-sheet
    ratios), and three questions the workspace has no answer to. Asked in the app's default mode
    (`ask`): a change the model asks to make is declined and counts against it.
  - AI autofill (`requestAutofill`, custom prompts): classifying customers by sector, extracting
    a delivery time in days and an email address. Every row is a check.
  - Writing assistant (`startEditorAction`): shorten, fix spelling and grammar, rewrite in a formal
    tone (the custom action) and summarize a page.
  - Agents (`requestAgentRun` on a row): update a quote after a discount, convert a linked quote's
    amount into a job's budget, and leave a row alone when the meeting note decided nothing.
  - Chat that writes (mode `auto`): create a quote row, update a job.
- `grade.ts`: number matching that reads Turkish and English formats (`1.250.000,50`,
  `1,250,000.50`, `2,5 milyon`), Turkish-aware word matching, refusal phrases and the judge.

Grading is deterministic wherever the answer is a fact: the expected number or name in the
answer, the row's values in the database afterwards, no other row changed, a refusal when the
answer is absent. Only the writing assistant's text quality goes to a judge model, with the rubric
written in the task; its 1–5 verdict counts as one weighted check (weight 2) next to the
deterministic ones. A task's score is the weighted share of its checks that pass.

## Running it

The eval uses its own local database, never `DATABASE_URL` (default
`postgres://leafdesk:leafdesk@localhost:5432/leafdesk_aieval`, or `AI_EVAL_DATABASE_URL`; only
`localhost` is accepted). Create it once and apply the migrations:

```bash
docker exec leafdesk-db-1 createdb -U leafdesk leafdesk_aieval
```

```bash
DATABASE_URL=postgres://leafdesk:leafdesk@localhost:5432/leafdesk_aieval pnpm tsx scripts/migrate.ts
```

Run it with no app server on that database (the server's workers would take the agents' runs).

A dry run on the fake model, which answers every task with a scripted right answer (`fake`) or a
plausible wrong one (`fake-wrong`). Both go through the real code paths (tools, row writes, the
autofill queue, agent runs); `fake` must score 100% and every task must lose points on
`fake-wrong`, or the script exits with 1. The dry run also prints what one real run would cost on
each model:

```bash
pnpm tsx scripts/ai-eval.ts --model fake,fake-wrong
```

A real model calls Anthropic's API and costs money, so it needs `--spend` and `ANTHROPIC_API_KEY`:

```bash
ANTHROPIC_API_KEY=sk-ant-... pnpm tsx scripts/ai-eval.ts --model claude-haiku-5-5,claude-sonnet-5-5,claude-opus-5-5 --spend
```

| Flag | |
| --- | --- |
| `--model a,b` | `fake`, `fake-wrong` or Anthropic model ids, run one after the other (also `AI_EVAL_MODELS`). Default `fake`. |
| `--judge <model>` | The model that grades the writing tasks of real runs. Default `claude-opus-5-5`; keep it fixed across runs you compare. |
| `--tasks <prefixes>` | Only these tasks, by id prefix: `--tasks chat.,agent.`. |
| `--repeat <n>` | Run every task n times (models aren't deterministic); the table shows averages. |
| `--set KEY=VALUE` | Extra AI settings for the model under test, e.g. `--set AI_MAX_OUTPUT_TOKENS=4096`. |
| `--keep` | Keep the seeded workspaces instead of deleting them. |
| `--seed-only` | Seed one demo workspace with its agent and stop. |
| `--out <dir>` | Where results go (default `data/ai-eval/`, not checked in). |

Each run writes `ai-eval-<time>.json` (every check with what it saw, the outputs, the judge's
verdicts, tokens, cost and time per task) and `ai-eval-<time>.md` (a table of score · tokens · cost
· seconds per task and model, and a summary by feature). Tokens and cost are read from the `[ai]`
usage line every request logs, so they include every turn of a chat or an agent run and every
autofill cell; the judge's cost is listed apart.

## Reading the results

Compare models feature by feature, not by the mean alone: a cheaper model that matches on autofill
and the writing assistant but drops on chat arithmetic or agents answers which features can move.
Run with `--repeat 3` before deciding on a difference of one or two checks.

When a number in `seed.ts` changes, change the expected values in `tasks.ts` with it (each
arithmetic task names its expected result), then run the dry run again.
