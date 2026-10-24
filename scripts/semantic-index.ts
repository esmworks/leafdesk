/**
 * Builds or catches up the semantic search index (#43) for existing pages: every page of every
 * workspace (or of the workspaces named) that was never indexed, changed since, or was indexed
 * with another embeddings model. Unchanged chunks aren't embedded again, so running it twice costs
 * nothing the second time. The server does the same lazily (a workspace's first search starts a
 * background sweep); this is for doing it all at once, e.g. after setting AI_EMBEDDINGS_MODEL.
 *
 *   pnpm search:index                 # all workspaces
 *   pnpm search:index <workspace-id>  # some
 *
 * Env: DATABASE_URL and the AI_EMBEDDINGS_* settings (read from .env when present). Respects
 * AI_CONCURRENCY and AI_WORKSPACE_RATE_LIMIT, and skips workspaces with AI turned off.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

const { db } = await import("@/db");
const { workspace } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { describeAiSetup, embeddingsEnabled } = await import("@/server/ai");
const index = await import("@/server/semantic-index");

const { hocuspocus, service } = createCollab();
registerCollab(service);

try {
  console.log(describeAiSetup());
  if (!embeddingsEnabled()) {
    console.error("No embeddings model: set AI_EMBEDDINGS_MODEL, or OWN_AI_KEYS_ENABLED for accounts that name one (see docs/ai.md).");
    process.exitCode = 1;
  } else {
    const named = process.argv.slice(2);
    const ids = named.length ? named : (await db.select({ id: workspace.id }).from(workspace)).map((w) => w.id);
    for (const id of ids) {
      if (!(await index.semanticAvailable(id))) {
        console.log(`${id}: AI is off, skipped`);
        continue;
      }
      let total = 0;
      let stale = (await index.stalePages(id, 1_000_000)).length;
      // A sweep queues at most a batch of pages; go on while that gets fewer.
      while (stale > 0) {
        const queued = await index.sweepWorkspace(id);
        if (!queued) break;
        total += queued;
        const started = Date.now();
        const timer = setInterval(() => console.log(`${id}: indexing… (${Math.round((Date.now() - started) / 1000)}s)`), 10_000);
        await index.whenIndexIdle();
        clearInterval(timer);
        const left = (await index.stalePages(id, 1_000_000)).length;
        // Pages that failed stay stale (the log says why); don't loop on them.
        if (left >= stale) break;
        stale = left;
      }
      const counts = await index.indexCounts([id]);
      console.log(`${id}: ${total} pages looked at, ${counts.pages} indexed with ${counts.chunks} chunks`);
    }
  }
} finally {
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
