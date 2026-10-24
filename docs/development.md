# Development

[← README](../README.md) · [All documentation](README.md)

Contents: [Development](#development), [Languages](#languages), [Architecture](#architecture).

## Development

Requirements: Node.js 24 and pnpm 11 (via `corepack enable`), plus Docker for PostgreSQL.

```bash
pnpm install
cp .env.example .env      # set BETTER_AUTH_SECRET, and POSTGRES_PASSWORD (also in DATABASE_URL; unset, the db gets a random one)
docker compose up -d db
pnpm db:migrate
pnpm dev                  # http://localhost:3000
```

Useful scripts:

| Script | What it does |
| --- | --- |
| `pnpm typecheck` | TypeScript check |
| `pnpm lint` | ESLint with Next.js's rules (`eslint.config.mjs`); fails on warnings too |
| `pnpm test` | Unit tests (Vitest) |
| `pnpm i18n:check [locale…]` | Compares every translation with English: missing or extra files and keys, and placeholders or plural/select syntax that differ (see [Languages](#languages)) |
| `pnpm build` | Production build |
| `pnpm mail:test you@example.com` | Send a test email with the SMTP settings from `.env` |
| `pnpm db:generate` | New migration from schema changes in `src/db/schema` |
| `pnpm search:index [workspace-id…]` | Builds or catches up the semantic search index (see [Semantic search](ai.md#semantic-search)) |
| `pnpm tsx scripts/access-e2e.ts` | End-to-end checks against the database for page permissions, guests and publishing. The other `scripts/*-e2e.ts` files do the same for their areas (teamspaces, membership policies and join requests, databases, filters, bulk actions, AI features, semantic search and AI chat (with a stand-in OpenAI-compatible server), property types, places and map views (with a stand-in address search), feed views, reactions, database tabs and row page layout, people, trash and its retention, views, formulas, charts, dashboards, forms, inline databases, publishing options, sites and duplicating published pages, presence, offline editing, uploads and who may read the files pages show, import, Notion import, Google Docs import (with a stand-in Drive server), export, full-text search, upserts and guarded bulk row edits, deleting stored files, the search box's filters, backlinks and unlinked mentions, synced pages, the graph, the workspace health check, skills (MCP prompts over an in-memory transport, the AI chat with a stand-in model), and `roundtrip-e2e.ts` for an export imported again); `mcp-e2e.ts` and `auth-e2e.ts` below need a running server. |
| `pnpm tsx scripts/sw-e2e.ts` | Checks the service worker (`public/sw.js`) in headless Chrome against a stand-in server: offline pages, per-user copies, the offline page (set `CHROME_PATH` outside macOS) |
| `pnpm tsx scripts/mcp-e2e.ts` | End-to-end OAuth + MCP check against a running server (see the header of the file) |
| `pnpm tsx scripts/api-e2e.ts` | End-to-end REST API check (tokens, every endpoint, access, rate limits, OpenAPI) against a running server |
| `pnpm tsx scripts/voice-api-e2e.ts` | End-to-end check of voice notes over the REST API: a recording saved as a private page or a database row, the transcript toggle, the AI falling back to the transcript, workspace-bound tokens and every refusal, with a faux model and transcription, against the database |
| `pnpm tsx scripts/github-sync-e2e.ts` | End-to-end check of a database's GitHub setup with signed pull request deliveries handed to the route's handler: links and status moves, drafts, done rows, duplicates, bad signatures, the setup person's access when a delivery comes, the deliveries list and the audit log, against the database |
| `pnpm tsx scripts/jira-sync-e2e.ts` | End-to-end check of Jira syncs against a stand-in Jira Cloud the script starts on 127.0.0.1: setting one up, due runs writing changes and new issues, assignment notices, pausing on refused credentials or queries, too many issues and endless page tokens, against the database with no server on it |
| `pnpm tsx scripts/agent-api-e2e.ts` | End-to-end check of agents over the REST API: settings, runs asked for on a row or on none, the asking owner's access, usage by month and the monthly limit, with a fake AI server, against the database |
| `pnpm tsx scripts/workspace-apps-e2e.ts` | End-to-end check of the apps that reach a workspace: what its owners see, when each was last used there, and disconnecting one, against the database |
| `pnpm tsx scripts/security-switches-e2e.ts` | End-to-end check of the workspace security switches (export, publishing, connected apps) through the settings action, the export and public routes, MCP and the REST API, against a running server |
| `pnpm tsx scripts/auth-e2e.ts` | End-to-end password reset check against a running server with SMTP pointed at [Mailpit](https://mailpit.axllent.org) |
| `pnpm tsx scripts/ip-allowlist-e2e.ts` | End-to-end check of a workspace's approved networks (the owner's own-address check, held-back sessions and their page, the collaboration websocket, API tokens outside the list, clearing it as an instance administrator) against a running server |
| `pnpm tsx scripts/two-factor-e2e.ts` | End-to-end two-step verification check (sign-in challenge, recovery codes, workspace policy) against a running server |
| `pnpm tsx scripts/admin-e2e.ts` | End-to-end instance administration check (`ADMIN_EMAILS`, `WORKSPACE_CREATION`, signing out, required password resets) against a running server with the same two settings; it signs everyone out, so only on a development or CI database |

CI (`.github/workflows/ci.yml`) runs most `scripts/*-e2e.ts`, the ones that need a server against
`pnpm start`; each step there shows the settings its script needs. The others (for example the
workspace storage checks, which need an S3 server) are run by hand.

## Languages

The interface is available in English, Turkish (Türkçe), German (Deutsch), Spanish (Español),
French (Français), Italian (Italiano), Brazilian Portuguese (Português), Polish (Polski), Russian
(Русский), Ukrainian (Українська), Arabic (العربية), Hebrew (עברית), Persian (فارسی), Japanese
(日本語), Korean (한국어), Simplified Chinese (简体中文), Indonesian (Bahasa Indonesia), Thai (ไทย),
Vietnamese (Tiếng Việt), Danish (Dansk), Dutch (Nederlands), Norwegian Bokmål (Norsk bokmål), Finnish
(Suomi) and Swedish (Svenska); a browser asking for Norwegian or Nynorsk gets Bokmål. Arabic, Hebrew and Persian run right to
left: the sidebar, menus and panels mirror, and emails follow. In every language each paragraph of
a page follows the direction of its own text, and its alignment runs with it: a right-to-left
paragraph starts on the right without being aligned, and the align buttons put it on the side they
show. CSV import knows each language's title column names and yes/no words, quick add its date
words (Japanese and Chinese ones also without spaces, "来週の金曜日に打ち合わせ"), and the AI chat's
search leaves out its question words. Thai, written without spaces, is searched by whole runs of
text: a word inside a longer run isn't found yet. Each person picks a language in My account → Language, stored per browser;
without a choice the app follows the browser's `Accept-Language` and falls back to English. Dates
and numbers are formatted for the language. Emails go out in the recipient's language: the one they
last picked in My account → Language, else their browser's when they first signed in, stored with
their account (signing in on another device doesn't trade a picked language for that browser's). Until they have signed in once since, and for invitations to addresses without
an account, emails use the language of whoever caused them. The editor's own menus use [BlockNote](https://www.blocknotejs.org)'s dictionaries, except
Turkish, Indonesian, Thai, Danish, Finnish and Swedish, which are ours (`src/i18n/blocknote/tr.ts`, `id.ts`, `th.ts`, `da.ts`,
`fi.ts`, `sv.ts`), and Hebrew, where `src/i18n/blocknote/locales/he.ts`
corrects the wording for resolving a comment thread. The editor downloads only the dictionary of the
language in use.

Texts live in `src/i18n/messages/<locale>/*.json` (app, `email.json`, `templates.json` for the
built-in templates), in ICU MessageFormat. English is the source: `pnpm i18n:check` (also part of
`pnpm test` and CI) reports what each language lacks or gets wrong, and anything missing shows in
English. Adding a language is a new folder of JSON files plus one line each in
`src/i18n/config.ts` and `src/i18n/blocknote/loaders.ts` (and a one-line file in `src/i18n/blocknote/locales/`). Only Turkish is checked by a native speaker
so far; corrections to the other languages are welcome as pull requests, as are new languages; see [CONTRIBUTING.md](../CONTRIBUTING.md#translations) for the workflow.

## Architecture

- A single Node process (`server.ts`) serves Next.js (App Router) and the Hocuspocus
  collaboration server on the `/collab` WebSocket path.
  - Route handlers, server actions and MCP tools write into open documents through the same
    Hocuspocus instance, so AI edits appear live in open editors.
  - The `/collab` connection is authenticated with a short-lived HMAC token.
- Page access is worked out in SQL (`page_access_level`, first in migration `0003`, current in
  `0055`):
  every read path (sidebar, search, mentions, export, MCP, REST, collaboration) filters with it.
  A page's teamspace is stored on every page of its tree (`page.teamspace_id`, kept in step by
  triggers); null means private.
- The Yjs document is the source of truth for page content. On every save, the app also stores
  derived markdown and plain text in PostgreSQL for search and MCP reads. Full-text search matches
  and ranks pages through an index of a vector PostgreSQL keeps for each page
  (`page.search_vector`: the title's words weighted above the body's, plus every two-character
  piece of Chinese and Japanese text), built from the first 1,000 characters of the title and the
  first 80,000 of the body, and checks access only for the best pages until there are enough.
- Browsers keep each page's Yjs document in IndexedDB (y-indexeddb), loaded before the page
  connects, so offline edits merge on reconnect like any other change; a hand-written service
  worker (`public/sw.js`) keeps the app's scripts and the signed-in pages' HTML per user. See
  `src/lib/offline.ts` for what is stored where and when it is wiped.
- AI features go through one interface, `src/server/ai` (config from the environment, streaming
  chat with tool calls, embeddings, limits, usage logging), built on `@earendil-works/pi-ai` with
  only the Anthropic, OpenAI, Google and OpenAI-compatible APIs loaded; nothing else imports the
  library. Embeddings are a plain `fetch` to an OpenAI-compatible `/embeddings` endpoint. AI
  property values are worked out by an in-process queue (`src/server/ai-properties.ts`) whose
  pending and failed states live in `ai_property_state`.
- Semantic search keeps chunk embeddings in `page_chunk` (`real[]`, ranked by the SQL function
  `embedding_cosine`) and what was indexed in `page_index_state`; an in-process queue
  (`src/server/semantic-index.ts`) indexes pages after saves, which the collaboration server and
  the route handlers announce through `src/server/page-events.ts`. The AI chat
  (`src/server/ai-chat.ts`, `POST /api/ai/chat` streaming NDJSON) runs its `search_pages` and
  `read_page` tools through `src/server/operations.ts` as the person asking; conversations are
  stored per person in `ai_conversation`. The Telegram bot (`src/server/telegram`) reads its
  messages by long polling and runs the same chat as the linked person, inside
  `runAsConnectedApp`; links are kept in `telegram_link`.
- Auth is Better Auth: email/password, GitHub/Google, two-factor and passkey plugins for people,
  and the OAuth provider, JWT, MCP and CIMD plugins for apps. Data access uses Drizzle ORM on PostgreSQL 18.
