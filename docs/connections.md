# Connections and MCP

[← README](../README.md) · [All documentation](README.md)

Outbound connections to other services, and connecting AI assistants to Leafdesk over MCP.

Contents: [Connections](#connections), [Connect an AI assistant](#connect-an-ai-assistant).

## Connections

A connection links a workspace to a service its agents, and the AI chat for the tools ticked *In
chat*, may use: any remote MCP server (Slack, GitHub, a CRM, another Leafdesk...). It is the other
way round from *Connected apps*, where outside
AI apps use Leafdesk; here Leafdesk's agents use the outside service. Owners of the workspace manage
connections in Settings → *Connections*; members and guests don't see them. A workspace has at most
20.

**Adding one.** The page opens on *Browse*: a catalog of services Leafdesk can reach as they are
(Linear, Atlassian, GitLab, Sentry, Stripe, Zapier and more), as cards with each service's logo, in
categories, with search; *Connected* lists the workspace's connections. *Connect* on a card opens
the form below filled in from that service, which can still be changed; a service already added
opens its connection instead. The catalog lives in
`src/lib/connection-catalog.ts`: it lists only servers that, at that address, either publish OAuth
metadata naming it that Leafdesk can sign in with, take an API key, or answer without any sign-in.
A few services (Slack, HubSpot, Asana, Box, Discord, Front, PagerDuty, Xero, Google) sign in only apps
registered with them beforehand: for those the form asks for the client ID and secret of an app
you create at the service, links to where it's made, and shows the redirect URL to give it
(`APP_URL/api/connections/oauth/callback`).

**Google** (Drive, Docs, Sheets, Slides, Gmail, Calendar, Chat, Contacts) is one of these: its
MCP servers sign in an OAuth client from a Google Cloud project, and one client serves them all.
Following [Google's guide](https://developers.google.com/workspace/guides/configure-mcp-servers):
in the project, enable each service's MCP API and its API (for Sheets, `sheetsmcp.googleapis.com`
and `sheets.googleapis.com`); set up the consent screen (*Internal* for a Workspace organization,
else *External* with test users); and create a *Web application* client with *Use this client for
an AI-powered agent* ticked and `APP_URL/api/connections/oauth/callback` as its redirect URI. Enter
its ID and secret on each connection, or once for the instance as `google=` in
`CONNECTION_OAUTH_CLIENTS`. Google's MCP servers are in its Workspace Developer Preview Program at
the time of writing. Each entry asks only for the scopes its tools use: Drive files are read, and
written only when made through Leafdesk; Docs, Sheets and Slides can edit any document of their
kind; Gmail labels, trashes and drafts mail (`gmail.modify`, never the whole mailbox); Calendar
reads calendars and edits events. Leafdesk asks Google for a refresh token, so a sign-in lasts.

Vendors move their MCP addresses now and then, so
before a release run `pnpm catalog:check` (it needs the network and isn't part of the tests): it
asks every entry the questions above without credentials, lists those that no longer answer as
listed and exits with 1 if there are any; `pnpm catalog:check linear sentry` checks only those
ids. Each entry's logo is `public/connections/<id>.png`: the service's own apple-touch-icon (or its
largest favicon) fitted into 96 px and padded to a square, e.g. `sips -s format png -Z 96 icon.png
--out <id>.png && sips -p 96 96 <id>.png`, or, when the service has no icon that large, its glyph
from simple-icons (CC0) in its brand color. A
test fails when an entry has no logo, or a logo has no entry. *Add another server* starts from an empty form. Give it a name and the server's URL
(Streamable HTTP), and how it signs in:

- **OAuth**: Leafdesk registers itself with the server (dynamic client registration), sends you to
  the service to approve access (with PKCE), and keeps the tokens it gets back, refreshing them as
  needed. Who signs in decides what the agents can reach there: they act as that account. A
  server that takes no registrations needs an app registered with it: enter its client ID (and
  secret, if it has one) on the connection, or set one for the whole instance in
  `CONNECTION_OAUTH_CLIENTS` by catalog id (`slack=CLIENT_ID:CLIENT_SECRET,discord=CLIENT_ID`;
  `google` for all of Google's services), used for connections to that service's catalog address
  that have no app of their own. Where
  such a server instead takes a client metadata document (as ElevenLabs does), Leafdesk gives the
  address of its own, `APP_URL/api/connections/oauth/client`, as its client ID: this needs an
  `https` `APP_URL` the service can fetch.
- **Token**: an API key or personal token, sent as `Authorization: Bearer <token>`.
- **None**: for servers that need nothing.

Changing a connection's address signs it out, and starts it over as a new server: a token must be
pasted again (a token is never sent to an address it wasn't given for), so must an app's client
ID and secret, its tools are listed
afresh with the classes the server marks, and agents lose its tools until an owner gives them
again, since another server's tool of the same name may do something else.

Tokens and signing secrets are sealed (AES-256-GCM) before they reach the database and never come
back to the browser. The key comes from `LEAFDESK_ENCRYPTION_KEY` (at least 32 characters), or,
without it, is derived from `BETTER_AUTH_SECRET`. To change the key, set the new one in
`LEAFDESK_ENCRYPTION_KEY` and put the old one in `LEAFDESK_ENCRYPTION_OLD_KEYS` (comma-separated):
values sealed with it keep opening, and new ones (refreshed tokens, a new secret) are sealed with
the new key. A value sealed with a key the server no longer has can't be opened: the connection
must sign in again, or get its token or secret again.

A connection only reaches public `https` addresses; local names, private and loopback addresses
and plain `http` are refused, checked again on connecting (so a name can't resolve to a private
address) and on every redirect (at most five).
For a server on the same machine or network, list its host (or `host:port`) in
`CONNECTOR_ALLOWED_HOSTS`.

**Tools and approval.** Once signed in, Leafdesk lists the server's tools (at most 200) and classes
each as *read* or *write*: a tool the server marks read-only (`readOnlyHint`) is *read*, every
other one *write*. An owner can change the class of any tool. Then, on an agent's *Connections*
tab, an owner ticks the tools that agent may use; an agent has no tool of a connection until then.
Ticking *In chat* next to a tool (the connection's *Tools* tab) offers it to members' AI chats,
where a tool that isn't *read* asks the person before every call (see *Connections' tools* under
[AI features](ai.md#ai-features)); a connection moved to a new address starts with none.

- A *read* tool runs at once when the agent calls it, except where no member stands behind what
  the run reads, so there every tool waits as a *write* tool does: on a row an anonymous form
  answer added (or a visitor outside the workspace), and on a run an event started, unless an
  owner marked its trigger *Trust what this service sends* (below).
- A *write* tool doesn't: the run waits, and the owners who may see the run (*Managing agents*
  above: every owner for a run an event started) get an item in their inbox (and the run shows it
  in Settings → *Agents* → *Runs*) with the agent, the tool and its input; only they answer it. A
  run on a row no owner can open asks no one, and runs out of time. The run shows the input exactly as it will be sent; the inbox shows it with credentials
  masked and cut to 4000 characters, so it offers *Approve* only when that is all of what would be
  sent, and otherwise a button to open the run and approve there. An owner who linked Telegram
  can answer it there too, under the same rule (see [AI chat from Telegram](ai.md#ai-chat-from-telegram)).
  An owner **approves** (the call is sent as the agent made it),
  **declines** (the agent hears no and goes on), or **sends it back with a note** (the agent gets
  the note and tries again, which may ask again). After 24 hours with no answer the run ends as `approvalTimeout` and nothing is sent;
  an answer that comes later is refused. Once an approved call is sent, the run notes it, so a
  run taken up again (its server restarted, say) doesn't send it twice.
  If the tool or the connection is taken away while it waits, nothing is sent either
  (`connectionGone`).

A tool's answer reaches the model cut to 8000 characters, and a run takes at most 40,000
characters from connections in all. A call gets 30 seconds; when a writing call runs out of time
the agent is told it may have been done and asked to say so in its answer. What the agent got from a tool
can end up in what it writes, like anything shared with it.

**Events.** Each connection has an address, `<APP_URL>/api/connections/<id>/events`, where the
service can send events signed with a secret of the connection (shown on the *Events* tab, with a
button for a new one). Pick how they are signed:

- **Leafdesk** (`hmac`): the same scheme as Leafdesk's own webhooks. `X-Leafdesk-Signature:
  t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`, with the event's type in
  `X-Leafdesk-Event` and a unique id in `X-Leafdesk-Delivery`. Use it with Zapier, Make, n8n or your
  own code.
- **Slack** (`slack`): the Events API's `X-Slack-Signature`; paste the app's signing secret. Slack's
  URL check is answered.
- **GitHub** (`github`): `X-Hub-Signature-256`, `X-GitHub-Event` and `X-GitHub-Delivery`; paste the
  same secret in the webhook's settings.

An event signed wrongly, older than five minutes or larger than 256 KB is refused, and so is one
seen before: by its delivery id (the service sending it again) or by its signature (the same
request sent again with another delivery id). Two events with the same body signed in the same
second are therefore one event; put an id or a time in the body when that could happen. GitHub
signs no time, so a GitHub delivery is known as a repeat only while it is kept (7 days). A
connection takes at most 120 signed events a minute; requests that fail the signature check don't
count. An event the server failed on before starting its runs shows as *not handled* and is
handled when the service sends it again. Each accepted event runs the agents whose triggers match
its type (a trigger for `issues` also takes `issues.opened`, an empty type takes all), with the
trigger's task and the event (its type and body, cut to 8000 characters, read as data). Such a run
reads what is shared with the agent, and the only change it makes in Leafdesk is adding rows
(`create_row`) to databases shared with the agent to edit, within its limit of changes, each once
an owner approves it; otherwise it acts through its connection tools, with approval as above. The *Events* tab lists what came in over the last 7
days and what happened to each.

Anyone who can make the service send an event (open an issue on a public repository, write in a
channel the app reads, fill in a form that posts to it) writes what such a run reads, and could try
to talk the agent into reading pages shared with it and sending them out through a reading tool
whose input reaches them (a fetch of an address, a search), or copying them into a row. So by
default every connection tool call of an event's run, reading ones too, and every row it adds waits
for an owner's approval. An owner can tick *Trust what this service sends* on a trigger whose
service only people of the workspace can make send events: its runs then call reading tools at
once, and only the others wait, rows it adds included. The setting is read
each time a run goes on, so turning it off holds back runs already under way.

**Audit.** Adding, changing, signing in to and removing connections, tool classes, agents' tools,
triggers, every connection tool call (with its input, who approved it and the outcome) and every
approval answer are recorded in the audit log. Over MCP: `list_connections` and
`set_agent_connection_tools`; connections are added and signed in to only in the settings.

**Credentials in what is kept.** What Leafdesk keeps about runs, calls and events (a run's steps,
answer and error, a waiting call's input, an event's body, a connection's or an automation step's
error, the audit log's details) and what it writes to the server's log has credentials masked as
`[redacted]`: passwords in addresses, credential-named query parameters and fields (`token`,
`api_key`, `password`…), `Authorization` headers and bearer tokens, private keys and well-known
token formats (Leafdesk's own, GitHub, Slack, AI providers, Stripe, AWS, Google, JSON Web Tokens).
Pages and rows stay as they are, and what is sent (an approved call, a webhook) is the original,
which is also what owners see where they approve a call (above). Over MCP, `list_agent_runs`
shows a waiting call masked: a connected app can't approve it. The Telegram bot passes on an
owner's own button press, not a program's choice, so it can (see
[AI chat from Telegram](ai.md#ai-chat-from-telegram)).

> [!WARNING]
> An agent with a connection acts as the account that signed in. Allow it only the tools it needs,
> keep anything that changes data as *write*, and remember that an event's body is text a stranger
> may have written: an agent can be talked into asking for things, which is why write tools wait for
> a person, and why every tool of an event's run waits unless you trust its trigger's service.

## Connect an AI assistant

The server URL is `<APP_URL>/mcp`. My account → *Connected apps* shows ready-to-copy
instructions with your server's URL. Every client signs in the same way: it opens Leafdesk in your
browser, you sign in and approve access, and you can make it read-only on that screen.

- **Claude** (web and desktop): Settings → Connectors → *Add custom connector*, then paste the
  server URL.
- **Claude Code**: add the server, then run `/mcp` inside Claude Code to sign in.

  ```bash
  claude mcp add --transport http leafdesk http://localhost:3000/mcp
  ```

- **Codex**: add the server; Codex sees that it uses OAuth and opens the browser right away. If
  that window gets closed, run `codex mcp login leafdesk`. Use a current Codex CLI: 0.159.1 signs
  in, while 0.144.1 fails with "Authorization server response missing required issuer".

  ```bash
  codex mcp add leafdesk --url http://localhost:3000/mcp
  ```

- **Other clients**: add a remote server with the Streamable HTTP transport. Sign-in is found
  through standard OAuth 2.1 metadata; clients can register themselves or use a Client ID Metadata
  Document.

Every request checks that the app is still connected, so disconnecting it in *Connected apps*
cuts it off at once, and so does changing your password with *Sign out of all other sessions* or
resetting it by email. Each user may make 120 requests a minute to `/mcp`, all their apps together
(`MCP_RATE_LIMIT`, `0` for no limit; `429` with `Retry-After` beyond it). What the tools read from
a workspace was written by people, some from outside it (guests, form visitors, connected
services): the server's instructions and the end of every read tool's result tell the assistant
to treat it as data, never as instructions.

Every client sends the tool list to its model at the start of each session, so the list keeps to
what is needed often. What is needed only now and then is documented on demand as MCP resources,
`leafdesk://docs/<topic>` (`markdown`, `properties`, `filters`, `views`, `dashboards`,
`automations`): the full shape of filters, view settings, dashboard widgets and automation steps,
how each property type's values are written, and the block forms of page bodies. Tools show those
inputs as an outline with a pointer to their topic and check them in full when called. A client
that doesn't read resources gets the same text from `get_page` with the address as `page_id`.

The tools cover:

- **Finding things:** `list_workspaces`, `list_teamspaces`, `search` (also by the words of the PDFs, Word documents and Excel workbooks pages show; such a result names the `document`), `list_pages`, `list_recent_pages`, `list_users` (with when each member joined), `list_groups` (member groups with their members and teamspaces).
- **Workspace health:** `check_workspace` lists broken links, pages nothing links to, empty and
  long untouched pages, likely duplicates and relations to deleted rows, with links and the tools
  that fix each (it changes nothing itself).
- **Members:** `invite_member` adds someone to a workspace by email, as Settings → Members does
  (owners only, and not for read-only apps): someone whose account has a verified address joins
  right away, anyone else gets an invitation, whose link is returned too.
- **Teamspaces:** `create_page`, `create_database` and `move_page` take a `teamspace_id` for
  top-level pages (`"private"` for the user's private pages). Without one, a page an AI app
  creates at the top is private to the user, so nothing an app makes is shared before they
  decide; the user moves it to share it.
- **Pages:** `get_page`, `create_page`, `update_page`, `move_page`, `duplicate_page` (a copy with
  everything under it, beside the original; `without_rows` copies databases without their rows), `archive_page`, `list_trash`, `restore_page` (the
  trash), `set_page_archived` (archive an outdated page or unarchive it; `search`, `list_pages`
  and `query_database` leave archived pages and rows out unless `include_archived` is true).
  `list_pages` with `favorites: true` lists the user's starred pages, and `get_page` says whether a
  page is starred. `update_page` sets the cover: an uploaded file's URL, an https image link or
  `gradient:<name>`, with `cover_position` for the band of an image that shows. Besides replacing
  or appending to the body, `update_page` changes single blocks: `get_page` with `with_block_ids`
  marks each block's id, and the modes `replace_block`, `insert_after` and `delete_block` take a
  `block_id`. `get_page` also gives the body's `version`; passed back to `update_page` as
  `expected_version`, the page changes only while its body still has that version: when someone
  changed it since, even in an editor open right now, nothing is written and the app is told to read the page
  again. Body writes report the new `version`, so an app can make several changes in a row;
  comments don't change it, and without `expected_version` writes work as before. Body changes
  can be kept or undone on the page (see [Reviewing AI changes](ai.md#ai-features)). Wherever a tool takes an id, a Leafdesk link the user pasted works too
  (`https://…/w/<workspace>/p/<page>`, `?view=<view>` for a view).
- **Page history:** `get_page_history` (a page's versions with `page_id`; one version's body with
  `version_id`, or what changed with `compare`) and `restore_page_version`.
- **Row activity:** `list_row_activity` lists who created a row and who changed what in it, newest
  first; a value AI autofill filled in has `actor: "ai"`, with the person it was worked out for in
  `by`.
- **Templates:** `list_templates`; `create_page` and `create_database_row` take a `template_id`. A
  built-in kit (`kind: "kit"`, such as `builtin:small-business`) sets up all its pages and databases
  at once, and `create_page` lists them under `parts`.
- **Daily notes:** `get_or_create_daily_note` opens the user's note for a day (`date`, or today in
  `time_zone`), making it as the app would; `list_daily_notes` lists them newest first, from one day
  to another. Read-only apps can list notes but not make one.
- **Skills:** `list_skills`, `get_skill`, `set_skill`; every skill is also a prompt of its name
  (see [Skills](ai.md#skills)).
- **Comments:** `list_comments`, `add_comment` (start a thread on quoted text, or reply). A thread
  about the whole page, as agents write them, comes back with `about_page: true` and no quote, and
  one the user marked *Come back later* with `marked: true`.
- **Mentions:** page bodies read and write mentions as Markdown: `[Title](/w/<workspace>/p/<page>)`
  for a page, `@Name` for a person, `@YYYY-MM-DD` for a date, and a link shown as a mention as an
  ordinary `[Title](https://…)` that comes back as the mention when the page's Markdown is written
  back with it (see `src/lib/mentions.ts`).
- **Footnotes and print-hidden callouts:** a footnote is `[^1]` in the text with its note on a line
  of its own (`[^1]: The note.`), the notes written at the end of the body; a callout hidden in
  print has the line `<!-- leafdesk:no-print -->` right before its alert (see
  `src/lib/content-markdown.ts`).
- **Callout styles:** a callout's title follows its alert (`> [!NOTE] Title`), a color the alerts
  don't have rides along (`> [!NOTE|blue]`), and a callout of one of the workspace's styles is
  `> [!key] Title`; `list_workspaces` (and `GET /api/v1/workspaces`) lists each workspace's
  `callout_styles`. `:::name Title` … `:::` containers in Markdown read as callouts, toggles
  (`details`) and framed boxes (`frame`, `card`, `panel`).
- **Inbox:** `list_notifications`, when the user also grants the `notifications:read` permission.
  `watch_page` watches or mutes a page (follows or stops following a row); `get_page` shows
  `watching`.
- **Files:** `attach_file` uploads an image, video, audio or other file to a page (or, with
  `property`, to a row's files & media property) from a public URL or base64 data, when the user
  also grants the `files:write` permission. Files properties can only be set to files already
  uploaded to the workspace. URLs that lead to
  private or loopback addresses are refused. `get_file` reads a file back: text files, PDFs (their
  text layer) and Excel workbooks (each sheet's rows, cells between bars) as text, PNG, JPEG, GIF and WebP images as images, anything else as a description with
  its link. It needs no extra permission: the user reads a file when they can see a page showing it.
- **Databases:** `get_database`, `query_database`, `create_database`, `create_database_row`,
  `create_database_rows`, `update_database_row`, `update_database_rows`, `add_database_property`
  (including one- or two-way relations), `set_sub_items`, `set_dependencies`, `update_database_property`
  (`one_row` limits a relation to one linked row),
  `change_database_property_type` (converts the values in every row; `dry_run` counts what would
  convert and what would be cleared without changing anything), `delete_database_property`,
  `create_database_view` and `update_database_view` (table, board, calendar, gallery, list, feed,
  timeline, map (with `place_by`), chart, dashboard or form, including a form's public link and a dashboard's `widgets`; a chart over a date takes `accumulate`
  for running totals or a burndown, a calendar `calendar_mode` (month or week) and `show_weekends`, views with rows `show_icons` and `color_rules`, a board `aggregate` and `aggregate_property` for what its column headers show, and table, list and timeline views take `sub_items`;
  `update_database_view` also switches a view with rows to another such layout with `type` and moves a
  view's tab with `before_view_id` or `after_view_id`), and `set_property_access` (who may
  see and change a property). `query_database` returns `next_cursor` and `has_more`: passing the
  cursor back with the same filters and sorts reads on from the last row returned, so rows added
  or removed between calls neither repeat nor go missing (a cursor from another query is refused),
  and `properties` narrows each row to the values asked for. `create_database_row` and
  `create_database_rows` take `match_by` (the title or a text, number, email, phone, URL, select
  or status property) to upsert: a row with the same value is updated instead of a new one added,
  so a retried import adds nothing twice, and each row says whether it was `created` or `updated`;
  a value two given rows share, or that several existing rows hold, is refused before anything is
  written. `update_database_rows` takes `expect` (writes nothing unless exactly that many rows
  would change) and `dry_run`. `merge_rows` merges duplicate rows into a kept row, taking each
  value from the row picked for it (or every row's together), pointing other rows' links at the
  kept row and bringing comments, activity, files, email and content along; the merged rows go to
  the trash.
- **Dashboards:** `add_dashboard` adds a dashboard of widgets (each a database and the settings of
  a view, as for `create_database_view`; a number is a chart with `chart_type: "number"`) to the end
  of a page (`layout: "tabs"` shows one widget at a time, as tabs), and `update_dashboard_widget`
  adds, changes, moves or removes one widget. `get_page` lists a page's dashboards, their layout and
  their widgets; a widget on a database the user can't open names
  nothing of it.
- **Automations:** `list_automations`, `create_automation`, `update_automation`,
  `publish_automation`, `discard_automation_draft`, `test_automation`, `delete_automation` and
  `list_automation_runs` (see
  [Automations and webhooks](automations.md#automations-and-webhooks)). They need full access to the database;
  properties are named by name or id and people by id, email, name or `"me"`, a `find_rows`
  step's filters and sorts as `query_database` takes them, and `list_automations` shows names
  next to the stored ids, each step's id, the draft and the published version. `publish: false`
  keeps changes in the draft until `publish_automation` (or `discard_automation_draft` drops them); `test_automation` runs it once and
  returns the run's id for `list_automation_runs`. A `run_agent` step names an agent by id or
  name.
- **Agents:** `list_agents`, `get_agent` (its instructions, the pages shared with it, its
  skills and its memory), `draft_agent` (a draft from what the user says it should do: its
  instructions, the pages it needs and suggested schedules and automations, nothing saved),
  `create_agent`, `update_agent`, `set_agent_archived` (archive or bring back), `set_agent_access`
  (view, comment, edit or remove), `set_agent_skill` (give or take a skill only owners can edit),
  `change_agent_memory` (keep or dismiss the notes its runs proposed; add, update or delete
  an owner's own notes), `set_agent_schedule` (add, update or delete a schedule)
  and `list_agent_runs` (each run's steps summarized), `start_agent_run` (ask an agent for a task
  now, on a row or on none); `get_agent` also shows its monthly token limit and usage by month,
  and `update_agent` sets the limit, the model its runs use (`main` or `fast`) and `row_changes`
  (`direct` or `review`). `list_pending_changes` and `answer_pending_change` (approve, with
  edits and `force` for a row changed since, or dismiss) answer what agents proposed for
  review. Owners manage agents; members can list them (see [Agents](agents.md#agents)).
- **Memory:** `list_memory` (the user's notes in one workspace or all of them) and
  `change_memory` (add, update, or delete by ids or all, also while the memory is off): the notes the
  AI chat keeps about the user, theirs alone and only while the memory is on, each showing the app
  that kept it (see [Memory](ai.md#ai-features)).
- **Snippets:** `list_snippets` (the user's own and the workspace's, with their Markdown and what
  the placeholders stand for; see [Snippets](ai.md#snippets)).

An app only ever sees the pages its user can see. Read-only apps can't call the tools that
change anything, and a workspace's owners can let apps only read it, or hide it from them (see
[Workspace security switches](account-and-security.md#workspace-security-switches)).
