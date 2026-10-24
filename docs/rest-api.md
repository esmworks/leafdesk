# REST API

[← README](../README.md) · [All documentation](README.md)

Scripts and other programs can use the REST API under `<APP_URL>/api/v1` with a personal access
token. The reference is at `<APP_URL>/docs/api`, generated from the OpenAPI 3.1 document at
`<APP_URL>/api/v1/openapi.json` (import it into Postman, Insomnia or a client generator).

Create a token in My account → *Connected apps* → *Personal access tokens*: give it a name, choose
what it may read and write, optionally limit it to one workspace, and pick when it expires (7, 30,
90 days, a year, or never). The token is shown once; Leafdesk keeps only its SHA-256 hash. Tokens
look like `esi_` and 40 letters and digits, so secret scanners can match leaked ones with
`esi_[A-Za-z0-9]{40}`. The list shows what each may do and when it was last used; *Change access*
changes what it may do without a new secret, and revoking one stops it at once.

What a token may do is chosen per resource, with a read and (where there is one) a write toggle
for each, or one of the presets *Read everything* and *Read and write everything*. A write scope
brings the read scope of its resource. Every endpoint needs one scope (the reference names it;
`GET /me` takes any token), and a token without it gets `403 insufficient_scope` with the scope in
`details.scope`:

| Scope | Endpoints |
| --- | --- |
| `workspaces:read` | `GET /workspaces`, a workspace's teamspaces and groups |
| `pages:read`, `pages:write` | pages (database rows too, as pages), their sub-pages, the page tree, daily notes; writing creates, changes, moves, trashes, restores, archives and watches pages and makes voice notes |
| `search:read` | `GET /search` |
| `databases:read` | `GET /databases/{id}` (properties and views) |
| `rows:read`, `rows:write` | `POST /databases/{id}/query`, `GET /rows/{id}` and its activity, changes waiting for review; writing adds, upserts and changes rows (a voice note into a database needs it too) and approves or dismisses those changes |
| `comments:read`, `comments:write` | a page's comment threads; writing starts threads and replies |
| `agents:read`, `agents:write` | agents, their runs, usage, schedules and sharing; writing changes them, asks for runs, sets schedules and shares |
| `audit:read` | `GET /workspaces/{id}/audit-log` (owners only, on a token limited to that workspace; never in the presets; see [Audit log streaming](account-and-security.md#audit-log-streaming)) |

Tokens made before scopes were per resource keep exactly the access they had: their `pages:read`
reads everything and their `pages:write` reads and writes everything, including endpoints added
later. Settings and `GET /me` (`legacy_scopes: true`) say so; once their access is changed they
get the scopes chosen, like a new token. The scopes are the REST API's own: those of MCP apps are
unchanged.

The ids the API takes are in the app too: *Copy ID* in a page's, database's or row's menu, and
*Copy property ID* in a column's menu (properties are also taken by name).

```bash
curl http://localhost:3000/api/v1/workspaces -H "Authorization: Bearer $LEAFDESK_TOKEN"

curl -X POST http://localhost:3000/api/v1/databases/<database_id>/query \
  -H "Authorization: Bearer $LEAFDESK_TOKEN" -H "Content-Type: application/json" \
  -d '{"filters": [{"property": "Status", "op": "is_any_of", "value": ["Todo", "In progress"]}], "limit": 20}'
```

Filter ops: `contains`, `does_not_contain`, `equals`, `not_equals`, `is_any_of` and `is_none_of`
(with a list of values), `is_empty`, `is_not_empty`, `gt`, `gte`, `lt`, `lte` and `is_within`.

- **Account and workspaces:** `GET /me`, `GET /workspaces`, `GET /workspaces/{id}/teamspaces`, `GET /workspaces/{id}/groups`,
  `GET /workspaces/{id}/pages` (`teamspace_id` narrows it to one teamspace, or `private`).
  `GET /workspaces/{id}/daily-notes` lists the user's daily notes (`from`, `to`, `limit`) and
  `POST /workspaces/{id}/daily-notes` opens one (`date`, or today in `time_zone`), making it when
  missing; `created` says which.
  `POST /pages` and `POST /pages/{id}/move` take a `teamspace_id` for top-level pages, as the MCP
  tools do.
- **Pages:** `GET /search`, `POST /pages`, `GET` and `PATCH /pages/{id}` (title, icon, cover,
  Markdown body replaced or appended, or single blocks by `block_id` with the modes
  `replace_block`, `insert_after` and `delete_block`; `GET` with `with_block_ids` gives the ids),
  `GET /pages/{id}/children`, `POST /pages/{id}/move`, `/archive` and `/restore` (the trash), and
  `POST /pages/{id}/archived` (`archived: true` or `false`: archive an outdated page or unarchive
  it; `GET /search`, the page lists and `POST /databases/{id}/query` leave archived pages and rows
  out unless `include_archived` is true). `GET /search` takes text in double quotes as a phrase and
  the filters `teamspace_id`, `created_by` and `edited_by` (comma-separated ids, `me` for
  yourself), `created_after`, `created_before`, `edited_after` and `edited_before` (ISO 8601; a day
  alone is its start in UTC); with a filter the query may be left out. `GET /pages/{id}`
  gives the body's `version`, and `PATCH` takes it back as `expected_version`: when the body
  changed since, nothing is written and the answer is `409` `version_conflict` with the current
  version. Body writes report the new `version`.
- **Databases and rows:** `GET /databases/{id}` (schema), `POST /databases/{id}/query` (filters,
  sorts, a saved view, cursor pagination with `next_cursor` and `has_more`, `properties` to narrow
  each row), `POST /databases/{id}/rows`, `POST
  /databases/{id}/rows/bulk` (up to 100; both take `match_by` to upsert, as the MCP tools do),
  `PATCH /databases/{id}/rows` (same values on many rows, with `expect` and `dry_run`),
  `POST /databases/{id}/rows/merge` (duplicate rows into one, as `merge_rows` does),
  `GET` and `PATCH /rows/{id}`, `GET /rows/{id}/activity` (who changed what, newest first;
  `actor: "ai"` for AI autofill values, with the person in `by`).
- **Voice notes:** `POST /voice-notes` takes a recording as multipart form data (`audio`, and
  `workspace_id` or `database_id`), has it transcribed and written up by AI and saves the note as a
  private page or a database row, answering when it is saved (`201`, with the transcript and the
  select values AI picked). Only where speech to text is set up and the workspace allows AI
  (otherwise `409 voice_notes_unavailable`); files may be up to `STT_MAX_MB` (see
  [Voice notes](ai.md#voice-notes)), unsupported files answer `415` and provider failures `502`.

  ```bash
  curl -X POST http://localhost:3000/api/v1/voice-notes \
    -H "Authorization: Bearer $LEAFDESK_TOKEN" \
    -F audio=@memo.m4a -F workspace_id=<workspace_id>
  ```
- **Comments:** `GET` and `POST /pages/{id}/comments`.
- **Agents:** `GET /workspaces/{id}/agents`, `GET` and `PATCH /agents/{id}` (settings, pausing and
  resuming, the monthly token limit, the model; with this month's usage), `POST /agents/{id}/runs` (ask for a
  task now, optionally on a row), `GET /agents/{id}/runs`, `GET /agents/{id}/runs/{run_id}`,
  `GET /agents/{id}/usage` (by month), and `GET` and `POST /agents/{id}/sharing` (who it is shared
  with; share it or take someone off). Each needs the level of access to the agent the app asks
  for (see [Sharing an agent](agents.md#agents)); each agent carries the token's user's
  `your_access`, and only owners change the monthly limit. Asking for a run answers
  `409` when the agent can't run now (`agent_unavailable`), used its monthly limit
  (`limit_reached`) or has too many runs waiting (`too_many_runs`). An `agents:write` token may thus
  start runs that use the workspace's AI allowance.
- **Changes for review:** `GET /workspaces/{id}/pending-changes` (`rows:read`) lists what agents
  proposed, and `POST /pending-changes/{id}/approve` (optionally edited, or with `force`) and
  `/dismiss` (`rows:write`) answer it; `409` `change_conflict` when the row changed since in a
  value it sets, `change_decided` when it was already answered.

Automations have no REST endpoints: they are managed in the app or over MCP.

The API and the MCP server share one service layer (`src/server/operations.ts`), so they check
input, access and history the same way: a token acts as its user, with that user's own access to
pages, and every body change is saved to page history first. Pages the user can't see (or outside
a token's workspace) answer `404`. A body the database refuses to save answers `500`
`internal_error` (and AI apps get an error result) rather than passing for written; a page
created with such a body stays, without it. Errors are JSON, `{"error": {"code", "message", "param", "details"}}`,
where `param` names the field an invalid value is in when it is known (`title`,
`properties.Status`, `rows.2.properties.Status` in a bulk call); lists page with `next_cursor`.
Each token may make 180 requests a minute (`API_RATE_LIMIT`): every answer to a request with a
valid token carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` (when one
more request is allowed again, in Unix seconds), and beyond the limit the answer is `429` with
`Retry-After` (seconds). JSON request bodies are limited to 5 MB.

Writes take an `Idempotency-Key` header (up to 255 characters, say a UUID per change), so a client
can safely send a request again after a timeout: within 24 hours the same request with the same
key gets the first answer back, with `Idempotent-Replayed: true`, and changes nothing more. A key
belongs to its token and endpoint and remembers the request's path, query and body; the same key
with another request answers `422 idempotency_key_reused`, and while the first request still runs
`409 idempotency_conflict`. Server failures (`5xx`) and `429`s aren't kept, so their retry runs
again; the daily retention run deletes keys older than 24 hours.

```bash
curl -X POST http://localhost:3000/api/v1/databases/<database_id>/rows \
  -H "Authorization: Bearer $LEAFDESK_TOKEN" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" -d '{"title": "Call the supplier"}'
```

Only tokens authenticate (never the browser session), and CORS is off unless
`API_CORS_ORIGINS` lists origins. Like connected MCP apps, tokens are not held back by a
workspace's "require two-step verification" policy: it guards browser sessions. They are held to
its **Connected apps and API tokens** switch: in a read-only workspace write endpoints answer
`403` (`forbidden`), and a workspace with it off answers `404` like one the user isn't in (see
[Workspace security switches](account-and-security.md#workspace-security-switches)).
