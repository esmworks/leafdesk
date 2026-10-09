# Changelog

## Unreleased

### Upgrading

- **`BETTER_AUTH_SECRET` is checked at startup.** In production the server refuses to start with
  the example value from `.env.example` or a secret shorter than 32 characters (make one with
  `openssl rand -base64 32`). Changing it signs everyone out; without `LEAFDESK_ENCRYPTION_KEY`,
  connections' tokens were sealed with a key derived from the old secret, so those connections
  have to be connected again.
- **Changing a workspace's SSO identity provider** (or removing the connection) now signs out
  everyone who signed in through it; they sign in again through the new one.
- **Push notifications** need `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT`
  (make the keys with `pnpm push:keys`; under Docker Compose they are passed through from `.env`).
  Without them push stays off and nothing changes. Migration `0047_push_subscriptions`.

### Added

- **Search filters and commands.** The search box (Cmd/Ctrl+K) narrows a search with
  `in:"Page title"` (that page and everything under it) and `type:page`, `type:database` or
  `type:row`, which also work on their own to list what they match. Before anything is typed it
  shows the pages last edited, and after `>` it runs commands (new page or database, from a
  template, import, trash, inbox, settings, keyboard shortcuts). A line under the results shows
  the syntax and puts it into the box. MCP and REST search keep their own parameters. No
  migration.
- **Import from Obsidian.** Import takes a vault's folder or a ZIP of it. Wikilinks (with labels,
  headings, block references and folder paths), Markdown links written by name and notes' aliases
  from front matter become page links, resolved across the vault: a path first, then the note of
  that name nearest the linking note, then an alias. Embedded images and files are uploaded, a
  note embedded on its own line becomes a link-to-page block, and callouts keep a matching color.
  Comments, block ids and highlight marks are left out; links naming nothing stay as text and are
  listed in the result. The import dialog no longer uploads hidden folders such as `.obsidian`.
  No migration.
- **Excel workbooks.** A database exports as an Excel workbook (.xlsx) next to CSV, from the page
  menu and for the selected rows of a table: the same rows and columns as the CSV export, with
  property access applied the same way, numbers as numbers, checkboxes as TRUE/FALSE and dates as
  dates (created and edited times with their time, in UTC), the header row bold and frozen. The
  import dialog's CSV tab takes .xlsx files too, as a new database or as rows of one, with the
  same type guessing, title column and column mapping as CSV; a workbook with several sheets asks
  which one to import (`/api/import` takes `sheet`, and without it imports the first and reports
  the others as left out). A formula's last result is imported, cells with an error come in
  empty, and old .xls files and password-protected workbooks are refused with their own message.
  The workspace and subpage ZIP exports keep databases as CSV. No migration.
- **Locked pages.** "Lock page" in a page's menu guards it against accidental edits: while it is
  locked nobody can change its title, icon, background, style or text, from the app, the history
  panel, MCP, the REST API, the AI writing assistant or the AI chat and agents. The page shows
  *Locked* in its header with an *Unlock* button for everyone who can edit it; it is a guard, not
  a permission, so any of them can unlock it. Open tabs turn read-only, and editable again after
  an unlock, without a reload. A database row locks the same way; its property values stay
  editable from views and MCP. Comments, sharing, moving the page, putting it in the trash and
  adding sub-pages still work, and a copy starts unlocked. `get_page` and `GET /pages/{id}` show
  `locked`, and writes to a locked page are refused with a message saying how to unlock it. No
  migration.
- **Keyboard shortcuts.** Mod+/ (⌘/ on a Mac, Ctrl+/ elsewhere), `?` outside text fields and the
  editor, or *Keyboard shortcuts* in the workspace menu opens a list of the shortcuts Leafdesk
  has: general ones, moving around (search, the sidebar, find and replace in a page), text
  formatting and blocks in the editor, and databases (opening a row, moving a timeline bar, saving
  a formula). Keys show as ⌘ ⌥ ⇧ on a Mac and Ctrl, Alt, Shift elsewhere. Unit tests in
  `src/lib/shortcuts.test.ts`. No migration.
- **Superscript and subscript.** Two new text styles, with buttons after strikethrough in the
  formatting toolbar and the shortcuts Mod+. and Mod+, (⌘ on a Mac, Ctrl elsewhere); text is one
  or the other, so setting one takes the other off. Pasted text whose `vertical-align` is `super`
  or `sub` keeps them. In Markdown (search, MCP `get_page` and `update_page`, exports and imports)
  they are `<sup>…</sup>` and `<sub>…</sub>`; published pages, the print view, version previews
  and the AI chat's answers show them. A tab still running an older release would erase the whole
  text of a block holding one (y-prosemirror drops text with a style its editor lacks); the build
  check that keeps such tabs from loading pages covers this too. Unit tests in
  `src/server/text-scripts.test.ts` and `src/lib/remark-text-scripts.test.ts`, and a check in
  `scripts/roundtrip-e2e.ts`. No migration.
- **Number formats.** A number property's menu sets how its values show: as a plain number, a
  percentage or an amount of money in a currency (Turkish lira, euro, US dollar, pound, Swiss
  franc, yen and a few more), with automatic or 0 to 4 decimal places. Amounts follow the
  viewer's language: ₺1.234,56 in Turkish, TRY 1,234.56 in English. A percentage stores the
  fraction: typing 15 or 15% in a cell, a bulk edit, a form or an automation stores 0.15 and shows
  15%, and filters on it compare percent points (15). Cells, row pages, boards, lists, galleries,
  calendars, timelines, published pages and print show the format, as do column footers and charts
  that sum, average or compare the values (counts and shares stay plain numbers) and rollups doing
  the same over a number property, which also filter by what they show. Typed amounts may carry their currency symbol or code. The
  format never changes the values: sorting, calculations, CSV export and MCP values stay plain
  numbers. A CSV import reads "15%" as 0.15 and "₺1.234,50" as 1234.5, and a new database's column
  written all in percentages becomes a percent property. MCP's `add_database_property` and
  `update_database_property` take `number_format`, and `get_database` shows it. Formulas show plain
  numbers. No migration.
- **Push notifications.** My account > Preferences turns push notifications on for the device in
  use ("Push notifications on this device"): new inbox items then show as system notifications,
  also while Leafdesk is closed, and opening one brings an open Leafdesk tab to the page (or opens
  one). Each kind of notification gets a *Push* switch next to *Inbox* and *Email*; push follows
  the inbox, so a kind kept out of the inbox isn't pushed, and every kind can be silenced on its
  own. A message says only what the inbox shows (the page, who did what), read with the same
  access checks, in the recipient's language. The settings say when the browser blocks
  notifications or can't receive them (Safari on iPhone and iPad only in the installed app).
  A device's subscription belongs to its sign-in: signing out, or the session being revoked,
  deletes it. The server sends with VAPID keys (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
  `VAPID_SUBJECT`; `pnpm push:keys` makes a pair) and stays off without them. Messages are
  encrypted for the browser, kept a day by push services, and go only to public https
  endpoints, checked before each send with the connection pinned to the checked address;
  `PUSH_ALLOWED_HOSTS` allows a push service on a private network. A push service saying the
  subscription is gone deletes it, and one that keeps failing is dropped after 10 failed sends in a row. Sending
  never holds up what caused the notification. New `push_subscription` table and push columns on
  `user_preference` (migration `0047_push_subscriptions`); the `web-push` library encrypts and
  signs the messages.
- **Dependencies.** A timeline view's settings turn dependencies on for the database: a two-way
  relation of the database with itself, *Blocked by* and *Blocking* (or a relation of the database
  with itself it already has), lets a row wait for other rows. The timeline draws an arrow from
  each row to the rows waiting for it, in red while a waiting row starts before the row it waits
  for ends, and dragging from the dot at the end of a bar onto another row makes that row wait for
  it. When a row's dates move, by a drag, an edit, a bulk edit, an automation or MCP, the rows
  waiting for it follow down the chain by the database's rule: only when they would overlap (the
  default), by as much to keep the gap, or not at all; moved rows can skip weekends. A row that
  starts waiting for another one is moved past its end. Rows the same write dated keep their
  dates, and rows the editor can't change stay where they are. Rows move by the start and end
  dates the timeline used when dependencies were turned on, which its settings can change. A row
  can't wait for itself or for a row waiting for it. Turning dependencies off keeps both properties
  and their links; a copied database keeps them. MCP gets `set_dependencies`, and `get_database`
  shows `dependency_role` and the rule. No migration.
- **Sub-items.** A table, list or timeline view's settings turn sub-items on for the database: a
  two-way relation of the database with itself, *Parent item* and *Sub-items* (or a relation of
  the database with itself it already has), lets a row go under another row. A row holds one
  parent: picking another moves it, and so does listing it under another row's sub-items. A row
  can't go under itself or one of its own sub-items, from either side, one row or many at once.
  Table, list and timeline views show sub-items nested under their parent (each viewer opens and
  closes rows for themselves, and the browser tab keeps them open), as a flat list, or only the
  rows without a parent with how many sub-items each has. Hovering a row offers a "+" to add a
  sub-item; on a timeline it starts where its parent does. A sub-item whose parent is filtered out
  or in another group shows at the top. Turning sub-items off keeps both properties and their
  links. Stored on the relation (`role`) and the view (`subItems`); no migration. Over MCP,
  `set_sub_items` turns them on or off, views take `sub_items` (`nested`, `flat`, `parents`), and
  `get_database` marks the two properties with `sub_items_role`.
- **Running totals and burndowns in charts.** A bar or line chart grouped by a date (or created or
  edited time) and measuring something that adds up (a count, a sum, counts of values or ticks)
  has *Over time* in its settings: *Each period* (as before), *Running total*, or *Remaining*.
  Remaining is a burndown: each row leaves the whole in the period of its date, and rows without
  a date stay open, so a chart grouped by a "finished" date (set by an automation when a status
  changes to done) shows the work left week by week. Periods run oldest first with quiet ones
  carried through; the tooltip shows the running value, the period's own value and the rows
  behind the point, which are what the value measures (done so far, or still open). Running
  totals aren't sorted by value or stacked, and the no-value group isn't a point of its own.
  Stored as `chartAccumulate` on the view; no migration. Over MCP, `create_database_view` and
  `update_database_view` take `accumulate` (`none`, `cumulative`, `remaining`) and refuse it
  where it can't apply, `get_database` reports it, and `query_database` returns each point's
  running value with `period_value` and the chart's `total`.
- **Page backgrounds.** *Add background* beside a page's icon (on a database page, over the end of
  its title on hover, so the view doesn't move down) fills the page behind its title and body: one
  of 7 colors, a light tint in the light theme and a dark one in the dark theme, or black in both;
  the header, the page's tables and their lines take the color too. A faint pattern (dots,
  crosses, grid or diagonal lines) can go over it, or over the plain page. The same button changes
  or removes them. A background is only ever drawn by the page's own styles: it never loads an
  image, uploaded or from another site. It is kept on the page (`page.background`, migration
  `0044_page_background`), so it changes live for everyone with the page open (an icon change now
  does too), and travels with copies, templates, published pages (their header too) and copies
  made from a published page; printing leaves it out. Over MCP and REST, `get_page` shows it and
  `update_page` / `PATCH /pages/{id}` set it with `background` (`color:<name>`, `pattern:<name>`
  or both separated by a space, `null` to remove). Not yet in Markdown exports and imports. Pages
  that had a cover from an earlier build of this release get the color closest to a gradient
  cover, and lose an image cover or image background (`0046_page_background_colors_only`, which
  also has the file trigger stop looking at backgrounds); `0045_drop_page_cover` removes the cover
  column.
- **Choosing the light or dark theme.** Settings > Preferences > Appearance sets the theme for this
  browser: the system's (as before), light or dark. It is kept in a cookie like the interface
  language, so the server draws the page in the chosen theme from the start, and the editor,
  diagrams and the browser bar follow it; a new choice switches the page, the editor and diagrams
  together at once, also offline. The print view stays light. No migration.
- **The calendar on phones.** The month fits the screen instead of scrolling sideways: each day
  shows a dot per row (up to three), and the rows of the picked day are listed under the month,
  where a row can be added on that day. Rows aren't dragged between days there. Wider screens
  keep the full grid.
- **Repeating templates.** The repeat button beside a row template in the menu next to *New* adds a
  row from it on a schedule: daily, weekly on chosen weekdays, monthly or yearly, every N of them
  (up to 99), at a time in an IANA time zone, from a first day, with the date added to the title if
  asked. The dialog shows when the next row comes. Rows are added as the person who set the repeat
  and start "row added" automations; when they can't add rows any more, or their account is gone,
  the repeat pauses with the reason shown until someone saves it again. Each server checks every 30
  seconds; a schedule is taken with `FOR UPDATE SKIP LOCKED` and its next run moved on before the
  row is added, so several replicas or a crash never add a run twice, and a server that was down
  adds one row for what it missed. Up to 200 repeats per workspace. They're kept in a new
  `schedule` table (migration `0040_schedules`), shared with what will run on a schedule later.
- **Reordering view tabs.** A database's view tabs can be dragged into another order, which
  everyone sees. The first tab is the one a published database shows. Not offered on a locked
  database or to people who can't edit it. Over MCP, `update_database_view` moves a tab with
  `before_view_id` or `after_view_id`, and MCP tools refused by a locked database now say so
  instead of reporting a server error.
- **Page style.** The page's `⋯` menu starts with a typeface for the page (*Default*, *Serif*,
  *Mono*) and switches for *Small text* (14px body, headings scale with it; touch screens keep
  16px so iOS doesn't zoom in on the text when typing starts) and *Full width* (the
  text starts at the same gutter as a database). The style is kept in the page's shared document,
  so it changes live for everyone, shows on pages kept for offline use, and travels with copies,
  templates and published pages; no migration. The server reads it on the first render, so a
  page opens in its style without a jump. The print view takes the typeface and text size. Shown
  to people who can edit pages with a body; databases are unchanged. Published headings are now
  sized relative to the body text (the same at the default size).
- **Agents.** An agent is an AI helper of a workspace with a name, an emoji, a description and
  instructions of its own, run by a new automation action, *Run an agent* (`run_agent`, the agent
  by id or name and a task of up to 2000 characters), on the row that started the automation.
  Each agent acts as a user of its own: a bot user that can't sign in, a guest of the workspace,
  so it sees only the pages shared with it (view, comment or edit, never full access) and its
  changes and comments show its name. Saving an automation that runs an agent shares the
  database with it at edit access. A run reads what is shared with the agent and changes or
  comments on its row, nothing else, in at most 8 model turns, 5 changes and 2 minutes; it needs
  AI set up on the server and on for the workspace (otherwise it ends as `aiOff`), and what it
  changes starts no automations. Runs are kept for 30 days with each step, the answer and the
  tokens used; a run's steps, answer and error show only to owners who can open its row. In
  Settings → *Agents*, owners create, change, pause, archive and restore agents (at most 50 per
  workspace), choose what they may open and look through their runs; members see the list. Three
  built-in agents (Ticket router, Request answerer, Duplicate finder) are set up on a database in
  one step, with instructions in the owner's language naming the properties picked. An agent
  isn't a person: lists of members, guests and people, mentions, notifications and emails leave
  it out, it can't be made a member or owner, it can't sign in, and deleting its workspace deletes
  its user; where it acted it shows as an agent (person cells, comments, page history, the audit
  log's new `agent` actor kind). Anything shared with an agent can end up in rows it writes,
  visible to everyone who can open those rows. MCP tools
  `list_agents`, `get_agent`, `create_agent`, `update_agent`, `archive_agent`, `restore_agent`,
  `set_agent_access` and `list_agent_runs`; `create_automation` and `update_automation` take
  `run_agent` actions and `list_automations` names their agent. No REST endpoints. Migrations
  `0037_agents` (tables `workspace_agent` and `agent_run`) and `0038_agent_audit_actor`. New
  checks in `scripts/agents-e2e.ts`, `scripts/mcp-e2e.ts`, `scripts/audit-e2e.ts`,
  `src/server/mcp/tools.test.ts` and `src/lib/builtin-agents.test.ts`. See the README (Agents).
- **Connections.** Owners link a workspace to remote MCP servers (Slack, GitHub, a CRM, another
  Leafdesk...) in Settings → *Connections*, signing in with OAuth (dynamic client registration and
  PKCE), a bearer token, or nothing; at most 20 per workspace. Tokens and event secrets are sealed
  with AES-256-GCM under `LEAFDESK_ENCRYPTION_KEY` (derived from `BETTER_AUTH_SECRET` when unset;
  `LEAFDESK_ENCRYPTION_OLD_KEYS` keeps older keys opening what they sealed) and never come back to
  the browser. Connections reach only public `https` addresses, checked again on connecting and on
  each redirect; `CONNECTOR_ALLOWED_HOSTS` lets through hosts on a private network. A server's
  tools are classed *read* (marked `readOnlyHint`) or *write* (everything else), and owners can
  change the class; on an agent's new *Connections* tab they tick the tools it may use. A new
  address starts a connection over: its token must be pasted again, and classes and agents' tools
  are reset. Read tools run at once; a write tool makes the run wait (`awaiting_approval`) and
  puts an item in every owner's inbox with the agent, the tool and its exact input, to approve,
  decline or send back with a note; after 24 hours nothing is sent (`approvalTimeout`, a later
  answer is refused), nor when the tool or connection goes meanwhile (`connectionGone`), and a run
  taken up again after a restart doesn't send an approved call twice. Each connection has a signed
  events address, `/api/connections/<id>/events`, for Leafdesk's own HMAC scheme, Slack's Events
  API or GitHub webhooks; events that are unsigned, stale (over five minutes), over 256 KB or
  repeated (by delivery id or by signature) are refused, at most 120 signed ones a minute, and the
  others start the agents whose triggers match their type, with the trigger's task and the event's
  type and body as data; one the server failed on is handled when sent again. The runs list shows
  a run's tool calls and answers, and events are kept for 7 days. Every change, tool call and
  approval answer is audited. MCP tools `list_connections` and `set_agent_connection_tools`;
  `list_notifications` and `list_agent_runs` show approvals. No REST endpoints. Migrations
  `0041_connections` and `0042_connection_event_signature`. New checks in
  `scripts/connector-e2e.ts` (against a second Leafdesk started as the MCP server) and
  `scripts/mcp-e2e.ts`, and unit tests for the address checks, event signatures, slugs and the
  secret box. See the README (Connections).
- **Database automations.** When a row is added, or a property changes (optionally only when it
  becomes a value: a select or status option, a checkbox state, a person or multi-select option
  being added), an automation sets properties on the row (a date to the day it runs, in UTC, a
  person to whoever made the change), notifies people (chosen ones and those a person property names, in
  the inbox and by email as each chooses, only if they can open the row) or sends the row to a
  webhook. People with full access to the database manage them from the ⚡ *Automations* button in
  its toolbar (each with its recent runs, and for webhooks the signing secret, *Replace secret* and
  *Send test*); an automation runs as the person
  who saved it last, with their access when it runs, and the changes it makes start no other
  automations. Runs are kept for 30 days with how each action went. Webhooks are JSON POSTs
  signed with HMAC-SHA256 (`X-Leafdesk-Signature: t=<unix>,v1=<hex>`, plus `X-Leafdesk-Event`
  and `X-Leafdesk-Delivery`), retried up to 5 times on network errors, timeouts, 408, 429 and
  5xx, and refused for private and local addresses unless the host is listed in the new
  `AUTOMATION_WEBHOOK_ALLOWED_HOSTS` (passed through by `docker-compose.yml`). A new inbox kind,
  *Automations*, with its own inbox and email switches. MCP tools `list_automations`,
  `create_automation`, `update_automation`, `delete_automation` and `list_automation_runs`, with
  properties by name and people by id, email, name or `"me"`. Migration `0036_automations` adds
  the tables `database_automation` and `automation_run`, `notification.automation_id`, and
  `user_preference.automation_inbox` / `automation_emails`. See the README (Automations and
  webhooks).
- **Rename from the sidebar.** A page's `⋯` menu in the sidebar has *Rename*: the name turns into
  a field (Enter saves, Escape cancels). It writes the title through the page's shared doc, so an
  open page and its tab update at once. Until now the only way to rename was the title on the page
  itself, and an untitled page showed just a grey "Untitled" that didn't read as editable.
- **MCP: `get_file`** reads a file uploaded to Leafdesk, by its id, `/api/files/<id>` path or url
  (what `get_page` and `query_database` show): text files (Markdown, CSV, JSON, XML, code…) and
  PDFs come back as text (a PDF's text layer, read with `unpdf`; scans have none), cut at 30,000
  characters with `offset` to read on; PNG, JPEG, GIF and WebP images come back as image content.
  Other kinds, and files over 5 MB (text, images) or 25 MB (PDF), are described with their link.
  It needs no extra permission: the user reads a file when they can see a page showing it, in a
  workspace that doesn't hide itself from connected apps (`fileForApp`). Until now an AI app saw a
  file's link but couldn't open it: the file route only knows browser sessions.
- **MCP: `duplicate_page`** copies a page with everything under it beside the original, as the
  page menu's *Duplicate* does, titled "<title> (copy)" or as given.
- **MCP: favorites.** `list_pages` with `favorites: true` lists the user's starred pages of a
  workspace, and `get_page` (and `GET /api/v1/pages/{id}`) says whether a page is starred
  (`favorite`).
- **MCP: links as ids.** Wherever a tool takes an id (`page_id`, `workspace_id`, `row_ids`,
  `view_id`…), a Leafdesk link works too: `https://…/w/<workspace>/p/<page>`, with `?view=<view>`
  for a view. Other arguments, such as page mentions in Markdown, are left as they are. New checks
  in `scripts/mcp-e2e.ts` (248 in all), `src/server/mcp/tools.test.ts` and
  `src/server/mcp/format.test.ts`.

### Changed

- **New mark.** A green l whose foot curves toward a dark d, set apart from the d's bowl by a gap
  that follows its curve, replaces the block-leaf mark in the logo, the app and touch icons, the
  favicon and the website's preview image. The wordmark and colors stay the same.
- **Dependency checks.** A weekly workflow (`.github/workflows/dependencies.yml`, also on changes to
  the lockfile) runs `pnpm audit --prod` and lists outdated direct dependencies. Advisories that
  can't reach a running server are reviewed in `pnpm-workspace.yaml` (`auditConfig.ignoreGhsas`,
  each with its reason); any other one fails the check. lodash-es 4.18.1 (under Mermaid's parser)
  and source-map-js 1.2.2 (under Next.js's PostCSS) are pinned by override for their advisories.
- **Bundle budget.** CI fails when the JavaScript a browser downloads grows past its budget: the
  largest first load of any route (the page editor, about 700 kB gzipped today, budget 800 kB) and
  all client chunks together (about 2,700 kB, budget 3,150 kB). `pnpm tsx scripts/bundle-budget.ts`
  after `pnpm build` prints the largest routes.
- **A database's tab title names its view.** The browser tab of a database reads
  "Customers · By city · Leafdesk": the view it shows, following view switches and renames of the
  database or its views, and kept on a reload or a shared `?view=` link.
- **Leafdesk's own colors.** Select and status options, board columns, the editor's text and block
  colors, chart groups and page history now use one palette built from the same lightness and
  saturation per role in each hue, slightly richer than before, with gray leaning toward the brand
  green. Every text and background pair reads at 4.5:1 or more in both themes; dark mode also sets
  the editor's text colors, which came from BlockNote until now. In dark mode option chips are
  mid-tone instead of near-black and board cards take more of their column's hue, so groups and
  tags tell apart at a glance.
- **Trademark notice.** The README and the website say that Notion is a trademark of Notion Labs,
  Inc. and that Leafdesk is not affiliated with it. The MCP server's instructions describe Leafdesk
  on its own terms instead of as "Notion-like".
- **MCP hardening.**
  - *Rate limit:* each user may make 120 requests a minute to `/mcp`, all their connected apps
    together (`MCP_RATE_LIMIT`, `0` turns it off). Beyond it the server answers `429` with
    `Retry-After` before it looks anything up, so requests over the limit cost next to nothing.
    The MCP end-to-end script checks the limit the server actually has (`MCP_E2E_SKIP_RATE_LIMIT=1`
    for a server without one).
  - *Content is data:* the server's instructions say that what the tools return was written by
    people, some from outside the workspace, and is never instructions; every read tool's result
    ends with a one-line reminder of it.
  - *Password changes:* changing the password with *Sign out of all other sessions*, or resetting
    it by email, also disconnects the apps the user connected; they have to be connected again.
    Each app disconnected this way shows in the audit log, as one disconnected by hand does; if
    that record can't be written, the change still completes. The "password changed" email goes
    out before the apps are disconnected.
  - *AI prompts:* a closing tag written in capitals or with spaces (`</ROW>`, `< / row >`) can no
    longer end a data section of an AI prompt early, and a connection's answer can't close the
    frame that marks it as outside data.

### Fixed

- **View access could rewrite a page's text through MCP and the REST API.** `update_page` (and
  `PATCH /api/v1/pages/{id}`) with `markdown` checked only that the caller could see the page before
  replacing or appending to its body, so someone with view access, or a connected app acting for
  them, could change it. It now needs edit access, like the title, icon and background already did.
  Checked in `scripts/access-e2e.ts`.
- **Security fixes from an audit of the whole app.**
  - *Collaboration:* a 23-byte update could hold the server (and every request with it) for
    seconds while it checked comment threads; any viewer could send one. The check now runs in time
    bounded by what an update holds, read-only connections skip it, and websocket messages over
    16 MiB are refused. Reconnecting to a page whose comments had changed no longer fails with
    "Forbidden". Workspace and database signal channels are read-only, cursor labels carry the
    signed-in name and color (a browser's own could restyle others' pages), a collaboration token
    stops working once its session ends (a tab fetches a new one), and an owner made a member is
    checked again on open pages.
  - *Published pages and the print view:* text an editor typed into a link, image, caption or
    color could become live HTML, because heading anchors were added by searching the serialized
    page. They are set on parsed elements now.
  - *Sign-in policies:* any `Authorization: Bearer` header made a browser request skip "require
    two-step verification" and "SSO only"; only requests a token actually authenticated skip them
    now. A session a policy holds back can't create API tokens or approve connected apps either.
  - *Accounts:* claiming an account someone had signed up for with your address (by a provider
    vouching for it or by a reset link) now also removes their passkeys, two-step verification, API
    tokens and connected apps. An email verification link no longer signs in past two-step
    verification. Pointing a workspace's SSO connection at another identity provider, or removing
    it, forgets who signed in through it.
  - *Workspaces:* a join link took up a pending invitation's role (owner included) for anyone
    signing up with the invited address unverified; only a verified address does now, and the
    invitation stays for its owner otherwise.
  - *Import:* a ZIP of stored entries sharing their bytes could unpack far past the size limit.
  - *Agents:* an automation's agent read with everything shared with it, whoever's change started
    the run, so a member could have it copy a page or a property value they can't open into the
    row or a comment. A run a member (or guest) started now opens, reads and changes only the pages
    and property values both the agent and that person can. On a row no member wrote (an anonymous
    form answer, a visitor outside the workspace) every connection tool waits for an owner's
    approval, not only the ones that write. Runs started by a connection's events are unchanged.
  - Smaller: sign-in rate limits count by the address the server works out instead of
    `X-Forwarded-For`; `/sign-in?next=/\host` no longer leaves the site; a connection's
    credentials aren't sent along a redirect to another origin; sealed secrets need their full
    GCM tag; a page template is copied only into its own workspace from the API and MCP; formula
    functions named like built-in object members are unknown functions. Next.js 16.3.8 and sharp
    0.35.5 for their security fixes.
- **Tabs left open across an update could delete new blocks.** y-prosemirror deletes from the
  shared document any block its editor can't build, and the deletion syncs to everyone, so a tab
  still running the previous release removed blocks a newer one added (columns, Mermaid, a table
  of contents…) as soon as it showed them, also from its offline copy. Each `next build` now gets
  an id, compiled into the browser bundle and read by the server from `.next/BUILD_ID`. The
  collaboration server refuses a tab of another build (and, in production, one that sends none:
  tabs opened before this release, which show "access lost" until reloaded) before sending any
  document; a tab checks the build in the collaboration token reply before it loads a page's
  offline copy, and offline goes by the build another tab of the browser last met. Such a tab
  shows "Leafdesk has been updated" with a Reload button, in front of everything; its edits stay
  in the browser and are sent after the reload. No automatic reload, so typing in progress is
  never cut off and an offline tab can't loop.
- **Comments panel over the page.** With the comments panel open, a page's text ran under it on
  most screens. The page now keeps its place while it clears the panel, moves left when it
  doesn't, and narrows once it reaches the sidebar.

## 0.4.0 — 2026-10-02

### Upgrading from 0.3.0

- **Migrations** (0031–0035) run automatically when the container starts.
- **OpenCode Go:** to use it with Docker Compose, download the new `docker-compose.yml`, which
  passes `OPENCODE_API_KEY` to the app (or set the key as `AI_API_KEY`).

### Added

- **The AI chat can add and change things**, as the person and only where they may edit:
  `create_row` adds a database row (values and text), `update_row` changes a row's values or
  title, `create_page` adds a page under a page (or a private one at the top of the workspace; in
  a page's scope, only under it). A mode under the question box, remembered in the browser, says
  what it may do: *Ask* (the default) puts each change in the box's place before it's made (what,
  where, the values, the start of the text) with *Yes*, *Yes, and don't ask again* (switches to
  *Auto*) and *No* (1, 2, 3; Escape says no); *Auto* doesn't ask; *Read only* doesn't offer the
  model changes. Changes are checked (target, edit access, values) before the person is asked; the
  answer's stream waits for the decision (`decideChangeAction`, only the asker's), pinging every
  20 seconds, and stopping, leaving or 15 minutes without a decision write nothing. Changes made,
  declined or failed are steps with links, kept with the conversation even when no answer text
  came, and noted with their ids for later questions. The API takes `mode` (`ask`, `auto`,
  `read`). `Popover` takes `side="top"`. The chat route no longer writes to a stream the browser
  has closed. New checks in `scripts/ai-chat-e2e.ts` (120 in all) and `src/server/ai/chat.test.ts`.
- **Audit log** (#61), in Settings → Audit log for owners (members, guests and everyone else get a
  404): who changed what in the workspace, newest first, 50 to a page, filtered by person (or the
  identity provider, or the server), kind of change and a range of days in the viewer's time zone,
  and downloadable as CSV with the same filters (up to 10,000 events). Recorded: members added,
  joining (join link, email domain, single sign-on, SCIM), removed or leaving, role changes and
  handing over ownership; invitations sent, revoked and accepted, the join link turned on, off or
  replaced, join requests approved or declined; page sharing with a person, everyone or a group
  (and by email), and access requests decided; teamspaces created, changed, archived, restored and
  their members, roles and groups; groups created, renamed, deleted and their members; the
  workspace renamed and its settings, with the before and after of each changed setting; single
  sign-on saved, verified or removed, SCIM tokens created or revoked; pages deleted for good (by a
  person, or by the trash cleanup as the system), published, unpublished or taken off the web by an
  owner, the site saved or removed; API tokens created or revoked and apps connected or
  disconnected (in each workspace they reach); exports (the workspace ZIP, a page as ZIP, Markdown,
  CSV or the print view). Each event names the person, the API token or connected app they acted
  through, or the SCIM token, with the request's address and browser, and reads as a sentence in
  the viewer's language. Recording never fails or holds back a change: it runs in the change's
  transaction (a savepoint) where there is one, right after it otherwise, and a failure is only
  logged. The daily retention cleanup prunes events older than a year. Migration `0031_audit_log`
  (`audit_event`). New checks: `scripts/audit-e2e.ts` (169), `src/lib/audit.test.ts`.
- **Reorder columns by dragging.** A table's column headers, and the properties in any view's
  properties menu, can be dragged into a new order, which the view keeps (`propertyOrder` in its
  settings, so each view has its own order and the database's property order stays as it is).
  Boards, galleries, lists, timelines and published pages show properties in that order too.
  Hidden columns keep their place, properties added later show at the end, and a
  view saved by someone who can't see some columns leaves those where they were.
- **Resize table columns by dragging.** Each column header, the Name column's too, has a handle on
  its right edge; the column follows the pointer and keeps the width it is let go at, which the
  view saves (`columnWidths` in its settings, per view). Phones keep the narrow Name column.
- **Customize the sidebar per workspace.** "Customize sidebar" at the bottom of the sidebar lists
  its sections (Favorites, Teamspaces, Shared, Private) to reorder by dragging or with the arrows
  and to hide or show. The order, hidden sections and which headings are folded are kept for each
  person in each workspace, on every device, so a personal workspace and a company one can look
  different; folding a heading no longer changes it in every workspace. Migration
  `0035_member_sidebar` (`workspace_member.sidebar`).
- **Property access.** Someone with full access to a database opens *Property access* from a
  column's menu and sets what everyone with access to the database may do with that property: edit
  it, edit its values, view them, see only the column, or nothing, with exceptions for people,
  groups and whoever a person or created-by property of the row names. The widest rule wins, nobody
  gets more than their database access, and full access is never restricted; the dialog says who
  still has full access and links to the database's Share panel. Relations and system properties
  can't be restricted. Values a person may not see are left out before formulas run (formulas and
  rollups over them are dropped), and views, filters, sorts, search, the semantic index, autofill,
  exports, print, published pages, MCP (new `set_property_access` tool) and the REST API never
  reveal them; writes, board drags, bulk edits, schema changes, CSV imports, forms, templates and
  copies follow the same rules. Assignment notices and emails skip people who can't see the person
  property. Changes land in the audit log. Migration `0033_property_access`
  (`property_permission`).
- **What a teamspace's members get on its pages.** A teamspace's owners can lower the access its
  members get where a page doesn't decide (full, edit, comment or view). Full stays the default, so
  nothing changes for existing workspaces. The teamspace's owners and the workspace's owners keep
  full access, and whoever adds or moves a page to the top of a lowered teamspace gets full access
  to it. Migration `0034_teamspace_member_level`.
- **OpenCode Go as an AI provider:** `AI_PROVIDER=opencode-go` with a Go key (`AI_API_KEY` or
  `OPENCODE_API_KEY`) and any model of its catalog, e.g. `AI_MODEL=kimi-k3`. Each model goes to the
  API it is served over (chat completions, Responses or Anthropic's Messages) with its own context
  window. Requests carry the `x-opencode-session` header Go asks for (the conversation's id in the
  AI chat, a new one for every other request) and name Leafdesk as their user agent; other
  providers get neither. New checks in `src/server/ai/providers.test.ts`.

### Changed

- **Ask AI sits beside Home in the sidebar,** as a ✨ icon next to People, where it took a row of
  its own.
- **Actions under AI chat messages.** An answer has *Copy* (its Markdown, without the citation
  numbers), *Answer again* (the latest one) and when it was written; a question shows, on hover,
  when it was asked, *Edit* (the latest one: the edited question is answered in place of it) and
  *Copy*. Answering again or an edited question replaces the last question and answer once the new
  answer is kept (`replaceLast` in the API); one that fails leaves them as they were. An answer
  that changed things can't be answered again or edited (it would make the changes twice).
  Messages now carry their time (`at`). New checks in `scripts/ai-chat-e2e.ts` (126 in all).
- **Escape closes one thing at a time.** In the AI chat panel, Escape in a menu (the mode, the
  history) or while editing a question closed the panel too; now it only closes the menu or the
  edit. Menus (`useDismiss`) mark the Escape they handle, for whatever else listens.
- **AI chat answers no longer list their sources below.** The numbered citations in the text stay:
  they open the page (at the passage) and name it on hover.
- **The AI chat decides what to look at.** The question was searched for before the model saw
  it, as a whole ("Bekleyen ne iş var" found nothing, and the model then guessed words to search
  for). Now nothing is searched for it: the question goes with a map of what the person can open in
  the workspace (or under the scope page): the databases with their properties, types and options
  (a status's options by group: to do, in progress, done), and the pages, each with its id and
  where it is, up to 8,000 characters. The model is told to think first: to query a database for
  tasks and records, to search with a few distinctive words rather than the question, and to
  answer greetings without tools; and to write everything, also what it says before using a tool,
  in the language of the question. Six turns per question, where there were five. The full-page
  chat lists a new conversation in the sidebar as soon as it starts, not once it's answered. New
  checks in `scripts/ai-chat-e2e.ts` and `src/server/ai/chat.test.ts`.
- **The AI chat can query databases.** A new `query_database` tool lists the rows of a database that
  match filters on its properties (the same filters, operators, groups and sorts as the MCP tool:
  "assigned to me", "status is open", "due in the next 30 days"…), run as the person through the
  same operation, so values they may not see can't be filtered on or returned. Each row found is a
  source the answer can cite. It is refused for databases the person can't open, outside the
  chosen scope or in another workspace, and an invalid filter comes back to the model saying why.
  `read_page` on a database now lists its properties with their types and options, and a row found
  by search names its database, so the model knows what to filter on. The query shows as a step
  ("Queried Tasks · Status = Open or Due within next 30 days · 12 rows", in the words of the
  database's filter menu), kept with the conversation. Databases in the chat's steps and sources
  show the database icon when they have no icon of their own, as in the sidebar. New checks in
  `scripts/ai-chat-e2e.ts`.
- **The AI chat shows the steps it takes.** Above each answer, while it's written: *Working · 4s*
  with the steps listed as they happen (the search with the question and how many pages it found,
  what the model says before searching or reading, its searches with their result counts, and the
  pages it reads as links), then folded into *Worked for 16s*, which opens them again. Steps and
  time are kept with the conversation (answers from before have none); a page read that the person
  can no longer open is shown without its title. Chat answers carry `step` events in place of
  `tool`, and `done` says how long the answer took. New checks in `scripts/ai-chat-e2e.ts`.
- **The AI chat has a page of its own, and the panel opens from the page.** *Ask AI* in the
  sidebar now opens the chat across the page (`/w/[id]/ai`, `?c=` naming the conversation), where
  the sidebar lists the conversations in place of the pages: by when they were last added to
  (today, yesterday, the last 7 and 30 days, older), each one a link, with *New chat*, deleting one
  or all, and *Back to pages* to the page you came from. The panel beside a page opens from a ✨
  button in the page's header and can be expanded to the full page with its conversation. A source
  clicked in the full page opens its page with the conversation carried on in the panel (on a
  phone, just the page). New checks in `src/lib/ai-chat.test.ts`.
- **The AI chat finds pages from whole questions, and reads databases' rows.** Its full-text search
  required every word of the question on a page, so "Kart ekstreleri ne durumda?" found nothing
  without an embeddings model. It now finds pages with any of the words, as prefixes (long words
  cut to five letters, a rough stem for suffixes), without question words and fillers, titles
  ranked first; the search box, MCP and the REST API still want all the words. `read_page` on a
  database lists its first 200 rows with the values the person may see, where it gave only the
  property names, and a row a search finds comes with its values (those the person may see), as
  its page's text has none of them. New checks in `scripts/ai-chat-e2e.ts` and
  `src/lib/search-words.test.ts`.
- **AI chat answers are shown as markdown** (GitHub's dialect, through `react-markdown` and
  `remark-gfm`): tables, italics, strikethrough, links (opened in a new tab), code blocks, quotes,
  task lists and nested lists, where only bullets, headings, bold and inline code were recognised
  before. Citations stay buttons to their sources, also inside tables; code is left as written.
  Images are not loaded and raw HTML shows as text, so an answer repeating a page can't make the
  browser fetch an address or run markup. The renderer loads with the panel's first answer.
- **The AI chat says it is thinking while the model works,** before each of its turns, instead of
  showing the question as a search ("Searching for “Hello”…" until the first word arrived). The
  model's own searches and the pages it reads are still shown as they happen. Chat answers carry a
  new `thinking` event.
- **Emails in the recipient's language.** Every email to someone with an account (shares,
  comments, mentions, reminders, assignments, access and join requests and their answers, password
  resets, verification and account notices) is written in the language they last used: the one
  they picked in My account → Language, or their browser's, stored with their account
  (`user_preference.locale`) when they sign in or up and when they change it, not on every request.
  Until it is known it falls back to the language the email was queued with, as before (the
  actor's, or the requester's); invitations to addresses without an account still go out in the
  inviter's. At sign-in a language picked on that device replaces the stored one, while a browser's
  only fills it in when none is stored, so signing in elsewhere keeps the language someone chose; a
  sign-in that states no language (no cookie, no `Accept-Language`) keeps it too.
- **Settings → Guests shows who really invited a guest.** The membership now records who brought
  each person in (`workspace_member.invited_by`): whoever added them or shared a page with them,
  sent the invitation they redeemed (also through the join link), or approved their request.
  Nobody for those who came in on their own (join link, allowed email domain, single sign-on,
  SCIM). The list used to guess from the oldest page entry someone else gave them, and still does
  where nothing is recorded. The migration fills it in for existing members from the audit log
  (added by someone else, or the sender of the invitation they accepted), and for other guests
  with the old guess. Migration `0032_recipient_locale_and_inviter`. New checks:
  `src/server/mail/locale.test.ts`, and in `scripts/access-requests-e2e.ts`, `person-e2e.ts`,
  `account-e2e.ts`, `guests-e2e.ts` and `membership-e2e.ts`.

## 0.3.0 — 2026-09-28

### Upgrading from 0.2.0

- **New name and image:** the project is now Leafdesk, published as `ghcr.io/esmworks/leafdesk`.
  Download the new `docker-compose.yml` into the same folder as before (the folder name is the
  Compose project name, so the existing volumes are found), and in `.env` rename the old
  `…_VERSION` variable to `LEAFDESK_VERSION` if you pinned a version.
- **Keep your database:** the bundled PostgreSQL keeps the user, password and database name it was
  created with (the project's previous name; see `POSTGRES_USER` and `POSTGRES_DB` in your old
  `docker-compose.yml`), while the new defaults are `leafdesk`. Keep
  `COMPOSE_PROFILES=bundled-db` and add
  `EXTERNAL_DATABASE_URL=postgres://<old user>:<password>@db:5432/<old database>` to `.env`, with
  your `POSTGRES_PASSWORD` (the old default password, the same as the old user name, if you never
  set one). Without it the app can't connect.
- **Migrations** (0009–0030) run automatically when the container starts.
- **Uploaded files** are stored in the new `uploads` volume (or S3-compatible storage with
  `S3_BUCKET`).
- **Behind no reverse proxy:** the app now reads visitors' addresses from `X-Forwarded-For`,
  trusting one proxy by default. Set `TRUSTED_PROXIES=0` when clients reach the app directly.

### Added

- **Membership policies and join requests** (#56), in Settings → Security → Members: *who can add
  members* (owners only, the default; members with an owner's approval; owners and members, members
  adding members only), *allowed email domains* (subdomains included, public mail domains refused)
  that *join as members* or *ask to join*, and *who can ask to join* (nobody, the allowed domains,
  or anyone with the join link, which then asks instead of admitting). The domain rule runs for
  verified addresses on sign-up, sign-in, email verification (a password reset through the emailed
  link counts, see #59) and email change, once per person and workspace: leaving, removal (by an
  owner or SCIM) and declined requests are remembered, so nobody is pulled back in. Someone who
  joins through a domain on sign-up gets no personal workspace. The workspace switcher lists
  workspaces a person's domain lets them join or ask to join. Owners approve or decline in Settings
  → Members → Requests; each request is in every owner's inbox (new notification kind
  `join_request`, with its own inbox and email preferences, also in MCP `list_notifications`) and
  emailed to them; the person who asked gets the decision by email in their language. A member's
  approved request goes out as their invitation. MCP `invite_member` follows the same rule (a
  member's invitation there answers `status: "requested"` while approval is on). One pending request
  per person (or invited address) and workspace; 10 requests an hour per person, 100 invitation
  requests an hour per member. **Email verification:** with email available, email and password
  sign-ups get a verification link (resend it in My account → Profile); without SMTP in production,
  only provider-vouched addresses (GitHub, Google, SSO, SCIM) count as verified.
  `scripts/auth-e2e.ts` and `scripts/account-e2e.ts` expect the verification email. Migration
  `0030_membership_policies` (`workspace_join_request`, notification `join_request_id`, `page_id`
  nullable for join requests). New checks: `scripts/membership-e2e.ts` (106),
  `src/lib/membership-policy.test.ts`.
- **Instance administrators** (#59): accounts whose verified email is listed in `ADMIN_EMAILS`
  (comma-separated, any case; no role in the database) get Server administration at `/admin`,
  a 404 for everyone else. It lists the accounts (name, email, verified, workspaces, last active,
  two-step verification) with a search, signs one account or everyone but the administrator's
  own browser out (closing their live collaboration connections too), and requires a new
  password of one account or of everyone with a password: their sessions end, their next
  password sign-in gets no session, and they choose a new one through an emailed reset link
  (with SMTP) or right on the sign-in page (without; with a two-step code when they have it on).
  The old password can't be chosen again; any password change clears the requirement; accounts
  without a password are not affected. `WORKSPACE_CREATION=admins` keeps creating workspaces to
  administrators (hidden from others and refused by the server; the personal workspace at sign-up
  is still created). New command `pnpm auth:verify-email <email>`; a password reset through the
  emailed link now also marks the address verified. Better Auth's admin plugin was not used: it
  needs a role column and has neither required resets nor an instance-wide sign-out. Migration
  `0029_instance_admin` (`user.password_reset_required`). MCP: `list_users` returns `joined_at`;
  new `invite_member` tool (owners only, needs write access). New checks: `scripts/admin-e2e.ts`
  (in CI), `src/lib/instance-admin.test.ts`, more in `mcp-e2e.ts` and `tools.test.ts`.
- **Semantic search** (#43; optional, on with `AI_EMBEDDINGS_MODEL`): search also finds pages by
  meaning, merged with full-text results by reciprocal rank fusion, in the search dialog (marked
  *Similar meaning*), MCP `search` and REST `GET /search` (each result has `match: "text"` or
  `"semantic"`). Pages are cut into chunks (title, a row's values, the body's blocks) whose
  embeddings are stored in `page_chunk` as `real[]` with their model, dimensions and a content hash
  (only changed chunks are embedded again), ranked by cosine similarity in SQL (`embedding_cosine`,
  no extension needed; the README describes moving to pgvector for large workspaces). Indexing runs
  in the background a few seconds after pages are edited, created, renamed or restored or a row's
  values change, within `AI_CONCURRENCY` and `AI_WORKSPACE_RATE_LIMIT`; a workspace's first search
  sweeps up pages the index missed, and `pnpm search:index` backfills everything. Access is
  checked when the query runs, before ranking, never stored in the index. Trashed pages drop out
  at once; turning AI off for a workspace deletes its index. New setting
  `AI_EMBEDDINGS_MIN_SIMILARITY` (default 0.3). Without an embeddings model search is exactly the
  full-text search it was. Migration `0026_semantic_search`. New checks:
  `scripts/semantic-search-e2e.ts` (64, against a stand-in OpenAI-compatible server),
  `src/server/semantic-text.test.ts`.
- **AI chat** (#41): *Ask AI* in the sidebar opens a panel that answers questions from the pages
  the person can read, citing them as links to the page and block. Each question is searched for
  (hybrid search) and the model may call `search_pages` and `read_page` (up to five turns), which
  run through `operations.ts` as the person with their access checked on every call; answers
  stream (`POST /api/ai/chat`, NDJSON) and can be stopped. Questions can be kept to the current
  page and its subpages. Conversations are private, kept per person and workspace
  (`ai_conversation`, migration `0027_ai_chat`; 50 per workspace, 40 questions each, 4000
  characters a question), listed and deletable in the panel, and deleted when the person leaves
  the workspace or deletes their account; cited pages they can no longer open lose their title.
  Off while offline and when AI is off, with the reason shown. Links to `#block-<id>` scroll to
  and highlight the block. New checks: `scripts/ai-chat-e2e.ts` (62), `src/server/ai/chat.test.ts`.
- **Single sign-on and SCIM** (#38), with Better Auth's SSO plugin (`@better-auth/sso` 1.7.6):
  an instance-wide OpenID Connect provider from `OIDC_ISSUER`, `OIDC_CLIENT_ID`,
  `OIDC_CLIENT_SECRET` (`OIDC_NAME`, `OIDC_DOMAINS`), and one OpenID Connect or SAML 2.0
  connection per workspace, set up by owners in Settings → Security. A workspace connection signs
  people in only for its email domains, once each is verified with a DNS TXT record
  (`_leafdesk-sso.<domain>`); public mail domains can't be claimed and a domain belongs to one
  connection. "Continue with SSO" on the sign-in page routes an email to its provider. The first
  sign-in creates the account (only in those domains) and joins the workspace as a member;
  two-step verification still asks for its code afterwards. New workspace setting *How members
  sign in*: *Any method* or *Single sign-on only*, enforced like "require two-step verification"
  (pages, exports, actions, API routes, live collaboration; a new `/sso-required/<id>` page), with
  owners and guests exempt. SCIM 2.0 at `/scim/v2` with workspace SCIM tokens (hashed, revocable):
  `Users` list/filter/get/create/replace/patch/delete, where `active: false` removes someone from
  the workspace and owners can't be deactivated; `Groups` in the next entry.
  The SSO box lists the workspace ID, OIDC redirect URI, SAML entity ID, ACS and metadata URLs to
  copy. The plugin's own provider management, its shared callback and SAML single logout are off.
  Migration `0024_sso`. New checks: `scripts/sso-e2e.ts` (69, against a mock OIDC provider it
  runs itself), `scripts/scim-e2e.ts`, `src/lib/sso-config.test.ts`, `src/lib/scim.test.ts`,
  `src/server/sso.test.ts`. Not tried against real identity providers; SAML only in unit tests.
- **SCIM groups** (#38, on member groups #37): `/scim/v2/Groups` lists (filter `displayName`,
  `externalId` or `id` with `eq`, paging, `excludedAttributes=members`), gets, creates, replaces,
  patches and deletes the workspace's member groups, including ones made in the app. `PATCH`
  takes Okta's and Microsoft Entra ID's forms (`add`/`remove`/`replace` on `members`, `remove` on
  `members[value eq "…"]`, `displayName`, `externalId`, path-less objects, ops in any case); `PUT`
  keeps members it leaves out. Members must be the workspace's owners or members: guests, unknown
  or outside ids and nested groups are a 400 `invalidValue` and nothing of that request is
  applied; a taken name is a 409. Changes run through `server/groups.ts` (a new `changeGroup`
  that renames and adds and removes people in one transaction, which the settings' rename, add
  and remove now use too), so access, open editors and stranded pages are handled as in the app;
  the workspace's oldest owner acts for the token and receives pages only a removed member or
  deleted group could manage. `scim_group` keeps the provider's `externalId`, and Settings →
  Groups marks provisioned groups ("From your identity provider", with a note in the members
  dialog that the provider may undo edits; en/tr/de/es/fr). `/Schemas` now describes the User and
  Group attributes. Migration `0025_scim_groups` (renumber at merge if needed). Checks:
  `scripts/scim-e2e.ts` (118, including a live editor closing and cross-workspace isolation),
  `src/lib/scim.test.ts` (22). Not tried against real Okta or Entra ID.
- **Member groups** (#37): workspace owners create groups in Settings → Groups (rename, add and
  remove members, delete); everyone sees the list and who is in each group. A page can be shared
  with a group from the share panel like a person (`page_group_permission`, inherited by subpages
  and overridable, "no access" included), and a group can be added to a non-default teamspace,
  whose pages its members then reach as members (they can't leave or be removed one by one while
  in the group). `page_access_level` counts group entries and teamspace groups, and the highest
  level from the person, the page's teamspace and their groups wins; guests get nothing from
  groups. Only members and owners can be in a group: leaving the workspace removes people from
  their groups (a composite foreign key) and so does becoming a guest. Removing someone from a
  group, removing a group's entry or teamspace, or deleting the group closes their live editing
  sessions on pages they no longer reach, and hands pages nobody could manage any more to the
  person who made the change. Duplicating a page copies its group entries. The member list has a
  Groups column (also in the CSV export). MCP `list_groups` and REST
  `GET /workspaces/{id}/groups` list groups with their members and teamspaces. New checks:
  `scripts/groups-e2e.ts` (79), `src/lib/groups.test.ts`, `src/lib/search-fold.test.ts`.
- **AI foundation** (optional; off unless `AI_PROVIDER` and `AI_MODEL` are set): one server-side
  interface in `src/server/ai` for streaming chat with tool calls, embeddings (an OpenAI-compatible
  `/embeddings` call over `fetch`), per-person and per-workspace rate limits, a maximum input
  size, timeouts, cancellation and a usage log line per request (feature, model, tokens, cost; no
  content). Providers: Anthropic, OpenAI, Google, any OpenAI-compatible server, Ollama and LM
  Studio, through `@earendil-works/pi-ai` 0.87.1 (MIT) with only those APIs registered; tests use
  its faux provider. Owners can turn AI off per workspace (Settings → General → AI), which also
  shows the server's provider and model. See the README's AI section for the environment
  variables, limits and what is sent where.
- **AI writing assistant** (#40): *Ask AI* in the formatting toolbar and the slash menu (plus
  *Continue writing* and *Summarize page*): improve writing, fix spelling and grammar, make
  shorter, translate into a chosen language, or follow your own instruction. The answer streams
  into a panel (`POST /api/ai/write`, newline-delimited JSON) with *Replace selection*, *Insert
  below*, *Try again* and *Discard*; *Stop* and closing cancel the request. Applying saves a page
  history version first ("Before AI assistant edit") and edits through the shared document, so
  others see it live and Undo reverts it. Only people who can edit the page can use it; offline
  it is hidden.
- **AI autofill properties** (#42): a text property can be filled in by AI with a summary of the
  row's page, a translation (of the name, the page content or another property) or a custom
  prompt with `{Property}` placeholders and optionally the page content. Values are plain text
  (filters, sorts, CSV, REST and MCP work as before; `get_database` shows `ai_autofill`), worked
  out in the background with a concurrency limit and each workspace's rate limit, per row
  (*Update with AI* on a cell or the row page), for a view (*Update all rows in this view*), and
  optionally a few seconds after a row changes when its inputs did. Cells show pending and failed
  values with the reason. Migration `0023_ai_properties` adds the `ai_property_state` table
  (additive).
- **German, Spanish and French** (#51): the whole interface, emails and built-in templates in
  Deutsch, Español and Français, next to English and Turkish; the editor's menus use BlockNote's own
  dictionaries for them. The language picker lists each language by its own name. Adding a
  language is now a folder of JSON files (`src/i18n/messages/<locale>/`, found by name, no index
  file) plus a line in `src/i18n/config.ts` and one in `src/i18n/blocknote/index.ts`; a language
  that lacks a text shows the English one. Built-in templates moved to
  `messages/<locale>/templates.json`. `Accept-Language` matching now also takes regional codes
  (`pt-br`) when a language has them. `pnpm i18n:check` (also in `pnpm test` and a CI step)
  compares every language with English: missing or extra files and keys, empty texts, invalid
  ICU (parsed with @formatjs/icu-messageformat-parser 3.5.20, MIT, dev only), placeholders, tags
  and select branches that differ (plural vs. plain `{count}` is allowed).
  CSV import recognises German, Spanish and French title columns and yes/no words. The
  translation workflow is in `CONTRIBUTING.md`. The new translations were not reviewed by native
  speakers yet.
- **Import from Notion** (#46): Notion's *Markdown & CSV* export ZIP, including a split export
  (`Export-<id>.zip` holding `Export-<id>-Part-N.zip`, each possibly wrapped in its own
  `Export-…-Part-N/` folder), goes in through the existing Import dialog and `/api/import`, under
  the page or into the teamspace it was started from. On top of what the Markdown import already
  did for Notion (ids out of titles, `_all.csv` over the partial CSV, folders as subpages):
  callouts (`<aside>`) become callouts, `$`…`$` inline equations become equations (toggles as
  `<details>`, to-dos, tables and `$$` blocks were already read), a line linking to one of the
  page's own subpages becomes a link-to-page block, notion.so links to pages of the export point
  at the imported pages, a database's own `.md` next to its CSV is left out as a duplicate, and
  the `Name: value` property list at the top of each row page is taken off its body (lines linking
  to files stay, so the files are uploaded). Relation cells (`Title (../DB%20<id>/Title%20<id>.md)`,
  `Title (https://www.notion.so/…-<id>)`, or `[Title](…)` in the row page's list) make a one-way
  relation property to the database their links lead to, linked by link, else by a unique title;
  entries that find no row are counted in a warning, and columns whose links all lead outside the
  export stay text without the links. New import warnings: files no page shows or links to
  (`unused`) and ZIP entries whose path climbs out of the archive (`unsafePath`, previously
  dropped silently). The dialog says how to export from Notion (en/tr). New code in
  `src/lib/import/notion.ts`; checks in `src/lib/import/notion.test.ts`,
  `src/server/import/archive.test.ts`, `src/server/import/notion-blocks.test.ts` and
  `scripts/notion-import-e2e.ts` (33). The fixtures follow Notion's documented export format; no
  real Notion export was tried. No migration.
- **Offline editing** (#10): each page opened in the browser is kept in IndexedDB (its Yjs
  document, via y-indexeddb 9.0.12, MIT), loaded before the page connects. Without a connection the
  page stays editable, and the edits merge with the server's state when it returns (the sync
  handshake sends only what the server lacks, which also keeps the comment-thread guard happy).
  Pages edited offline and closed before reconnecting are sent in the background the next time
  the app is open. The page header shows Offline / "Offline · edits kept here" / Syncing… /
  Synced. The sidebar tree and the last 30 databases and rows opened are kept for reading offline
  (read-only, with a note saying from when); actions that need the server (share, comments,
  favorites, page menu, search, inbox, new pages, templates, import, trash, sign-out, the icon
  picker) are turned off offline with a tooltip saying so. Copies are stored per user and wiped
  on sign-out (with a warning when edits haven't synced), when another user signs in on the
  browser, and per page when the collab server refuses it: its refusals now carry a reason
  (`forbidden`, `two-step`, `unauthorized`) and only `forbidden` drops the copy. Collab tokens
  stay in memory only. New checks: `scripts/offline-e2e.ts` (17), `scripts/sw-e2e.ts` (12, headless
  Chrome), `src/lib/offline.test.ts`.
- **Installable app** (#44): web app manifest (`/manifest.webmanifest`, standalone, start URL
  `/`), icons (192, 512, maskable 512, SVG, favicon, Apple touch icon, from the "e" mark), light
  and dark theme colours, iOS home-screen meta tags, and a hand-written service worker
  (`public/sw.js`, production only; `pnpm dev` unregisters a leftover one). It caches the app's
  hashed scripts, the icons and an offline page, and keeps the HTML of the last 50 signed-in pages
  per user (read from `<meta name="leafdesk-user">`) for use only when the network fails; a
  different user's page drops the previous user's copies, a 404 drops that page, and API
  responses, uploads, server actions and the websocket are never touched. Offline, pages never
  opened go to `/offline`, which lists the pages kept on the device, and the start URL goes to the
  last page opened. The browser's install prompt is kept for an "Install app" item in the
  workspace menu instead of a banner. README: install and offline use, and a short Tauri /
  Electron / installed web app comparison for a desktop shell (not built). The Docker image now
  copies `public/`. No migration.
- **Phones:** the editor's formatting toolbar scrolls sideways within the screen instead of
  widening the page (which zoomed the whole page out), and the slash and link menus stay inside
  the screen.
- **Teamspaces** (#36): pages and people are grouped into teamspaces. Every workspace gets a
  *General* teamspace (default: everyone is in it and stays in it, new members included); all
  existing top-level pages move into it with their subpages, so nobody's access changes, except
  a guest's private pages, which stay private. Access types: **default**, **open** (visible to
  every member, who can join; until then they read and comment), **closed** (visible, but its
  pages open only to its members, whom its owners add; no join requests) and **private** (only its
  members see it, workspace owners included). Pages outside any teamspace are **private** to their
  creator unless shared. Owners and members only: guests are never in teamspaces and keep getting
  single pages. The rule lives in SQL (`page_access_level`), so the sidebar, search, @-mentions,
  exports, sharing, MCP, the REST API and live collaboration all follow it.
  - **Sidebar:** a *Teamspaces* heading with a section per teamspace you're in (new page, new
    database, from a template, import, edit, leave), *Shared* for pages shared with you from
    elsewhere and *Private* for your own. Dragging a page onto another teamspace or onto Private
    moves it there after a confirmation; the Move dialog lists teamspaces and Private too.
  - **Settings → Teamspaces:** active and archived teamspaces with search and owner/access
    filters, members and owners, a row menu (edit, members, join, leave, archive), the default
    teamspaces (always in effect, no "update" step) and "Only workspace owners can create
    teamspaces". The members table gets a Teamspaces column.
  - **Who may do what:** creating needs a member when the workspace allows it, else an owner;
    managing a teamspace needs one of its owners (or a workspace owner, except for a private one
    they aren't in); making a teamspace default, or not default any more, needs a workspace owner
    (everyone stays in a former default teamspace until they leave). Every teamspace keeps an
    owner: the last one can't leave, and someone leaving the workspace hands theirs to the
    teamspace's oldest member, else to the owner who removed them. Archiving hides a teamspace and
    stops new pages in it; its pages keep their access.
  - **Moving:** a page moved to another teamspace, or to Private, takes the access of its new place
    with all its subpages; its own "everyone" entry is dropped and people shared by name keep
    theirs. Restoring a page whose parent is still in the trash keeps the access it inherited.
  - **Where new pages go:** the teamspace you add them in; from Home, the first default teamspace;
    from MCP or the REST API without `teamspace_id`, Private. Duplicates stay in their teamspace;
    copies of published pages are private.
  - **MCP and REST:** `list_teamspaces` / `GET /workspaces/{id}/teamspaces`; `teamspace_id` on
    `create_page`, `create_database`, `move_page` and `list_pages` (and their REST endpoints);
    pages report their teamspace.
  - Migration `0021_teamspaces`. Top-level pages that older code creates without a teamspace and
    without an "everyone" entry are sent to the first default teamspace when their transaction
    ends, so they keep the access they had.

- **Export as PDF** (#47): "Export as PDF" in the page menu opens the page's print view
  (`/print/<page id>`) in a new tab and the browser's print dialog once its images, fonts and
  Mermaid diagrams have loaded ("Save as PDF"). The view draws the page like its published version
  (shared with it: `components/published/published-body.tsx`), always in the light theme, with
  print rules: `@page` margins, code blocks and tables wrapped to the page width, headings kept
  with what follows, figures, callouts and table rows not split, backgrounds kept. Links to other
  pages print as their titles ("No access" for pages hidden from the reader), PDFs and embedded
  sites as a card naming them, toggles open. "Include subpages" adds the pages under it in sidebar
  order (at most 100), each on a new sheet. Same access as opening the page (404 otherwise) and
  the workspace's two-step policy; the body is read from the live document, so recent edits are
  in. No new dependencies, no migration.
- **REST API with personal access tokens:** `/api/v1` offers workspaces, pages (read with the
  whole Markdown body, create, update title, icon and body, move, trash, restore, sub-pages),
  search, databases (schema, queries with filters, sorts, saved views and cursor pagination),
  rows (add, add up to 100 at once, update one or many, read) and comments (list, start a thread,
  reply). It shares its service layer with the MCP server (`src/server/operations.ts`), so both
  check input and access alike and save page history before every body change. Tokens are
  created in Settings → Connected apps: read only or read and write, optionally limited to one
  workspace, expiring after 7, 30, 90 or 365 days or never; the secret (`esi_` plus 40 letters
  and digits, easy for secret scanners to match) is shown once and stored as a SHA-256 hash; the
  list shows when each token was last used, and revoking takes effect at once. Pages the user
  can't see, or outside a token's workspace, answer 404; errors are JSON with a code; each token
  may make 180 requests a minute (`API_RATE_LIMIT`), bodies are limited to 5 MB, only tokens
  authenticate (never the session cookie) and CORS stays off unless `API_CORS_ORIGINS` is set.
  Like MCP's OAuth tokens, API tokens are outside the workspace two-step verification policy.
  An OpenAPI 3.1 document is served at `/api/v1/openapi.json` and rendered at `/docs/api`.
  Claiming an account through an email-verified sign-in also revokes its tokens (migration
  `0020_api_tokens`).
- **My account** (#54): a page of its own at `/account`, opened from "My account" (or the name
  and picture) in the workspace menu, with Profile, Security, Preferences and Connected apps tabs.
  Language, notifications, two-step verification, passkeys and connected apps moved here from the
  workspace settings; the old settings addresses redirect. New:
  - Name and an uploaded picture (PNG, JPEG, WebP or GIF up to 2 MB, cropped to 256×256 in the
    browser, checked by content, served only to signed-in people from `/api/avatars/…`). Pictures
    now show in the sidebar, member lists, the share dialog, presence, person properties,
    mentions and comments.
  - Changing the password (optionally signing out every other device) or, for GitHub/Google-only
    accounts, setting one; a notice goes by email.
  - Changing the email address through a 24-hour link sent to the new address, confirmed on a page
    that signs nobody in; the old address is told. Off, with an explanation, without SMTP in
    production.
  - Signed-in devices with browser, system, IP and last activity; sign out one or all others
    (which also closes their live collaboration connections).
  - Deleting the account after typing its email. Refused while the person is the only owner of a
    workspace others are in; otherwise workspaces nobody else is in are deleted with their files,
    the others are left the way leaving works (an owner takes over pages only this person could
    manage), and sessions, passkeys, connected apps and the picture go with it.
  - Email, password and deletion ask for the password again, or a two-step or recovery code for
    accounts without one, or else a sign-in from the last 10 minutes; all of it is rate-limited.
  No migration: email-change links use the existing `verification` table and pictures the upload
  storage.

- **Workspace site and Duplicate for published pages:** owners set up a site in Settings → Site: a
  slug (lowercase letters, digits and hyphens, 3–40 characters, unique, a few reserved), a title
  and a home page picked among published pages. `/s/<slug>` opens the home page with a navigation
  (sidebar, a menu on phones) of the publications listed in the site, each with its subpages;
  pages live at `/s/<slug>/<title>-<id>` (old titles redirect), and mentions of other listed pages
  link within the site. A publication is listed only when its publisher (Publish tab) or an owner
  (Settings → Site) turns it on, so link-only pages never show up; the home page is listed when it
  is picked, and the site falls back to its first listed page while the home page is offline.
  Existing `/s/<token>` links keep working, and each page keeps its publication's search-engine
  setting. New per-publication option **Allow duplicate** (off by default): a Duplicate button on
  the published page lets a signed-in visitor (others sign in first and come back) copy the page
  and its published subpages to the top of one of their workspaces, optionally as a template. Only
  what the publication shows is copied (pages the publisher can see, public properties, web
  views); bodies are rebuilt without comments, history, reminders or people's ids, pages that
  weren't copied read as the published page showed them, and uploaded files are copied into the
  new workspace within its quota. Five duplicates a minute and thirty an hour per person
  (migration `0018_site_and_duplicate`).
- **Export with subpages and whole-workspace export:** "Export with subpages" in the page menu
  ("Export with row pages" for databases) downloads a ZIP of the page and everything under it, and
  owners can download the whole workspace from Settings → General → Export. Pages are Markdown,
  databases CSV with their row pages in a folder beside them (each row page lists its
  properties), and uploaded files the pages and rows show are copied into `files/`. The layout
  mirrors the sidebar, with names made safe and unique per folder; links between exported pages
  and to their files become relative paths, links to anything left out point at the app. Only
  pages the person can view go in (hidden ones are left out and links to them say "No access");
  the trash is left out; templates are kept in `Templates/` folders. The archive is streamed as it
  is built (fflate), one export at a time per person, and exports over `EXPORT_MAX_PAGES` (10,000)
  pages or `EXPORT_MAX_FILES_MB` (2,048) of files are refused up front with a message. No
  migration.
- **Import Markdown and CSV** (#45): "Import" in the sidebar (and in the "+" menu) opens a dialog
  that sends files to the new `POST /api/import` route.
  - Markdown files, a picked folder or ZIP files become pages under a chosen page or at the top
    level, keeping the folders as the page tree: a folder next to `Name.md` holds that page's
    subpages, other folders become pages whose body is their `index.md`/`README.md`. Titles come
    from front matter or a first `# Heading`, else the file name (Notion's ids left out). Links
    between the imported files become page links (mentions); images and files a page shows by
    relative path are uploaded to it and the links pointed at the uploads; images inside a line of
    text get lines of their own. CSV files in the upload become databases, and pages in their
    folder become the bodies of the rows with the same title (or new rows). Notion's layout is
    understood (`Export-…` folder, split exports with ZIPs inside, `_all.csv`), and so is Leafdesk's
    own export: its `Templates/` folders become the database's row templates and, when importing
    at the top level, workspace templates again (under a page they're pages of a "Templates"
    page), and the property list at the top of a row's page is left out of the row's body when it
    says what the CSV does. Exporting such an import gives the same archive back
    (`scripts/roundtrip-e2e.ts`).
  - A CSV file becomes a new database, each column typed as guessed from its values (number,
    checkbox, date in ISO, day-first or month-first form, URL, email, select or multi-select for
    few repeating values, else text) and changeable in the dialog, or its rows are added to an
    existing database with a column → property mapping (options a select, multi-select or status
    column names are added; people and related rows are found by name or email). Comma, semicolon
    and tab separators, UTF-8 or Windows-1254 text, and Leafdesk's own CSV export read back.
  - All or nothing: limits (100 MB upload, 300 MB unpacked, 2,000 files, 500 pages, 5,000 rows,
    100 columns) are checked first, and a failure midway deletes what the import made. What it
    left out is reported in the dialog: cells that didn't fit their property (left empty),
    missing or too large images, skipped files. Needs edit access to the destination page or
    database (top-level imports follow the usual rules for guests).
- **Two-step verification and passkeys** (Settings → Account security): an authenticator app
  (TOTP, QR code or typed key) with ten one-time recovery codes shown once to copy or download,
  new codes on demand, and "don't ask again on this device" for 30 days. Signing in with a
  password or with GitHub/Google then asks for a code or a recovery code; signing in to connect
  an MCP app continues to its consent page after the code, either way. Turning it off asks for
  the password, or a code on accounts without one. Passkeys can be added, renamed and removed,
  and "Sign in with a passkey" is on the sign-in page. Built on Better Auth's `twoFactor` plugin
  and `@better-auth/passkey`; migration `0018_two_factor_passkeys` adds the `two_factor` and
  `passkey` tables, `user.two_factor_enabled` and `session.auth_method` (how a session signed
  in). `pnpm auth:reset-2fa <email>` resets an account that lost both its app and its codes.
- **Require two-step verification** (workspace Settings → Security, owners): people whose session
  has neither the authenticator app nor a passkey sign-in are sent to a page where they set one
  up before they can open the workspace. The access checks enforce it for server actions and API
  routes too, and the live collaboration connection checks it when it connects (turning the
  policy on closes the ones that don't pass). An owner can turn it on only from a session that
  passes, and the settings show how many people haven't set anything up yet. Apps connected over
  MCP are not affected.

- **Files & media property:** a database property that holds uploaded files. Images show as small
  thumbnails in tables, boards, lists, galleries and row pages, other files by name; the cell
  editor uploads (pick or drop, several at once) and removes them. Galleries can take their cover
  from the first image of a files property. Files in a value open for anyone who can see a row
  holding them, and for visitors of a published database: the `file_reference` trigger now also
  tracks `/api/files/<id>` URLs in row property values (migration
  `0016_files_property_references`). A value can only hold files of the same workspace that the
  person setting it can open. Removing a file from a value never deletes it; it stays with the row
  it was uploaded to and follows the usual cleanup. Filters: is empty / is not empty; sorting by
  the number of files; formulas read the file names as a list, rollups count them. CSV export
  writes one "name (URL)" line per file. Forms can ask for files, on public links too: uploads wait
  with the database (rate limited per address and per form on public links) until the answer
  arrives, and the new row takes them over. MCP returns values as `[{name, url}]`, sets them from
  URLs of files already uploaded to the workspace (no outside URLs), `attach_file` takes
  `property` to add an upload to a row's files property, and gallery views take a files property
  as `cover`.
- **PDF preview:** a file block holding an uploaded PDF shows it in place with the browser's PDF
  viewer (and a link to open it), in the editor and on published pages. It loads
  `/api/files/<id>?view=pdf`, which serves only files stored as PDF; PDFs are framable by the app
  itself only (`frame-ancestors 'self'`). Markdown export keeps the block as a link.
- **Web bookmarks and embeds:** "Web bookmark" and "Embed" in the slash menu, and pasting a lone
  link into an empty line offers Bookmark, Embed (for supported sites) or Keep as link. A bookmark
  is a card with the page's title, description, icon and preview image; the server fetches them
  once (Open Graph and meta tags) and stores them in the block, and "Refresh preview" fetches them
  again. The fetch needs edit access to the page, is rate limited per user and guarded against
  server-side request forgery: http(s) on web ports only, every resolved address must be public
  (no private, loopback, link-local, CGNAT, multicast or IPv6 ULA/link-local), each of at most
  three redirects is checked again, 5 s and 1 MB at most, head only. Preview images are hotlinked
  with `referrerPolicy="no-referrer"` rather than proxied. Embeds show YouTube (via
  youtube-nocookie), Vimeo, Loom, Figma, published Google Docs/Sheets/Slides, CodePen, Spotify and
  Google Maps in a sandboxed, lazy iframe whose address is always rebuilt from the pasted URL;
  other links become bookmarks. Both show on published pages. In Markdown (export, MCP) a bookmark
  is a `[Title](url)` line, which a rewrite of the page turns back into that bookmark (other link
  lines stay links; `<!-- leafdesk:bookmark -->` after a link makes a new one), and an embed is
  `[url](url) <!-- leafdesk:embed -->`. Uploaded PDFs show in place (see PDF preview).
- **File uploads:** image, video, audio and file blocks now take files: drop, paste or pick one
  and it is uploaded instead of asking for a URL. Files are stored on a local volume by default or
  in S3-compatible storage (AWS S3, Cloudflare R2, MinIO) with `S3_BUCKET` and its credentials.
  `UPLOAD_MAX_FILE_MB` (default 50) and `UPLOAD_WORKSPACE_QUOTA_MB` (default 10240) limit a file
  and a workspace, checked while the upload arrives. A file opens for people who can see a page
  showing it, so duplicates and pages made from templates share it, and for visitors of published
  pages. Only raster images, video, audio and PDF open in the browser; SVG and everything else
  download. Deleting a page for good removes files no other page shows, and uploads nothing used
  are removed after a day. Docker Compose keeps files in a new `uploads` volume.
- **MCP:** `attach_file` uploads a file to a page from a URL or base64 data and adds it to the
  body. It needs the new `files:write` scope; apps registered earlier may request it too. URLs
  that resolve to private, loopback or link-local addresses, or redirect to them, are refused.
- **Mentions and page links:** type `@` in a page to mention a person, a page or a date. A page
  mention shows the page's current icon and title and follows renames; a page you can't open shows
  as "No access" without its title, and one that was deleted as "Deleted page". "Link to page" in
  the slash menu adds a page link on a line of its own. Mentioned people get an inbox notification
  (and an email a minute later) once per mention, only if they can open the page, and not again when
  the page is saved; taking the mention out before they read it takes the notification back. Click
  a date to set a reminder (on the day, a day or a week before, at 9:00): it reaches the inbox and
  email of whoever set it. Pages list the pages linking to them under "Linked from", as far as the
  reader can see them. Mentions and reminders have their own notification preferences. The server
  finds new mentions, links and reminders when it saves a page, whoever made the change.
- **Mentions in Markdown and MCP:** a page mention is a link to the page
  (`[Title](/w/<workspace>/p/<page>)`, any link to a page of the app becomes one), a Link to page
  block is that link alone on its line followed by `<!-- leafdesk:page-link -->`, a person is
  `@Name` and a date `@2026-10-01`. Exports and MCP's `get_page` show each linked page's current
  title, or "No access"; writing the Markdown back keeps mentions (nobody is notified twice) and
  reminders. `get_page` lists the pages linking to a page under `linked_from`, and
  `list_notifications` includes mentions and reminders. Published pages link mentions of pages that
  are published too and show others as plain text.
- **Presence:** the page header shows who else has the page open, as avatars in their cursor
  colors with "+N" for more than four; click them for everyone's names. People who can only view
  the page count too, each person shows once however many tabs they have open, and you don't see
  yourself. The collab server names each viewer after the account they signed in with.
- **Find and replace in a page:** Cmd/Ctrl+F inside a page opens a find bar over the editor. It
  highlights every match, shows "3/12", steps with Enter and Shift+Enter, and can match case. People
  who can edit also replace the current match or all of them in one undo step, synced to everyone
  on the page. Matches stay within a block, and the selected text fills the search box.
- **Templates:** save a page or database, with its subpages, as a workspace template from the page
  menu, and create new pages from it via "From a template" in the sidebar or on the home page. The
  copy leaves out the template's comments and gets the access of where it's created. Using a
  template needs view access to it and edit access where the new page goes. A built-in gallery
  (meeting notes, weekly plan, project tracker) creates its pages only when you pick one. Templates
  are kept out of the sidebar, search, trash, favorites and published sites, and deleting one
  removes it for good.
- **Database row templates:** the arrow next to "New" lists a database's row templates with preset
  properties and content, adds a row from one, and sets which one "New" uses by default. MCP
  `create_database_row` uses that default too when no values are given.
- **MCP:** `list_templates` lists workspace, built-in and row templates, and `create_page` and
  `create_database_row` take a `template_id`.
- **Editor blocks:** callouts with an icon and a background color, equations in LaTeX (a block of
  their own or inline in text, rendered with KaTeX), Mermaid diagrams with a live preview, a table of
  contents that follows the page's headings and scrolls to them, and a breadcrumb of the pages above.
  All are in the slash menu and show on published pages. In Markdown (export, MCP) a callout is a
  GitHub alert (`> [!NOTE]`), equations are `$…$` and `$$…$$`, a diagram is a ```` ```mermaid ````
  fence, and the table of contents and breadcrumb are `<!-- leafdesk:toc -->` and
  `<!-- leafdesk:breadcrumb -->` lines; all of them are read back into blocks.
- **Columns** (#16): "2 columns" and "3 columns" in the slash menu place blocks side by side;
  inside a column the menu offers "Add column" instead (up to five). Blocks move into, out of and
  between columns with the side menu's drag handle; a column whose last block is dragged away or
  deleted goes, and a column list left with one column turns back into plain blocks.
  Columns are equal by default and resized by dragging the line between them (stored as each
  column's share, so it syncs, undoes and keeps its proportion at any width). On screens narrower
  than 640px they stack, in the editor and on published pages, where tables of contents, diagrams,
  embeds and databases inside columns show in place. In Markdown (export, MCP) columns are marker
  lines around their blocks (`<!-- leafdesk:columns -->`, `<!-- leafdesk:column -->` before each
  column, optionally `width=2`, and `<!-- leafdesk:/columns -->`), so plain Markdown readers see
  the blocks in order and writing a body back keeps its columns. Built on BlockNote's own column
  support in its core; its multi-column package (GPL-3.0 or commercial) is not used. No migration.
- **"Can comment" access:** share a page so people can read and comment on it without editing it.
  Their comments mark the selected text on the server, so the page itself stays read-only for them.
- **Comments on pages:** select text and choose Comment to start a thread; reply, react with emoji,
  edit or delete your own comments, and resolve or reopen threads. Threads update live for everyone
  on the page and are listed in a Comments panel from the page header. People who can edit a page
  comment on it, people who can view it read the comments, and full access also deletes other
  people's comments and threads. Replies notify everyone in the thread (a new thread notifies the
  page's author) in the inbox and, a couple of minutes later, by email; Settings > Preferences turns
  either off.
- **MCP:** `list_comments` reads a page's comment threads and `add_comment` starts a thread on quoted
  text or replies to one.
- **Social login:** sign in with GitHub or Google, each turned on by setting its
  `*_CLIENT_ID` and `*_CLIENT_SECRET`. A provider account opens the existing account with the same
  verified email, and closed sign-up admits only existing or invited people (see README). If that
  account's email was unverified, its password, other sessions and connected apps are removed, so
  someone who registered another person's email can't keep access.
- **Inbox:** pages shared with you now show in the inbox next to assignments, and you get an email
  about them a little later. A share undone right away sends nothing.
- **Notification preferences:** Settings > Preferences chooses, for assignments and shared pages
  separately, whether they show in the inbox and whether they come by email.
- **MCP:** `list_notifications` lists the user's inbox. It needs the new `notifications:read`
  permission. Apps connected earlier can ask for it too; the user approves it once on the consent
  screen.
- **Database filters** can be combined with "or" and grouped two levels deep. Date filters can be
  relative: today, this week, this month, or the past or next N days. MCP `query_database` and the
  view tools accept the new shape, and flat filter lists keep working.
- **Column calculations** in table views: count, sum, average, median, min, max, range, earliest,
  latest, percent checked and more. They are calculated over the filtered rows and saved with the
  view.
- **Bulk row actions:** select rows in a table (shift-click for a range, or select all) to set a
  property, duplicate, export as CSV or move them to the trash at once. Rows you can't change are
  skipped and reported. MCP `update_database_rows` sets the same values on up to 100 rows.
- **New property types:** Status (options grouped as to do, in progress and done), Checklist
  (sub-items with progress), Email and Phone (click to write or call).
- **System properties:** when a row was created, when it was last edited, and who edited it last.
  They are read-only and can be filtered (including relative dates) and sorted. They are included
  in CSV export and MCP. Editing a row's body counts as an edit.
- **Formula properties:** compute a value per row from other properties with arithmetic, text,
  date and logic functions. The editor shows mistakes as you type, and results filter, sort,
  export and show over MCP like values of their type.
- **Rollup properties:** count, sum, average, min or max, percent checked, or list the values of
  related rows (only the rows you can see), shown as a number, bar or ring.
- **More grouping:** boards and tables group by multi-select, checkbox, date (day, week, month or
  year), created or edited time and relation, and statuses by their to do / in progress / done
  group. Tables show groups as collapsible sections with counts, their own calculations and a
  New row that fills in the group's value.
- **Gallery view:** cards with the first image of each row's page as cover, in three sizes.
- **List view:** one compact line per row, with the properties you choose on the right.
- **Timeline view:** bars from a start date to an optional end date, day, week or month zoom,
  drag to move or resize, swimlanes by any groupable property, and a "No date" section you can
  drag rows from. MCP `create_database_view` and `update_database_view` handle the new views.
- **Chart view:** vertical or horizontal bars, a line or a donut over a grouping property, counting
  rows or using any column calculation (sum, average, median…). Counts and sums can be stacked by
  a second property that holds one value per row (select, status, checkbox, date, created or
  edited time and by), so every row is counted once. A donut's center shows the number of rows,
  even when a row sits in several slices. Hover a bar for its value, click it to list its rows.
- **Form view:** ask for chosen properties in order, with labels, help text, required answers,
  default values and a thank-you message. Each answer adds a row. A form can get a public link
  (`/f/…`) for signed-in or anonymous answers, guarded by rate limits and a hidden field that
  password managers leave alone. A link stops taking answers when whoever opened it can no longer
  add rows; the form and Settings say so, and anyone who can edit it can take it over. Owners see
  and close every public form under Settings > Security. MCP can create and change forms and
  their links. Behind reverse proxies, set `TRUSTED_PROXIES` (default 1) so limits count real
  visitor addresses.
- **Inline databases and linked views:** the slash menu adds a database inside a page, or a view
  of an existing database whose layout, filters and sorts are kept in the page. What a block shows
  follows the reader's access to the database. Published pages show them as tables.
- **Changes in page history:** compare a version with the current page or with the version before
  it. Changed blocks are shown with added words in green and removed words struck through in red;
  unchanged stretches are folded. Each comparison names who made the changes, and changes an AI
  app made through MCP name the app. MCP `diff_page_version` returns the same comparison as text.

- **Publishing options:** pick which views of a database published pages show; visitors switch
  between them, and boards, lists and galleries look like they do in the app (calendars,
  timelines and charts show as tables). Boards by people or linked rows show as tables, and only
  the values a view shows reach the visitor. A publication can let search engines index the page
  and its subpages; it is off by default, and Settings > Security shows which ones allow it.
- **Trash and history retention** (#55): owners choose in Settings > Security > Data retention
  how long pages stay in the trash (7 to 365 days, or never; 30 by default, stored in
  `workspace.settings.trashRetentionDays`, no migration). The trash shows how many days each page
  has left, MCP `list_trash` returns `deletes_at`. Once a day the server deletes the pages whose
  time is up the way *Delete permanently* does (subpages and files included) and prunes page
  history: versions older than 90 days or past the newest 200 of a page go, saved versions and
  versions from before a restore stay a year, and the newest version of a page always stays. With
  several replicas a Postgres advisory lock lets one run at a time; each run logs what it removed.
  The cleanup runs on production servers; `RETENTION_JOB=on|off` overrides that (a dev server
  leaves the data alone unless it is `on`).
  New checks: `scripts/retention-e2e.ts` (35), `src/lib/retention.test.ts`.
- **People directory and analytics** (#62): *People* in the sidebar (`/w/[id]/people`) shows the
  workspace's owners and members as cards with their role, email, teamspaces, groups and up to
  three pages they edited in the last 90 days, searchable by any of those. Each card shows only
  what the viewer may see: private teamspaces they aren't in stay off it, like in the members
  list, and so do pages they can't open. Guests aren't listed and get a 404. Owners get
  Settings > Analytics: active members, edits per person and the 20 most edited pages over the
  last 7, 30 or 90 days, each table downloadable as CSV. Edits are counted from what is already
  stored, page history versions (at most one per page every 10 minutes of typing, not versions
  saved by hand) and each page's latest change for what history doesn't keep, such as row values;
  nothing new is recorded and no migration is needed. Pages the owner can't open are counted as
  *Private page*, without their title. New checks: `scripts/people-e2e.ts` (32),
  `src/lib/analytics.test.ts`, `src/lib/people.test.ts`.
- **Request access to a page** (#57): a signed-in person who opens a link to a page they can't
  see gets a "You don't have access" screen instead of a 404, with *Request access* and an
  optional message (500 characters). The screen shows nothing of the page or its workspace, and a
  page that doesn't exist gets the same screen and the same answer; a request is stored only for
  a page that exists, isn't in the trash and has requests on. People outside the workspace see it
  without the sidebar and can ask too. Everyone with full access to the page gets an inbox
  notification (new kind `access_request`, with its own inbox and email preferences) and an email,
  and answers from the inbox or from *Requests* at the top of the Share panel (the Share button
  shows how many wait): share at a level (view, comment, edit, full), which brings someone from
  outside in as a guest when the guest invite policy lets the approver, or decline. Answering, or
  sharing the page with the requester some other way, removes the request and every notification
  about it; the requester gets an email either way, in their language, and a declined one names
  neither the page nor who declined. One pending request per person and page; each person may ask
  10 times an hour, every ask counting whatever the page. Owners turn requests off in Settings >
  Security > Sharing (`workspace.settings.accessRequests`, on by default); the screen then has no
  button. Migration `0028_access_requests`. New checks: `scripts/access-requests-e2e.ts` (84),
  `src/lib/access-requests.test.ts`, access request emails in `src/server/mail/mail.test.ts`.

### Changed

- **New logo and colors.** The block-leaf mark and the leafdesk wordmark replace the letter badge
  on the sign-in, consent, offline and workspace security pages, in light and dark versions; the
  favicon, app icons (including the maskable one) and the README use them too. The accent color
  is now green (`#2f7d4f`, `#6cc38a` in dark mode), in emails as well. The source SVGs are in
  `brand/`.
- **Renamed the project to Leafdesk.** The repository is now `esmworks/leafdesk` and the image
  `ghcr.io/esmworks/leafdesk`. Stored names changed too, with no fallback for the old ones: the
  compose image tag variable is now `LEAFDESK_VERSION`; the bundled database user, password and name
  default to `leafdesk`; markdown markers are `<!-- leafdesk:… -->`; SSO domains are verified
  with a `_leafdesk-sso.<domain>` TXT record; offline edits, service worker caches and browser
  settings use `leafdesk` keys. An existing installation needs a new database (or
  `EXTERNAL_DATABASE_URL` pointing at the old one) and its SSO domains verified again.
- ESLint 9 with Next.js's rules (`eslint-config-next`): `pnpm lint`, also a CI step, fails on
  warnings too. The React Compiler checks are off (the app doesn't use it), and so are the rules
  for `<img>` (images come from any origin) and for full page loads after signing in or out (on
  purpose).
- Better Auth's `/update-user` endpoint now only accepts a name or removing the picture, so a
  picture can't point at an arbitrary URL. A password change that signs out other devices keeps the
  current session's sign-in method (a passkey session keeps satisfying a workspace's two-step
  policy).
- **Published databases** show the columns their first view shows. A board no longer publishes
  the text and number properties it hides on its cards.
- **New databases** start with a Status property of the status type (to do, in progress, done)
  instead of a select.
- **Teamspaces, laid out like Notion's.** Settings > Teamspaces starts with the default teamspaces
  (picked in one field, applied with *Update* after a confirmation) and who may create teamspaces,
  then lists the teamspaces with status, owner and access menus, a search button, "N members ·
  Joined" under each name, the owners' pictures, an access menu in each row (changes to and from
  *Default* ask first) and sorting by last update. In the sidebar a teamspace stays closed until
  opened (the open ones are remembered per browser), opening a page unfolds the way to it and
  scrolls it into view, the Teamspaces section ends with *Add new* (or *Browse teamspaces* for
  those who can't create one), and Private and Shared show their first ten pages with a row for
  the rest.

### Fixed

- Searching in the share panel, the groups, members and teamspace lists, the @-mention menu, the
  person, relation and select pickers and the move and link-to-page dialogs no longer misses
  names with "I" in a Turkish-locale browser (typed "I" could fold to "ı" while the names folded
  to "i").
- Empty lines on published pages no longer show as a box.
- Typing right after pressing New in a database keeps the first letters, including accented
  letters, other keyboards and pasted text, and Enter no longer adds a second empty row.
- A formula dividing by an empty property is empty instead of a "division by zero" error.

## 0.2.0 — 2026-09-27

### Upgrading from 0.1.0

- **Docker Compose:** the bundled PostgreSQL now starts only when `COMPOSE_PROFILES=bundled-db`
  is set in `.env`. Add that line before `docker compose up -d`, or the database container won't
  start. Your data stays in the same volume.
- **Database port:** `docker-compose.yml` no longer publishes PostgreSQL on the host. In a clone of
  the repository, `docker-compose.override.yml` still publishes it on `127.0.0.1` for `pnpm dev`.
- **Migrations** (0001–0008) run automatically when the container starts. Existing pages,
  databases, members and connected AI apps keep working, and every member keeps full access to
  existing pages.
- **Docker image:** releases are published to `ghcr.io/esmworks/leafdesk`. `docker-compose.yml`
  runs that image. Set `LEAFDESK_VERSION` to pin a version.

### Added

- **Email (SMTP)** for invitations, password reset and assignment notifications. Configure it
  with `SMTP_URL` or `SMTP_HOST`/`SMTP_PORT`/…, plus `MAIL_FROM`.
- **Invitations:** invite people who don't have an account yet by email. Invitations expire after
  7 days and can be revoked. The Members page adds bulk invites, a workspace join link and a CSV
  export.
- **Password reset** by email.
- **`DISABLE_SIGNUP`** closes public sign-up. Invited people can still sign up through their link.
- **Page sharing:** share a page with members or by email, restrict it, and let subpages inherit
  its access.
- **Guest role:** guests see only the pages shared with them. Owners decide whether members may
  invite guests and whether guests may create private pages.
- **Publish to the web:** a read-only public link for a page and its subpages. It is hidden from
  search engines and can be revoked. Owners decide whether members may publish, and Settings →
  Security lists every published page so owners can take any of them offline.
- **Databases:** relation and person properties, a "created by" property, calendar views, a
  viewer-dependent "Me" filter, sorting and board grouping by person. On boards you can reorder
  columns, add groups and hide long card fields.
- **Assignments:** people assigned to a row get an email and an in-app inbox notification.
- **MCP tools** for moving pages, views, property edits, trash, history and adding many rows at
  once (`create_database_rows`).
- **English and Turkish** interface.

### Changed

- When someone leaves a workspace, pages only they could manage are handed to an owner.
- Sessions are checked against the database on every request, so signing out or removing a member
  takes effect immediately. Removing a member also closes their open editors.
- Reworked sidebar, settings and wide database layouts.

### Fixed

- Restricted pages no longer show up in any read path: lists, search, MCP tools, rows, moves,
  publications and live collaboration.
- Concurrent edits to a page title merge instead of dropping keystrokes. Titles of pages created
  in 0.1.0 are converted on their first edit.
- Controls that did nothing are now wired up or hidden.
- Settings → Members no longer scrolls the whole page sideways on narrower screens.

## 0.1.0 — 2026-09-26

First release: workspaces, nested pages with a collaborative editor, databases with table and
board views, search, page history, and an MCP server with OAuth for AI apps.
