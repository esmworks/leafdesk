<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/leafdesk-logo-dark.svg">
    <img src="brand/leafdesk-logo.svg" alt="Leafdesk" height="44">
  </picture>
</h1>

An open-source, self-hostable workspace of pages and databases with realtime collaboration and a
built-in MCP server, so AI assistants such as Claude can search, read and edit your workspace
after you approve them over OAuth.

**Website:** [esmworks.github.io/leafdesk](https://esmworks.github.io/leafdesk/)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/screenshots/board-dark.png">
  <img src=".github/screenshots/board-light.png" alt="A Leafdesk database shown as a board, with the workspace's pages in the sidebar">
</picture>

- **Pages and databases**: a block editor with slash commands, and databases whose rows are pages,
  shown as table, board, calendar, gallery, list, timeline, chart or form, with relations,
  formulas and rollups.
- **Realtime and offline**: edit together with live cursors, keep working without a connection.
- **Built for AI assistants**: connect Claude or any other MCP client over OAuth 2.1 and approve
  what it may read or change; optional AI writing, AI properties and chat with Anthropic, OpenAI,
  Google or a local model.
- **Bring your pages**: import a Notion *Markdown & CSV* export, an Obsidian vault, Markdown files,
  a folder or CSV.
- **Ready for a team**: teamspaces, page permissions, guests, single sign-on (OIDC, SAML), SCIM,
  two-step verification, passkeys and an audit log.
- **Yours to run**: one `docker compose up` on your own server, data in your PostgreSQL,
  Apache-2.0 licensed, in English, Turkish, German, Spanish and French.

Claude planning a launch in Leafdesk over MCP: a database, its tasks, a board view and a kickoff
page, all showing up live (sped up):

https://github.com/user-attachments/assets/3540e7dd-1939-414b-a828-4729b12c20e4

Try it in a minute:

```bash
mkdir leafdesk && cd leafdesk
curl -fsSLO https://raw.githubusercontent.com/esmworks/leafdesk/main/docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/esmworks/leafdesk/main/.env.example -o .env
# set BETTER_AUTH_SECRET in .env to the output of: openssl rand -base64 32
docker compose up -d
```

Then open http://localhost:3000 and create an account. See [Quick start](#quick-start-docker) for
versions, upgrades and running behind a domain.

## Features

- **Pages**: nested pages, a block editor (BlockNote) with slash menu and markdown shortcuts,
  icons, backgrounds (a color that suits the light and dark theme, or black, with an optional faint
  pattern), favorites, duplicate, move, trash with restore (emptied after a time owners choose), export as Markdown or PDF (or, with
  subpages, as a ZIP; owners can export the whole workspace, see [Export](#export)), and search
  over titles and content: full-text, and also by meaning when the server has an embeddings model
  (see [Semantic search](#semantic-search)).
- **Home page**: quick buttons for a new page, database or template; the database rows assigned
  to you that aren't done and that you can open, grouped as overdue, today, the next 7 days, later
  and no date; and the pages edited last.
- **Search box** (Cmd/Ctrl+K): before you type, the pages last edited. Narrow a search with
  `in:Projects` or `in:"Launch plan"` (that page and everything under it; several pages of that
  title, or several `in:`, search under any of them; a title nobody can see finds nothing) and
  `type:page`, `type:database` or `type:row` (database rows); filters work without words too,
  listing the pages they match, last edited first. Type `>` for commands: new page or database,
  from a template, import, trash, inbox, settings and keyboard shortcuts. The line under the
  results puts each of these into the box.
- **Page style**: at the top of a page's `⋯` menu, a typeface for the page (default, serif or
  mono), small text, and full width. It is set per page and everyone sees it, changing live for
  whoever has the page open; anyone who can edit the page can change it. Copies and templates keep
  it, published pages show it, and the print view uses the typeface and text size (paper has no
  full width). Small text applies on screens with a mouse or trackpad: on touch screens the body
  stays at 16px, so the phone doesn't zoom in when you start typing. Restoring an older version
  keeps the current style. Databases always use the full width. With the comments panel open, a
  page moves left of it (and narrows when the window is too small) instead of running under it.
- **Rich blocks**: callouts, LaTeX equations (block and inline, KaTeX), Mermaid diagrams with a
  live preview, a table of contents and a breadcrumb, and columns (2 to 5, resizable, blocks
  dragged in and out with the side menu, stacked on phones), also on published pages and in
  Markdown.
- **Web bookmarks and embeds**: link cards with the page's title, description and image (fetched
  once on the server behind an SSRF guard), and YouTube, Vimeo, Loom, Figma, Google Docs, CodePen,
  Spotify and Google Maps embeds in sandboxed iframes.
- **Realtime collaboration**: several people can edit the same page at once (Yjs over WebSocket
  via Hocuspocus), with live cursors. The page header shows who else has the page open, including
  people who can only view it.
- **Offline editing**: pages you opened before stay readable and editable without a connection;
  the edits sync when it is back, merged with what others wrote meanwhile. The sidebar and
  recently opened databases stay readable. The page header shows offline, syncing and synced (see
  [Install and offline use](#install-and-offline-use)).
- **Installable app**: install Leafdesk from the browser on desktop (Chrome, Edge) or add it to
  the home screen on phones; it opens in its own window. The app's icon offers a quick note, and on
  phones that support it Leafdesk shows up in the share sheet: text and links shared to it open the
  quick note filled in, saved as a private page in the workspace you pick.
- **Find and replace** in a page (Cmd/Ctrl+F): highlights every match, steps through them, and
  replaces one or all in a single undo step. Anyone who can open the page can search it.
- **Databases**: every row is also a page.
  - Properties: text, number, select, multi-select, status, date, checkbox, checklist, URL,
    email, phone, files & media (uploads with image thumbnails), person, one- or two-way relations to other databases, formulas, rollups over
    relations, and the read-only "created by", "created time", "last edited time" and
    "last edited by".
  - Views: table, board, calendar, gallery, list, timeline and chart, each with its own filters,
    sorting and grouping. Filters combine with "and"/"or" in groups and take relative dates such as
    "this week". A "Me" filter shows each viewer their own rows.
  - Table views calculate column totals, averages, counts and more over the filtered rows.
  - Quick add: a new row's name can carry its date, people and options, as in
    "Send the offer friday @Ayşe #urgent". Dates are read in the interface language and in English
    (today, tomorrow, next tuesday, in 3 days, 12/31, 31.12.2026...) and go to the view's date
    property, or the first one; `@name` fills the first person property and `#option` any select,
    multi-select or status option (a dash stands for a space). What's recognised shows under the
    name while you type, and each part can be kept in the name instead.
  - Date properties can show dates relative to today ("Tomorrow", "In 3 days", "2 days ago", up to
    a week either way, the full date on hover), and remind people of them: on the day, or 1, 2 or
    7 days before, at 9:00 in the time zone of whoever turned the reminder on. The reminder goes to
    the people of the row's person properties (else whoever added the row) who can see the row and
    the date, to the inbox, by email and as a push like other notifications. Rows that are done, in
    the trash or templates are left out, and dates that were already past when the reminder was
    turned on aren't announced.
  - Calendar subscription: a calendar view's address for calendar apps (iCalendar, all-day
    events), from the view's sync button. It is personal and secret: each read shows what its
    owner sees in that view then (its filters, page and property access), so access taken away
    empties it. It is shown once; make a new one to replace it, or turn it off. Calendar apps
    check back about every hour. Like an API token it answers to the workspace's connected-apps
    switch rather than its sign-in policies: it stops while export or connected apps are off.
  - Sub-items: turned on in a table, list or timeline view's settings, a row can go under another
    row of the same database (a "Parent item" property holds its one parent, "Sub-items" lists the
    rows under it). Those views show sub-items nested under their parent, opened and closed by each
    viewer, as a flat list, or show only the rows without a parent. A row can't go under itself or
    one of its own sub-items.
  - Dependencies: turned on in a timeline view's settings, a row can wait for other rows of the
    same database ("Blocked by" and "Blocking"). The timeline draws an arrow from each row to the
    rows waiting for it, red while one starts before the row it waits for ends; dragging from the
    dot at the end of a bar onto another row links them. When a row's dates move, the rows waiting
    for it follow: only when they would overlap, by as much to keep the gap, or not at all, and
    optionally never starting on a weekend. A row can't wait for itself or a row waiting for it.
  - Charts over a date can show a running total, or what remains (a burndown): grouped by the day
    work was finished, each period takes its rows away from the whole, and rows without that date
    stay open. An automation that sets the date to today when a status changes to done fills it in.
  - Select rows to edit a property, duplicate, export or trash them at once.
  - Form views collect answers as new rows, in the app or through a public link, signed in or
    anonymous.
  - Put a database inside any page, or show a view of an existing one there.
  - Lock a database to freeze its properties and views, and export its rows as CSV.
  - Row templates with preset properties and content; pick one as the default for "New".
  - Repeating templates: a row template adds a row by itself every day, every few weeks on chosen
    weekdays, every month or every year, at a time in a time zone, optionally with the date in its
    title. The rows are added as the person who set the repeat, with their access at the time, and
    start the database's "row added" automations. If that person can no longer add rows (or their
    account is gone) the repeat pauses and the template menu says why; anyone who can add rows sets
    it going again, as themselves. A server that was down adds one row for the runs it missed (dated
    the first missed day when the title carries the date), not one per run. Nothing is added while the database is in the trash. The first day of a monthly or
    yearly repeat sets its date; months without that day use their last day.
- **Database automations**: when a row is added, or a property changes (or changes to a given
  value), set properties, notify people, send the row to a webhook signed with HMAC-SHA256, or
  run an agent on the row, with a 30-day run history (see
  [Automations and webhooks](#automations-and-webhooks)).
- **Agents**: AI helpers with instructions of their own that automations run on database rows.
  Each acts as a user of its own that sees only the pages shared with it, and its changes and
  comments show its name (see [Agents](#agents)).
- **Connections**: link a workspace to any remote MCP server (Slack, GitHub, a CRM, another
  Leafdesk) so agents can use its tools: reading tools run at once, anything else waits for an
  owner's approval in the inbox; signed events from the service can start agents (see
  [Connections](#connections)).
- **Templates**: save a page or database (with its subpages) as a template and create new pages
  from it, or start from built-in templates for meeting notes, a weekly plan or a project tracker.
  Templates stay out of the sidebar, search, trash and published sites.
- **Comments**: select text and comment on it; reply, react, resolve and reopen threads, live for
  everyone on the page. People who can comment on a page (or edit it) write comments and viewers
  read along; full access also deletes other people's comments.
- **Mentions and page links**: `@` mentions people, pages (with their live title, or "No access")
  and dates with optional reminders; `[[` links to a page, or to a new page inside this one with
  the title typed, and `[[Title]]` typed, pasted or written through MCP and the API links to the
  page of that title; "Link to page"
  blocks; a "Linked from" list of backlinks on
  every page, each with the text around its link, and below it the pages that write the page's
  title without linking to it, with a button that turns that text into a mention.
- **Graph**: every page someone can open in a workspace as a point, joined by the links between
  pages, database relations and the page tree, laid out by how they connect. A database with
  many rows is one point with their count until you show its rows, its rows' relations drawn as
  one weighted edge. Hover a page to see its neighbours, click it for a card of everything it is
  joined to, double-click to open it, or focus on one page and the pages up to three steps from
  it, also beside the page ("Show in graph" in a page's menu); switches hide the page tree,
  database rows and pages without connections.
- **Inbox**: a notification when someone assigns you to a row, shares a page with you, replies in
  a comment thread you're in or mentions you, asks for access to a page you manage, when a
  database automation notifies you, and when a reminder you set is due, with an email a little later. Snooze an item
  for an hour, until tomorrow morning or until next Monday (9:00 your time): it leaves the inbox and comes back unread
  then, along with its email if that hadn't gone yet. Choose per kind whether it shows in the inbox, whether it comes by email and, on the devices where you turn them on, as a [push notification](#push-notifications).
- **Page history**: versions are saved automatically while you edit and before every AI edit.
  You can preview and restore any version, and see what changed since it or since the version
  before, and who (or which AI app) changed it.
- **Teamspaces**: group pages and people. Every workspace starts with a *General* teamspace
  everyone is in. A teamspace is **default** (everyone is in it, now and later, and can't leave),
  **open** (anyone sees it and can join; until they do, they read and comment on its pages),
  **closed** (anyone sees it, only its members open its pages, its owners add them) or **private**
  (only its members know it exists, workspace owners included). The sidebar has a section per
  teamspace you're in, a *Shared* section for pages shared with you from elsewhere and a *Private*
  section for pages only you see. Settings → Teamspaces lists them with filters, their members and
  owners, the default teamspaces and whether members may create teamspaces. Moving a page to
  another teamspace, or to Private, gives it the access of its new place; people it was shared
  with by name keep theirs. Guests are never in teamspaces: they get single pages. Each teamspace
  sets what its members get on its pages (full access, can edit, can comment or can view) where a
  page isn't shared otherwise; its owners and workspace owners get full access, and so does
  whoever adds a page at its top. Below full access, members are held to the database property
  access rules too.
- **Sharing and permissions**: give people, or everyone in the page's teamspace (the workspace
  for a private page), full, edit, comment, view or no access to a page. Subpages inherit it
  unless you change them. Share a page with someone outside the workspace by email and they join
  as a guest who sees only the pages shared with them. Someone who opens a link to a page they
  can't see can request access; the people with full access approve it at a level or decline it
  from their inbox or the Share panel (owners can turn requests off in Settings → Security).
- **Property access**: people with full access to a database decide, from a column's menu, who
  may see and change that one property: everyone with access to the database can edit it, edit
  only its values, view it, see only that the column exists, or not see it at all, with
  exceptions for people, groups and whoever a person property of the row names (their own rows).
  The widest rule wins, nobody gets more than their access to the database, and full access is
  never restricted. Restricted values stay out of every view, row page, formula, rollup, filter,
  search, AI answer, export, copy, published page, MCP and REST reply of people they are hidden
  from, and their writes are refused. Relations and the created/edited by/time properties can't
  be restricted.
- **Member groups**: workspace owners gather members into groups (Settings → Groups) and share a
  page with a group, or add it to a teamspace, the way they would with a person. Everyone in the
  group gets that access for as long as they are in it; when a page has entries for someone and
  their groups, the highest level wins. Guests can't be in groups, and people leave their groups
  when they leave the workspace or become guests. The member list shows each person's groups.
  An identity provider can manage groups over SCIM.
- **People directory and analytics**: a *People* page with a card for each owner and member (their
  teamspaces, groups and recently edited pages, as far as the viewer may see them), and, for
  owners, Settings → Analytics: active members, edits per person and the most edited pages over
  7, 30 or 90 days, with CSV export. Counted from page history and last edits; nothing extra is
  tracked.
- **Audit log**: for owners, Settings → Audit log lists who changed what in the workspace (members
  and roles, invitations and join requests, page sharing, teamspaces and groups, settings with
  their before and after, single sign-on and SCIM, pages and databases created, duplicated,
  imported, moved, put in the trash, restored and deleted for good, publishing, API tokens and
  connected apps, exports), with the app or identity provider it went through and the address it
  came from, newest first, filtered by person, kind of change and dates, and as CSV. Events are
  kept for a year.
- **Publish to the web**: a read-only public link for a page and its subpages, kept out of search
  engines unless you allow them. Published databases show the views you pick (tables, boards,
  lists, galleries) and visitors switch between them. Owners decide whether members may publish,
  can take any published page offline, or turn publishing off for the whole workspace (see
  [Workspace security switches](#workspace-security-switches)).
- **Workspace site**: owners give the workspace's published pages one readable address
  (`/s/<slug>`) with a home page and a navigation of the pages listed in it; pages get addresses
  like `/s/<slug>/getting-started-<id>`, and links between listed pages stay on the site. Pages
  are listed only when someone chooses to, so a page shared by link stays unlisted; each keeps its
  own link and search-engine setting. A publication can also **allow duplicate**: signed-in
  visitors copy the page, as published, into one of their workspaces (or its templates), files
  included and without comments, history, people or private properties.
- **File uploads**: drop, paste or pick images, video, audio and other files into a page. They are
  stored on disk or in S3-compatible storage, only people who can see a page showing them can open
  them, and published pages show theirs (see [File uploads](#file-uploads)). Uploaded PDFs show
  in place.
- **Import**: bring in Markdown files, a folder or a ZIP as pages that keep their folder
  structure, with links between the files turned into page links and the images they show
  uploaded, into the page or teamspace you start it from. A link naming a file by its bare name
  (`[Plan](Plan.md)`) finds it elsewhere in the upload when nothing sits at that path. A Leafdesk
  export comes back as it went, templates included. Import a CSV file as a new database with its column types guessed (and
  changeable before importing), or add its rows to an existing database by matching columns to
  properties.
- **Import from Notion**: in Notion, export a page or the workspace as *Markdown & CSV* with
  subpages, and choose the downloaded ZIP in Import (a large export split into parts, an
  `Export-….zip` holding `…-Part-1.zip` and so on, works as it is). Pages keep their tree, without
  Notion's ids in their titles; databases come from the full `_all.csv` with their column types
  guessed, and each row page's property list is taken off its body. Relation columns whose links
  lead to rows of another database in the same export become relations; others stay text.
  Callouts, toggles, to-dos, tables, equations, links between pages (notion.so links to pages of
  the export included) and subpage links come along; images and attachments are uploaded. Files no
  page uses, and entries whose path leads out of the ZIP, are listed in the result. Not carried
  over: page icons and covers, comments, database views, formulas and rollups (their values come in
  as text or numbers), and people (as select or text). Tested against archives built from
  Notion's documented format, not yet a real export.
- **Import from Obsidian**: choose the vault's folder (or a ZIP of it) in Import. Notes keep their
  folders. Wikilinks (`[[Note]]`, `[[Note|label]]`, `[[Note#Heading]]`, `[[Folder/Note]]`) and
  Markdown links written by name become page links, found the way Obsidian finds them: a path from
  the note or the top of the vault, else the note of that name anywhere (in the same folder first,
  then the one with the shortest path), else a note's alias from its front matter. A link to a
  heading or block leads to its note. Embedded images and files (`![[photo.png]]`) are uploaded,
  and a note embedded on a line of its own (`![[Note]]`) becomes a link-to-page block. Callouts
  come in as callouts in the nearest of the editor's five colors. Links that name nothing in the
  upload stay as written and are listed in the result. Left out: the `.obsidian` settings folder
  (not even uploaded), comments (`%%…%%`), block ids (`^id`), highlight marks (the text stays) and
  front matter other than `title` and `aliases`, since pages outside a database have no
  properties to hold tags and the like. An upload counts as a vault when one of its notes has a
  wikilink or its ZIP holds the `.obsidian` folder; other Markdown keeps `%%`, `^` and `==` as
  written. A note whose first line is a heading other than its file name takes the heading as its
  title (links still find it by file name).
- **Workspaces and members**: add people by email (several at once) as owners or members, send
  an invitation link to people who don't have an account yet, or turn on a join link anyone can
  use. Owners can export the member list as CSV, hand ownership to someone else, and decide who
  may invite guests and add members, which email domains may join on their own, who may ask to
  join, whether pages may be exported, and what connected apps and API tokens may do (see
  [Who can join a workspace](#who-can-join-a-workspace) and
  [Workspace security switches](#workspace-security-switches)).
- **Email**: invitations, password reset, assignment and share notifications over SMTP (see [Email](#email)).
- **Sign in with GitHub or Google**, optional (see [Social login](#social-login)).
- **My account**: name and picture, password, email address, signed-in devices, connected apps,
  language and notification settings in one place, and deleting the account (see
  [My account](#my-account)).
- **Two-step verification and passkeys**: an authenticator app with one-time recovery codes,
  passkeys, and a workspace policy that requires one of them (see
  [Two-step verification and passkeys](#two-step-verification-and-passkeys)).
- **Single sign-on and provisioning**: OpenID Connect for the whole server, OpenID Connect or SAML
  per workspace with DNS-verified email domains, a "single sign-on only" policy, and SCIM 2.0 user
  and group provisioning (see [Single sign-on (OIDC, SAML) and SCIM](#single-sign-on-oidc-saml-and-scim)).
- **AI writing assistant, AI properties and AI chat** (optional, off until a provider is set up):
  improve, shorten, fix, translate or rewrite selected text as you ask, continue writing, and
  summarize a page, as a suggestion you accept or discard; database text properties that AI fills
  in (a summary, a translation or your own prompt over the row's values); a chat, on its own page
  or in a panel beside a page, that answers questions from the pages you can read, citing them; and semantic search with an
  embeddings model. Anthropic, OpenAI, Google, any OpenAI-compatible server, or a local model
  with Ollama or LM Studio (see [AI features](#ai-features)).
- **Five interface languages**: English, Turkish, German, Spanish and French, chosen in My account
  or taken from the browser (see [Languages](#languages)).
- **Light and dark themes**: following the system, or chosen for the browser in Preferences.
- **MCP server with OAuth 2.1**: remote MCP endpoint at `/mcp`.
  - Supports Client ID Metadata Documents and Dynamic Client Registration, with PKCE and a
    consent screen.
  - Tokens are audience-bound. Apps can be read-only or read-write, and you can revoke them in
    My account → Connected apps.
- **REST API** under `/api/v1` with personal access tokens (read or read-write, optionally one
  workspace, optional expiry) and an OpenAPI 3.1 document (see [REST API](#rest-api)).

## Quick start (Docker)

Prebuilt images for amd64 and arm64 are published to
[GitHub Container Registry](https://github.com/esmworks/leafdesk/pkgs/container/leafdesk) for every release.
You only need two files:

```bash
mkdir leafdesk && cd leafdesk
curl -fsSLO https://raw.githubusercontent.com/esmworks/leafdesk/main/docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/esmworks/leafdesk/main/.env.example -o .env
# set BETTER_AUTH_SECRET in .env to the output of: openssl rand -base64 32
docker compose up -d
```

Open http://localhost:3000 and create an account. Migrations run automatically when the app
container starts.

- **Pin a version:** set `LEAFDESK_VERSION=0.5.0` in `.env`. The default is `latest`.
- **Upgrade:** run `docker compose pull && docker compose up -d`. Coming from 0.2.0 (released under
  the previous name), first follow the upgrade notes in [CHANGELOG.md](CHANGELOG.md).
- **Build from source:** clone the repository and run `docker compose up -d --build`.

To stop new sign-ups after creating your own account, set `DISABLE_SIGNUP=true` and restart.
You can still bring people in: in Settings → Members, add their email. If they have no account
yet, you get an invitation link to send them. The link works for 7 days and lets only that email
sign up, even while sign-up is closed. The workspace join link (Settings → Members → Add members
with a link) is different: anyone holding it can join as a member (or ask an owner to let them
in, see [Who can join a workspace](#who-can-join-a-workspace)), so it never opens closed sign-up.
People without an account can use it only while sign-up is open.

If the app is reachable under another URL (a domain behind a reverse proxy, another port), set
`APP_URL` to that public origin. It is the OAuth issuer and the MCP resource identifier, so it
must match what clients see.

`TRUSTED_PROXIES` says how many reverse proxies stand in front of the app (default `1`). Public
forms limit answers per visitor address, and the app reads that address from `X-Forwarded-For`
only as far as these proxies wrote it. Set `0` when clients reach the app directly, otherwise a
visitor could send the header and pose as a new address with every answer. Behind a CDN plus a
proxy, set `2`.

### Use an external PostgreSQL

The compose file runs PostgreSQL 18 only while `COMPOSE_PROFILES=bundled-db` is set in `.env`.
To use a database you already run, remove that line and set `EXTERNAL_DATABASE_URL` to its
connection URL. The `db` service is then not created.

## File uploads

Images, video, audio and other files added to pages are stored on disk in `UPLOAD_DIR`
(`./data/uploads` by default). With Docker Compose that directory is the `uploads` volume, so
back it up together with the database. To use S3-compatible storage (AWS S3, Cloudflare R2, MinIO)
instead, set `S3_BUCKET` and its credentials; files already stored are not moved when you switch.

| Variable | Meaning |
| --- | --- |
| `UPLOAD_DIR` | Where files go with local storage. Default `./data/uploads`. |
| `UPLOAD_MAX_FILE_MB` | Largest file, in MB. Default `50`. |
| `UPLOAD_WORKSPACE_QUOTA_MB` | Most one workspace may store, in MB. Default `10240`; `0` means no limit. |
| `S3_BUCKET` | Store files in this bucket instead of on disk. |
| `S3_ENDPOINT` | The service's URL for R2, MinIO and others, e.g. `https://<account-id>.r2.cloudflarestorage.com`. Leave out for AWS S3. |
| `S3_REGION` | Default `us-east-1` (R2 accepts it too). |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Credentials allowed to put, get and delete objects in the bucket. |
| `S3_FORCE_PATH_STYLE` | Address the bucket by path (`<endpoint>/<bucket>/…`). Default `true` with `S3_ENDPOINT`, `false` for AWS. |
| `S3_PREFIX` | Optional folder inside the bucket. |

Limits are enforced while a file arrives. A file can be opened by anyone who can see the page it
was uploaded to or a page of the same workspace showing it (so duplicates and pages made from
templates share it), or a row whose files & media property holds it, and by visitors of a
published page showing it. Only raster images, video,
audio and PDF open in the browser; everything else, SVG included, is downloaded. When a page is
deleted for good, its files go once no other page shows them, and uploads no page ever used are
removed after a day.

## Export

The page menu exports a page as Markdown or a database as CSV. "Export with subpages" (for a
database, "Export with row pages") downloads a ZIP of the page and everything under it; owners
can download the whole workspace from Settings → General → Export. Owners can turn exporting off
in Settings → Security (see [Workspace security switches](#workspace-security-switches)). The
archive mirrors the sidebar:

```
Project.md              a page, and a folder of the same name for its subpages
Project/
  Tasks.csv             a database as CSV, its row pages in a folder beside it
  Tasks/
    Write docs.md       a row page lists its properties under its title
    Templates/          the database's row templates
Templates/              workspace templates (whole-workspace exports only)
files/                  uploaded files the exported pages and rows show
```

Names come from titles, made safe for every file system and unique within their folder. Links
between exported pages and to uploaded files point into the archive (relative paths), so the
Markdown can be opened in an editor such as Obsidian; links to pages that aren't in it point at
the app. An export holds only what the person exporting can see: pages they can't open are left
out and links to them say "No access". Pages in the trash are left out; exporting a page from the
trash brings the subpages trashed with it.

Pages stay in the trash for the time owners choose in Settings > Security > Data retention (30
days by default, or forever); once a day the server deletes the pages whose time is up, with their
files, and prunes old page history (versions older than 90 days or past the newest 200 of a page;
saved versions and those from before a restore stay a year) and the audit log's events older than
a year. Production servers run this cleanup; set `RETENTION_JOB=on` or `off` to decide otherwise
(a dev server doesn't run it unless it is `on`).

The ZIP is streamed while it is built, one download at a time per person. Larger exports are
refused up front with a message:

| Variable | Meaning |
| --- | --- |
| `EXPORT_MAX_PAGES` | Most pages (rows and templates included) one export may hold. Default `10000`. |
| `EXPORT_MAX_FILES_MB` | Most MB of uploaded files one export may hold. Default `2048` (at most about 3.5 GB). |

### PDF

"Export as PDF" in the page menu opens the page's print view (`/print/<page id>`) in a new tab
and, once its images and diagrams have loaded, the browser's print dialog: choose "Save as PDF"
as the destination. The print view draws the page the way published pages do (headings, tables,
code, images, callouts, equations, Mermaid diagrams, database blocks) and is always light, also in
dark mode. Code and tables wrap to the page width, headings stay with the text after them, and
each page starts with its title. Links to other pages print as their titles. "Include subpages"
in the view's bar adds the pages under it (up to 100), each starting on a new sheet; database
rows print in their database's table. It shows what the person printing can see, like the page
itself, and follows the workspace's two-step policy.

The browser makes the PDF, so the server needs nothing extra (no headless browser in the image).
Its own header and footer (date, address, page numbers) can be turned off under "More settings"
in the print dialog.

## Install and offline use

**Installing.** Leafdesk is a web app with a manifest, icons and a service worker, so browsers
offer to install it: the install icon in Chrome's or Edge's address bar, "Install app" in the
workspace menu (shown only while the browser offers it; nothing pops up on its own), or "Add to
Home Screen" in Safari's share menu on iPhone and iPad. Installed, it opens in its own window and
starts at your last workspace. Installing needs HTTPS (or `localhost`).

**Offline.** Every page you open is also kept in the browser (its Yjs document, in IndexedDB).
Without a connection — no network, or the server is down — the page stays editable; the header
says "Offline", and "Offline · edits kept here" once you have changed something. When the
connection is back the edits are sent ("Syncing…", then "Synced") and merge with what others wrote
meanwhile. Pages edited offline and closed before the connection returned are sent in the
background the next time the app is open. In an installed app or a tab opened later, the service
worker serves the pages you opened before (the last 50) from its copy; others show a short
"You're offline" page listing what is available. The sidebar and the last 30 databases and rows
you opened stay readable offline; they are read-only until the connection is back, as are
sharing, comments, favorites, search, the inbox, new pages and the other actions that need the
server (their buttons say so).

**After an update.** A tab opened before the server was updated stops syncing its pages and asks
to be reloaded ("Leafdesk has been updated"); edits made in it are kept in the browser and sent
after the reload. An older version of the editor would drop blocks it doesn't know yet, such as
ones a newer release added, from the pages it shows, and the change would reach everyone. So the
server turns down the collaboration connection of a tab from another build, and a tab doesn't
load a page's offline copy before it knows it runs the server's build (offline: the build another
tab of this browser last met). Each `next build` gets its own id; development has none.

**Privacy.** Offline copies are kept per user and removed when you sign out (after a warning if
some edits haven't reached the server yet), when someone else signs in on the same browser, and,
for a page, as soon as the server says it is gone or no longer shared with you. The collaboration
token is never stored. A browser profile shared by several people without signing out still
shares its offline copies, as it shares its cookies; sign out on shared computers.

The service worker (`public/sw.js`) runs in production builds only; `pnpm dev` removes one left
behind so hot reloading keeps working. It never caches API responses, uploads, server actions or
the collaboration socket. Images and files in pages are not kept offline.

### Desktop app

Installing the web app is the desktop app for now. We looked at wrapping it:

| | Installed web app | Tauri | Electron |
| --- | --- | --- | --- |
| Size | nothing to download | ~10 MB, the system's web view | ~100 MB+, ships Chromium |
| Offline editing | yes (service worker + IndexedDB) | the same web code | the same web code |
| Updates | with the server, automatic | signed releases per platform | signed releases per platform |
| Extras | install from the browser | native menus, tray, file access; Safari's WebKit on macOS, WebView2 on Windows | native menus, tray, file access, one engine everywhere |
| Cost | none | a Rust shell, code signing, a release pipeline | code signing, a release pipeline, frequent Chromium security updates |

A shell would load the same self-hosted server, so it adds no offline ability the installed app
lacks; it would add a place to keep the server address, native menus and global shortcuts. If
that becomes worth it, Tauri is the better fit (small, uses the system web view, and the app
already works in WebKit through Safari); Electron only if one rendering engine everywhere
matters more than size.

## Email

Email is needed for invitations and password reset. Set these in `.env`:

| Variable | Meaning |
| --- | --- |
| `SMTP_URL` | Connection URL, e.g. `smtp://user:password@smtp.example.com:587`. Use `smtps://` for implicit TLS on port 465. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` | Alternative to `SMTP_URL`. The port defaults to 587 (STARTTLS), or 465 with `SMTP_SECURE=true`. |
| `MAIL_FROM` | Sender, e.g. `Leafdesk <no-reply@example.com>`. Required when SMTP is set. |

Check the settings with `pnpm mail:test you@example.com`. In Docker, run
`docker compose exec app tsx scripts/send-test-email.ts you@example.com`. The server also logs
its mail setup at startup.

Without SMTP, development prints emails to the server log. In production, features that need
email say that it is not configured.

With email available (SMTP, or the development log), new email and password accounts get a link
that verifies their address, and My account → Profile can send it again. Verified addresses matter
for workspaces that let their [email domains](#who-can-join-a-workspace) in. In production
without SMTP no link is sent, and only accounts whose provider vouches for the address (GitHub,
Google, single sign-on, SCIM) count as verified.

## Push notifications

New inbox items can also come as system notifications on people's devices, while Leafdesk is
closed too. Each person turns them on per device in My account → Preferences ("Push notifications
on this device"), and picks there, per kind of notification, whether it comes as a push next to
the inbox and email. Push follows the inbox: a kind kept out of the inbox isn't pushed. Opening a
notification brings an open Leafdesk tab to the page, or opens one; its "Snooze 1 hour" button
puts it off as the inbox's snooze does (not on agents' requests to go ahead, which wait only so
long).

Push is off until the server has a VAPID key pair. Make one and add the printed lines to `.env`:

```bash
pnpm push:keys mailto:ops@example.com
# Docker: docker compose run --rm app tsx scripts/generate-vapid-keys.ts mailto:ops@example.com
```

| Variable | Meaning |
| --- | --- |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | The key pair the server signs push messages with. Keep the private key secret. |
| `VAPID_SUBJECT` | An address the browsers' push services can reach you at: `mailto:` or `https:`. |
| `PUSH_ALLOWED_HOSTS` | Optional. Push services on a private network or plain http that push may reach (a push service run next to the server), comma-separated as a host name or `host:port`. |

Without all three VAPID values push is off and its settings are hidden. Changing the keys stops
push on every device until it is turned on there again. Push needs the service worker, so it works
in production builds over HTTPS (or `localhost`), not under `pnpm dev`. On iPhone and iPad, Safari
delivers push only to the installed app (Add to Home Screen).

A push message carries only what the inbox shows for the notification (the page's name, who did
what), checked against the recipient's access like the inbox, in their language. It is encrypted
for the browser, and push services keep it a day at most. A device's subscription belongs to the
sign-in it was made in: signing out, or the session being revoked or running out, stops it. The
endpoints come from browsers, so the server sends only to public https addresses on port 443,
checked before every send with the connection pinned to the checked address; hosts in
`PUSH_ALLOWED_HOSTS` skip that check. A push service that says a subscription is gone gets it
deleted, and one that fails 10 times in a row has it dropped.

## Social login

People can also sign in with GitHub or Google. Each provider is off until you set both of its
variables in `.env` and restart:

| Provider | Variables | Callback URL to register |
| --- | --- | --- |
| GitHub ([new OAuth app](https://github.com/settings/applications/new)) | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | `${APP_URL}/api/auth/callback/github` |
| Google ([OAuth client](https://console.cloud.google.com/apis/credentials), type "Web application") | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `${APP_URL}/api/auth/callback/google` |

For example, with `APP_URL=https://notes.example.com` the GitHub callback URL is
`https://notes.example.com/api/auth/callback/github`. The sign-in and sign-up pages show a
"Continue with …" button for each configured provider.

- **Existing accounts:** signing in with a provider opens the account that has the same email,
  as long as the provider says the address is verified. Otherwise the person is asked to sign in
  with their password. If that account's email was never verified, signing in this way also
  removes its password and signs out its other sessions and connected apps: anyone could have
  registered the address before its owner did. The owner can get a password back with "Forgot
  password", which proves the address by email.
- **Closed sign-up:** with `DISABLE_SIGNUP=true`, a provider signs in only people who already
  have an account, or who were invited with that email. It never creates other accounts.

## My account

"My account" in the workspace menu (or the name and picture at its top) opens `/account`. It
belongs to the person, not to a workspace, so it also works for someone who isn't in any
workspace and isn't held back by a workspace's two-step policy. The old addresses
(`/w/<id>/settings?tab=preferences`, `accountSecurity`, `apps`) redirect to it.

- **Profile:** name (up to 80 characters) and picture. The browser crops the picture to a
  256×256 WebP (PNG where WebP isn't available) before uploading it. PNG, JPEG, WebP and GIF up
  to 2 MB are accepted, checked by their content (SVG never is); pictures are stored with the
  other uploads and shown only to signed-in people. Pictures from GitHub or Google stay until
  someone uploads their own.
- **Email:** the new address gets a link, valid for 24 hours, that makes the change when opened
  and confirmed there (no sign-in needed, and it signs nobody in); the old address is told about
  it. An address another account uses gets no link, and nobody is told so. In production without SMTP
  the option is off and says why (development prints the email to the server log).
- **Password:** change it with the current one, optionally signing out every other device. People
  who only sign in with GitHub or Google can set one instead. Both send a notice by email.
- **Sessions:** every signed-in device with its browser, system, IP address and last activity
  (refreshed about once a day), with "Sign out" per device and "Sign out all other devices",
  which also closes their live collaboration connections. A session ends after
  `SESSION_MAX_AGE_DAYS` without use (see below).
- **Security, connected apps, language and notifications:** as before, moved here from the
  workspace settings.
- **Delete account:** type the account's email to confirm. It is refused while the person is the
  only owner of a workspace others are in (they hand ownership over, or remove the others,
  first). Otherwise workspaces nobody else is in are deleted with their pages and files, and the
  others are left the way leaving works: an owner takes over the pages only this person could
  manage. Sessions, passkeys, connected apps, notifications and the picture go with the account;
  pages and comments the person wrote in the remaining workspaces stay.

Changing the email or password and deleting the account ask for the password again, or for a
two-step code (or recovery code) on accounts without one. An account with neither needs a
sign-in from the last 10 minutes. These checks are rate-limited per person (10 tries per 15
minutes), as are email changes (5 an hour), picture uploads (20 an hour) and signing out devices.

How long a sign-in lasts is set for the whole server:

| Variable | Meaning |
| --- | --- |
| `SESSION_MAX_AGE_DAYS` | Days a session lasts, in whole days from 1 to 3650. Default `7`. A session in use is extended (about once a day, or halfway through for a one-day lifetime), so this is how long a device may sit unused before it has to sign in again. Existing sessions keep the expiry they have until they are next extended. |

## Workspace security switches

Owners decide in the workspace's **Settings → Security** what may leave the workspace. The
server enforces each switch everywhere it applies: in the app, on public pages, over MCP and in
the REST API.

- **Publishing:** *Owners only*, *Owners and members*, or *Off*. Off stops serving everything the
  workspace has published: published pages, their files, the workspace site and public forms
  answer "not found", and nobody can publish or duplicate them. Nothing is deleted: the
  publications and the site's settings stay listed in Settings, and come back as they were when
  publishing is turned on again.
- **Export:** on by default. Off removes Markdown, CSV, ZIP and PDF export (and the print view)
  for everyone, owners included, and the export routes answer `403`. The member list CSV in
  Settings → Members stays, as it is an owner's own administration tool.
- **Connected apps and API tokens:** what MCP apps and personal access tokens may do in the
  workspace, on top of their own permissions and their user's access. *Full access* (default),
  *Read only* (write tools and write endpoints are refused, reads still work), or *Off* (the
  workspace is hidden from them: `list_workspaces` and `GET /workspaces` leave it out, and its
  pages answer as pages the user can't see). This applies to the MCP server and the REST API
  only; the app itself in the browser is not affected.

## Who can join a workspace

Owners decide in the workspace's **Settings → Security → Members**:

- **Who can add members:** *Owners only* (default), *Members, with an owner's approval*, or
  *Owners and members*. Members add people as members only, never as owners or guests. With
  approval, what a member adds (one address or several) becomes a request, and the invitation
  (with its email) goes out in the member's name once an owner approves it. Guests never add
  anyone. The same rule applies wherever members are added, in the app and through MCP's
  `invite_member` (a member's invitation there becomes a request the same way); the REST API
  only lists members.
- **Allowed email domains** (`example.com, example.org`, subdomains included, up to 20; public
  mail services such as gmail.com can't be added) and what happens **when someone from these
  domains signs in**: they *join as members* (default) or *ask to join*. This runs on sign-up,
  on every sign-in and when an address is verified or changed, once per person and workspace:
  someone who left, or whom an owner removed or declined, doesn't come back on their own. Only
  verified addresses count (see [Email](#email) for how an address is verified, with and without
  SMTP). The workspace switcher also lists the workspaces a person's domain lets them join or ask
  to join, with a Join or Request to join button: people who left may rejoin there, people who
  were removed or declined may only ask.
- **Who can ask to join:** *Nobody* (default), *People with an allowed email domain* (including
  unverified addresses and people removed or declined before), or *Anyone with the join link*.
  With the last one the join link asks an owner instead of adding people right away, except for
  people with a pending invitation or a verified address on an allowed domain that joins directly.

Requests wait in **Settings → Members → Requests**, where owners approve or decline them; every
owner also gets one in their inbox (and by email, unless they turned join request emails off in My
account → Preferences). The person who asked hears the decision by email, in their language (see
Languages), else the one they asked in. There is one pending request per person and workspace (and per invited address), and
people may send 10 requests an hour, members 100 invitation requests an hour.

## Two-step verification and passkeys

Everyone manages these in **My account → Security**:

- **Authenticator app (TOTP):** scan a QR code (or type the key) into an app such as 1Password
  or Google Authenticator and confirm with a code. Ten recovery codes are shown once, to copy or
  download; each signs in once, and "New codes" replaces them. From then on, signing in with the
  password *or* with GitHub/Google asks for a code; "Don't ask again on this device" skips it for
  30 days. Turning it off asks for the password, or, for accounts without one, a code.
- **Passkeys:** add, rename and remove them; "Sign in with a passkey" is on the sign-in page.
  Passkeys are bound to the host name of `APP_URL`, so changing that host makes existing
  passkeys stop working. Adding one needs a sign-in from the last 24 hours.

Owners can turn on **Require two-step verification** in the workspace's **Settings → Security**.
A session passes when the person has the authenticator app on, or signed in with a passkey;
anyone else who opens the workspace is sent to a page where they set one of them up first
(nobody is locked out, owners included). An owner can only turn the policy on from a session
that passes it. The policy covers everything a browser session reaches: the app's pages, exports,
server actions, API routes (files, import) and the live collaboration connection, which is
checked when it connects; turning the policy on closes the open connections of sessions that
don't pass. Apps connected over MCP and REST API tokens are not affected: they use OAuth or
personal access tokens, not sign-in sessions, and keep working until someone revokes them under
Connected apps.

Someone who lost both their authenticator app and their recovery codes can be reset by whoever
runs the server; this turns two-step verification off and signs them out (`--passkeys` also
removes their passkeys):

```bash
pnpm auth:reset-2fa person@example.com
# Docker: docker compose exec app tsx scripts/reset-two-factor.ts person@example.com
```

## Instance administrators

Whoever runs the server can name the accounts that administer it. There is no role in the
database: the list below is the only source, and an account counts only once its email address
is verified.

| Variable | Description |
|---|---|
| `ADMIN_EMAILS` | Comma-separated email addresses of the instance administrators, in any case, e.g. `ops@example.com, ada@example.com`. Empty by default: nobody is. |
| `WORKSPACE_CREATION` | Who may create workspaces: `everyone` (default) or `admins`. Any other value means `admins`. The personal workspace every new account gets at sign-up is still created. |

An address is verified by signing in once with GitHub or Google with it (when the provider
confirms the address), by resetting the password through the emailed link, or by whoever runs
the server:

```bash
pnpm auth:verify-email ops@example.com
# Docker: docker compose exec app tsx scripts/verify-email.ts ops@example.com
```

Administrators get **Server administration** in the workspace menu and in My account; for
everyone else `/admin` doesn't exist (404), and its actions do nothing. With
`WORKSPACE_CREATION=admins`, "New workspace" is hidden from everyone else and the server
refuses it. The page has:

- **Accounts:** every account with its email, whether the address is verified, how many
  workspaces it is in, when it was last active, and whether it uses two-step verification;
  search by name or email. The first 200 are listed; a search narrows them down.
- **Sign out everywhere** for one account, and **Sign out everyone** except the administrator's
  own browser. Both end the sessions and close their live collaboration connections.
- **Require a new password** for one account, or for everyone with a password (except the
  administrator, who changes theirs in My account). Their sessions end, and their next password
  sign-in gets no session. With SMTP, they get an email with a link to choose one (valid for 1
  hour; another is sent at most every 5 minutes); without it, the sign-in page asks for the new
  password right away, and for a two-step code when the account has it on. The old password
  can't be chosen again. Changing the password in My account clears the requirement too.
  Accounts without a password (GitHub, Google or single sign-on only) are not affected, and
  neither are other ways in: GitHub, Google, single sign-on and passkeys still sign them in.

Apps connected over MCP and REST API tokens use OAuth or personal access tokens, not sessions,
so signing people out doesn't disconnect them; the person revokes them under Connected apps.
Every administrator action is written to the server log (`[admin] …`).

## Single sign-on (OIDC, SAML) and SCIM

Organizations can sign people in through their own identity provider (Keycloak, Authentik, Okta,
Microsoft Entra ID, Google Workspace…) in two ways, which can be combined:

- **For the whole server** (the operator's provider, OpenID Connect): set the variables below and
  restart. The sign-in page gets a "Continue with `OIDC_NAME`" button.
- **Per workspace** (OpenID Connect or SAML 2.0): an owner sets it up in **Settings → Security →
  Single sign-on**. People sign in with it through **Continue with SSO** on the sign-in page,
  where they type their email and are sent to their organization's provider.

| Variable | Meaning |
| --- | --- |
| `OIDC_ISSUER` | Issuer URL; its discovery document must be at `<issuer>/.well-known/openid-configuration` |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | The client registered at the provider (confidential, authorization code flow) |
| `OIDC_NAME` | Button label (default `SSO`) |
| `OIDC_DOMAINS` | Comma-separated email domains the provider is authoritative for (optional, see below) |
| `SSO_TRUSTED_ORIGINS` | Comma-separated origins of workspace providers on a private network (the instance issuer's is trusted already) |

The instance provider's redirect URI is `${APP_URL}/api/auth/sso/callback/oidc`. The scopes asked
for are `openid email profile`, with PKCE.

**What single sign-on does**

- **First sign-in creates the account.** Through a workspace connection, only for addresses in
  its verified domains; the person also joins that workspace as a member. So does an existing
  account on its first sign-in through the connection. Only then: someone an owner removes later
  stays out (their provider can bring them back over SCIM). Through the instance provider, for anyone it signs in, or only
  for `OIDC_DOMAINS` when those are set; it creates accounts even with `DISABLE_SIGNUP=true`,
  since the operator configured it. Set `OIDC_DOMAINS` for a provider that signs in people outside
  your organization (Google does).
- **Existing accounts** with the same email are signed in only when the provider is authoritative
  for the address: a workspace connection for its verified domains, the instance provider for
  `OIDC_DOMAINS`. Like social login, an account whose email was never verified loses its password
  and its earlier sessions when this happens (see [Social login](#social-login)).
- **Two-step verification still applies:** someone with an authenticator app is asked for a code
  after the provider, as with a password.

**Setting up a workspace connection** (owners): the SSO box shows what to enter at the provider,
each with a copy button: the workspace ID, the **OIDC redirect URI**
(`${APP_URL}/api/auth/sso/callback/ws-<workspace id>`), the **SAML entity ID** (audience), the
**ACS URL** (`${APP_URL}/api/auth/sso/saml2/sp/acs/ws-<workspace id>`) and the SAML metadata URL.
Then fill in the provider's details:

- **OpenID Connect:** issuer URL, client ID and client secret. The issuer's discovery document is
  read when saving (it must name the same issuer, and its endpoints must be https unless the
  origin is in `SSO_TRUSTED_ORIGINS`). Addresses on private networks are refused unless trusted.
- **SAML 2.0:** paste the provider's metadata XML, or enter its SSO URL, entity ID and signing
  certificate. Assertions must be signed; the NameID format asked for is the email address.
  Single logout is not supported.
- **Email domains** (`example.com, example.org`; subdomains included): the connection signs
  nobody in until they are verified. Add the TXT record it shows for each domain
  (`_leafdesk-sso.<domain>` with the value `leafdesk-sso=<token>`) at your DNS provider and click
  **Verify domains**. Public mail services (gmail.com, outlook.com…) can't be claimed, and a
  domain verified by one workspace (or listed in `OIDC_DOMAINS`) can't be verified by another.
  Changing the domains or the provider asks for verification again.

A workspace has one connection. Removing it (or the workspace) removes its provider; sessions that
came through it no longer count for "Single sign-on only".

**How members sign in** (Settings → Security): *Any method* (default) or *Single sign-on only*.
With single sign-on only, members whose session didn't come through the workspace's connection
(or the instance provider) are sent to a page that signs them in with it, and like two-step
verification the policy covers the app's pages, exports, server actions, API routes and live
collaboration, and closes open connections when turned on. **Owners and guests are exempt**, so a
broken identity provider can't lock a workspace: owners keep their password or passkey. It can be
turned on only once a verified connection (or the instance provider) exists. Apps connected over
MCP and REST API tokens are not affected.

**SCIM 2.0 provisioning.** Owners create SCIM tokens in Settings → Security (shown once, stored
as a SHA-256 hash, at most 20 per workspace, 600 requests a minute each) and give the provider the
base URL `${APP_URL}/scim/v2` with the token as a bearer token. Supported:

- `/Users`: list (with `startIndex`/`count` and one `eq` filter on `userName`, `externalId`,
  `emails.value` or `id`), get, create (`POST`), replace (`PUT`), `PATCH` (`active`,
  `externalId`, `displayName`, `name`; `userName` and `emails` are ignored: an account's address
  is its owner's) and delete.
- Users are the workspace's owners and members, plus people the provider deactivated. Creating a
  user makes them a member (a guest is promoted); a new account is created only for addresses in
  the workspace's verified SSO domains, anyone else must have an account already. Names are
  changed only for addresses in those domains.
- `active: false` removes the person from the workspace (what an owner removing them does) and
  keeps them listed as inactive; they can't come back through single sign-on until reactivated.
  `DELETE` removes them and forgets them. Owners can't be deactivated or deleted over SCIM.
- `/Groups` are the workspace's [member groups](#features), all of them, including ones made in
  the app: list (with `startIndex`/`count`, one `eq` filter on `displayName` (ignoring case),
  `externalId` or `id`, and `excludedAttributes=members`), get, create (`POST` with
  `displayName`, `externalId`, `members`), replace (`PUT`; `members` and `externalId` it leaves out
  are kept, `members: []` empties the group), `PATCH` and delete. `PATCH` takes what Okta and
  Microsoft Entra ID send: `add`/`remove`/`replace` on `members` (a `remove` without a value
  empties the group), `remove` on `members[value eq "<user id>"]`, `displayName` and `externalId`
  paths, and path-less operations with an object value; op names in any case.
- Group members are SCIM user ids of the workspace's owners and members. Guests, people the
  provider deactivated, other people and nested groups are refused with 400 `invalidValue`, and
  nothing in that request is applied. A name another group has (ignoring case) is a 409
  `uniqueness`.
- Group changes go through the same code as Settings → Groups: access is worked out again, open
  editors of people who lost a page close, and pages only the group could manage pass to someone.
  A SCIM token isn't a person, so the workspace's **oldest owner** acts for it: they receive those
  pages (as they do when the provider removes a member) and are recorded as having created the
  groups the provider creates. Settings → Groups marks groups the provider created or changed
  ("From your identity provider"); owners can still edit them, but the provider may undo that at
  its next sync. Someone made a guest in the app leaves their groups, and the provider adding them
  back is refused.
- `/ServiceProviderConfig`, `/ResourceTypes` and `/Schemas` (User and Group attributes) for
  discovery.

**Examples**

- **Keycloak** (OIDC): create a client with *Client authentication* on and the standard flow,
  add the redirect URI from the SSO box (or `…/sso/callback/oidc` for the instance provider). The
  issuer is `https://keycloak.example.com/realms/<realm>`. Keycloak in the same Docker network:
  `SSO_TRUSTED_ORIGINS=http://keycloak:8080`. For SAML, import the SSO box's metadata URL as a
  SAML client and paste the realm's descriptor
  (`…/realms/<realm>/protocol/saml/descriptor`) as the metadata XML.
- **Authentik** (OIDC): create an *OAuth2/OpenID Provider* (confidential client, redirect URI from
  the SSO box) and an application using it; the issuer is
  `https://authentik.example.com/application/o/<application slug>/`. SCIM: add a *SCIM Provider*
  with the base URL and a SCIM token, and attach it to the application as a backchannel provider.
- **Google Workspace**: as the instance provider (OIDC), create an OAuth client of type *Web
  application* in Google Cloud with the redirect URI `${APP_URL}/api/auth/sso/callback/oidc`, set
  `OIDC_ISSUER=https://accounts.google.com` and `OIDC_DOMAINS=<your domain>` (Google signs in any
  Google account otherwise). Per workspace, use SAML: add a *custom SAML app* in the Admin console
  with the ACS URL and entity ID from the SSO box, *Name ID format* EMAIL with the primary email,
  and paste the IdP metadata it offers. Google Workspace doesn't send SCIM to custom apps.

Tested here against a mock OpenID Connect provider (`scripts/sso-e2e.ts`) and over HTTP for SCIM
(`scripts/scim-e2e.ts`, which sends groups the way Okta and Entra ID document it); SAML, SCIM from
Okta or Entra ID and the providers above have not been tried against the real thing.

## Deploy on Dokploy

Run the database as a Dokploy database service and the app as an Application, so Dokploy
handles database backups on its own. No compose file is involved.

1. Create a **Database → PostgreSQL** service with Docker image `postgres:18` and deploy it.
   Copy its **Internal Connection URL**.
2. Create an **Application** with this repository as its GitHub source and build type
   **Dockerfile**.
3. Under **Environment**, set `APP_URL` (the public origin, e.g. `https://notes.example.com`),
   `BETTER_AUTH_SECRET` (`openssl rand -base64 32`) and `DATABASE_URL` (the Internal Connection
   URL from step 1).
4. Under **Domains**, add your domain with container port `3000` and HTTPS.
5. Deploy. Migrations run when the container starts. Turn on auto deploy to redeploy on every
   push.

## Automations and webhooks

A database automation does something when rows of its database are added or changed. People with
full access to the database see and manage its automations, in the app or over MCP
(`list_automations`, `create_automation`, `update_automation`, `delete_automation`,
`list_automation_runs`). Creating, changing and deleting one is recorded in the audit log.

**Triggers**

- *A row is added*, however it is added: in the app, through a form, an import, MCP or the REST API.
- *A property changes*: one property, or any property of an existing row. For select, status,
  checkbox, person and multi-select properties it can wait for a value: "Status changes to Done"
  runs only when the value becomes Done, not when the row is saved again with Done (for person
  and multi-select, when that person or option gets added). A new row that starts out with the
  value counts too.

**Actions**, done in order, each one on its own (one failing doesn't stop the others):

- *Set properties* on the row. A date can be set to the day the automation runs (UTC), a person to
  whoever made the change (left as it is when an anonymous form answer started it). Formulas,
  rollups and the created/edited properties can't be set.
- *Notify* chosen people and the people the row's person properties name: an inbox notification,
  and an email as each of them chooses in My account → Preferences. Only people who can open the
  row are notified.
- *Send a webhook*: a signed JSON POST to an http(s) address (below).
- *Run an agent* on the row, with a task of up to 2000 characters (see [Agents](#agents)). Only
  owners of the workspace add or change this action, since the agent may open pages others can't;
  anyone who manages the automation may keep or remove it. Saving the automation shares its
  database with the agent at edit access. The run is queued and done apart, so the automation's
  run counts the action as done once the agent's run is queued.

A database has at most 50 automations, an automation at most 10 actions, and a notify action at
most 50 chosen people.

**Who it runs as.** An automation acts as the person who last saved it, with their access at the
time it runs. If they no longer have full access to the database, its runs fail (`noAccess`)
until someone with full access saves it again. A turned-off automation doesn't run, and runs for
rows that were trashed in the meantime are skipped.

**No chains.** Changes an automation makes don't start automations, so two automations can't
set each other off.

**Run history.** Each run is kept for 30 days after it finishes, with how each action went
(done, failed or skipped, attempts, an error code, a webhook's HTTP status, how many people were
notified). Runs on rows you can't open are left out.

**Not (yet) covered.** A copy of a database, or a template made from one, starts without
automations. The REST API has no automation endpoints; use the app or MCP. Changes that aren't
row writes don't start automations: a relation's other side updated by a two-way relation, values
AI autofill writes, and a property or option being deleted.

### Webhooks

Each delivery is a `POST` with these headers:

| Header | Value |
| --- | --- |
| `Content-Type` | `application/json` |
| `User-Agent` | `Leafdesk-Webhook/1.0` |
| `X-Leafdesk-Event` | `row.created`, `row.updated`, or `ping` for a test delivery |
| `X-Leafdesk-Delivery` | The run id, the same on every retry; use it to ignore duplicates |
| `X-Leafdesk-Signature` | `t=<Unix seconds>,v1=<hex HMAC-SHA256>` (below) |

The body describes the row as the automation's person sees it after the run's earlier actions,
with property values by name in the same form `query_database` returns them. `changed` lists the
names of the properties that changed (all the properties set on a new row), and `actor` is
`null` when an anonymous form answer started the run:

```json
{
  "id": "0d1c6e0e-4f0b-4d55-9b7a-2f1f3c8e9a10",
  "event": "row.updated",
  "created_at": "2026-10-06T09:14:03.512Z",
  "automation": { "id": "5b2f…", "name": "Tell Slack about finished tasks" },
  "workspace_id": "8a41…",
  "database": { "id": "c3d9…", "title": "Tasks", "url": "https://notes.example.com/w/8a41…/p/c3d9…" },
  "row": {
    "id": "e7f2…",
    "title": "Fix login redirect",
    "url": "https://notes.example.com/w/8a41…/p/e7f2…",
    "properties": {
      "Status": "Done",
      "Assignee": [{ "id": "u_12…", "name": "Ada Lovelace" }],
      "Due": "2026-10-06",
      "Tags": ["auth", "bug"]
    }
  },
  "changed": ["Status"],
  "actor": { "id": "u_12…", "name": "Ada Lovelace" }
}
```

A `ping` (the test button) has `id`, `event`, `created_at`, `automation`, `workspace_id` and
`database: {id}` only.

**Verifying the signature.** Each automation with a webhook has its own signing secret
(`whsec_…`), shown with the automation; replacing it stops the old one at once. The secret is
derived from the server's `BETTER_AUTH_SECRET`, so changing that changes every webhook secret.
`v1` is the hex HMAC-SHA256, keyed with the secret, of the timestamp, a dot and the raw body.
Check it over the raw bytes you received, before parsing the JSON, and refuse old timestamps
(5 minutes is a good limit) so a captured request can't be replayed:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

// rawBody: the request body as received (a string or Buffer), not re-serialized JSON.
export function verifyLeafdeskWebhook(rawBody, signatureHeader, secret, toleranceSeconds = 300) {
  const parts = Object.fromEntries(signatureHeader.split(",").map((p) => p.split("=", 2)));
  const timestamp = Number(parts.t);
  if (!Number.isInteger(timestamp) || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(parts.v1, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
```

**Delivery and retries.** A delivery succeeds when the address answers 2xx within 10 seconds.
Redirects aren't followed and count as a failure. Network errors, timeouts, `408`, `429` and
`5xx` answers are tried again after 1 minute, 5 minutes, 30 minutes and 2 hours, 5 attempts in
all; other answers fail at once. Every attempt sends the same body with a fresh timestamp and
signature.

**Where webhooks may go.** Only `http` and `https` addresses without credentials in them, on
ports 80, 443, 8080 or 8443, whose every address is public: private networks, loopback,
link-local and similar addresses are refused when the automation is saved and again before each
delivery (the connection goes to the address that was checked). To reach a service on the
server's own network, such as an n8n container next to Leafdesk, list its host in
`AUTOMATION_WEBHOOK_ALLOWED_HOSTS`, comma-separated, as a host name or `host:port`
(`AUTOMATION_WEBHOOK_ALLOWED_HOSTS=n8n,localhost:5678`). Listed hosts skip the address and port
checks.

## AI features

Leafdesk can use a language model for a writing assistant in pages, database properties that AI
fills in, and a chat that answers questions from your pages; and an embeddings model for
semantic search. All are **off** until the server has a provider: set `AI_PROVIDER` and
`AI_MODEL` (plus a key for hosted providers) in `.env` and restart, and `AI_EMBEDDINGS_MODEL` for
semantic search (it works without a chat model too). Nothing is sent anywhere while they are
unset.

| Provider | `AI_PROVIDER` | Needs |
| --- | --- | --- |
| Anthropic | `anthropic` | `AI_API_KEY` (or `ANTHROPIC_API_KEY`) |
| OpenAI | `openai` | `AI_API_KEY` (or `OPENAI_API_KEY`) |
| Google Gemini | `google` | `AI_API_KEY` (or `GEMINI_API_KEY`) |
| OpenCode Go | `opencode-go` | `AI_API_KEY` (or `OPENCODE_API_KEY`) from the OpenCode Console |
| Any OpenAI-compatible server (vLLM, LiteLLM, OpenRouter, llama.cpp…) | `openai-compatible` | `AI_BASE_URL` (the `/v1` root), a key if it wants one |
| Ollama (local) | `ollama` | the model pulled; `AI_BASE_URL` defaults to `http://localhost:11434/v1` |
| LM Studio (local) | `lmstudio` | the model loaded; `AI_BASE_URL` defaults to `http://localhost:1234/v1` |

```bash
AI_PROVIDER=anthropic
AI_MODEL=claude-haiku-4-5
AI_API_KEY=sk-ant-...

# or a local model
AI_PROVIDER=ollama
AI_MODEL=llama3.2
```

**OpenCode Go** serves its models over three APIs; Leafdesk picks the right one for each model in
its catalog (`kimi-k3`, `glm-5.3`, `deepseek-v4-pro`, `qwen3.8-flash`, `minimax-m3`, `grok-4.7`…;
the ids as in OpenCode's model list, without `opencode-go/`), with its real context window. A model
id the catalog doesn't know yet is sent to the chat completions API with `AI_CONTEXT_WINDOW`. As Go
asks of its clients, requests name Leafdesk in their user agent and carry an `x-opencode-session`
header: the conversation's id in the chat, a new id for every other request. Go's plans have
monthly, weekly and five-hour spending limits, which AI properties updating many rows can use up.

In Docker, a model running on the host is at `AI_BASE_URL=http://host.docker.internal:11434/v1`
(Ollama) or `http://host.docker.internal:1234/v1` (LM Studio). The server log says which provider
and model it uses at startup (never the key), and Settings → General → AI shows them.

**Writing assistant.** Select text and choose *Ask AI* in the formatting toolbar, or type `/` and
pick *Ask AI*, *Continue writing* or *Summarize page*. On a selection: improve writing, fix
spelling and grammar, make shorter, translate (choose the language), or type your own
instruction. The answer streams into a panel; *Replace selection* or *Insert below* adds it to the
page, *Try again* asks again and *Discard* (or Escape) drops it. *Stop* cancels the request. Before
a suggestion is added, the page's current version is saved in its history ("Before AI assistant
edit"), and the change is an ordinary edit everyone sees live, which Undo takes back. Only people
who may edit a page can use it there.

**AI properties.** In a database, *+* → *AI autofill* adds a text property that AI fills in; any
text property's menu has *AI autofill…* too. It can write a summary of each row's page, a
translation of the row's name, page content or another property, or follow your own prompt, where
`{Property name}` stands for that property's value of the row and `{title}` for its name
(optionally with the row's page content). Values are ordinary text: filters, sorting, CSV export,
the REST API and MCP see them like any other text, and people can still edit them. They are worked
out in the background, when the property is added, when you hover a cell and click *Update with
AI* (or on a row's page), with *Update all rows in this view* in the property's menu, and, if you
tick *Update when the row changes*, a few seconds after a row's values or page change (only when
what the value depends on changed). Cells show when a value is being worked out or failed, and
why. Turning AI autofill off leaves the values as plain text.

**AI chat.** *Ask AI* in the sidebar opens the chat across the page, where the sidebar lists
your conversations (today, yesterday, the last 7 and 30 days, older) in place of the pages until
*Back to pages*. The ✨ button in a page's header opens the chat in a panel beside the page, which
stays open as you move between pages and can be expanded to the full page. A source clicked in the
full page opens its page with the conversation carried on in the panel. Questions are answered from the pages
you can read. Nothing is searched for the model: each question goes to it with a map of what you
can open (the databases with their properties, types and options, statuses by group, and the
pages, up to 8,000 characters), and the model decides what to look at. It can search
(`search_pages`, full-text and, with embeddings, by meaning), read a whole page (`read_page`; a
database reads as its properties and its first 200 rows with their values) and list the rows of a
database that match filters on its properties (`query_database`, the same filters and sorts as
the MCP tool, each row a source to cite), up to six turns per question; greetings are answered
without tools. A database row found by a search comes with its database and its values (those the
person may see). The chat's full-text search finds pages with any of the search's words (as
prefixes, so "ekstreleri" finds "ekstresi"; question words such as "what" or "nedir" left out),
titles first, where the search box wants all of them. While an answer is written, the steps it
takes are listed above it (searches with how many pages they found, pages read, databases
queried, what the model says before them) with a running clock, then folded into how long it took; they are kept with the
conversation. Answers cite their sources as numbered
links to the page, and to the block the passage starts at when it is known. *Answer from* → *This
page and its subpages* keeps questions to the page you are on. *Stop* ends an answer; what was written so far
is kept. Under an answer are *Copy*, *Answer again* (the latest) and its time; hovering a question
shows its time, *Edit* (the latest: answered again in its place) and *Copy*. An answer that
changed things can't be answered again or edited. Conversations are private to you and listed in the full-page chat's sidebar and under
the panel's *Conversations*, where you can delete one or all; up to 50 per workspace are kept (the oldest go first), 40 questions each, 4000
characters a question. They are deleted when you leave the workspace or delete your account. The
chat is off while offline and when AI is off for the workspace. Every question counts against
`AI_RATE_LIMIT`; the model's extra turns count against `AI_WORKSPACE_RATE_LIMIT`.

**Changes from the chat.** The chat can add a database row (`create_row`, with its values and
text), change a row's values or title (`update_row`) and add a page under a page, or a private one
at the top of the workspace (`create_page`), as you and only where you may edit (and, with
*Answer from* a page, only under it). What it may do is picked under the question box and
remembered in the browser: *Ask* (the default) shows each change in the box's place before it is
made (what, where, the values and the start of the text) with *Yes*, *Yes, and don't ask again*
(the mode becomes *Auto*) and *No*, also as 1, 2, 3 on the keyboard (Escape says no); *Auto* makes
changes without asking; *Read only* doesn't offer the model changes at all. A change is checked
(the target, your edit access, the values) before you are asked; nothing is written while it
waits, and stopping the answer, leaving the page or 15 minutes without an answer leave it unmade.
Changes made, declined or failed show among the answer's steps with links, are kept with the
conversation (also when the answer itself didn't come), and later questions know them.

**Privacy.** Requests run as the person who asked, with their access at the time: the assistant
works only on pages they may edit, an AI property sends only the row values they can see, and the
chat and semantic search only find and read pages they can open, checked again on every search and
every `read_page` call (a page whose access was taken back mid-conversation can't be read any
more, and its old citations no longer show its title). Nothing is sent without someone asking
(automatic updates follow an edit and run as its author; indexing for semantic search sends page
text to the embeddings endpoint in the background). Owners can turn AI off for a workspace in
Settings → General → AI, which stops all AI features there and deletes its semantic search index. The server logs each request's feature, model, token counts and cost, never its content.
With a hosted provider, what is sent is subject to that provider's terms; a local model keeps
everything on your machines.

**Limits.**

| Variable | Default | |
| --- | --- | --- |
| `AI_MAX_INPUT_CHARS` | 48000 | Characters one request may send; a longer selection is refused, a longer page is cut |
| `AI_MAX_OUTPUT_TOKENS` | 2048 | Tokens one answer may have |
| `AI_TIMEOUT_SECONDS` | 60 | |
| `AI_RATE_LIMIT` | 20 | Requests per person per minute |
| `AI_WORKSPACE_RATE_LIMIT` | 120 | Requests per workspace per minute, AI property values included (they wait for their turn) |
| `AI_CONCURRENCY` | 2 | AI property values worked out at the same time |
| `AI_CONTEXT_WINDOW` | 32768 | Context size assumed for OpenAI-compatible and local models |

### Semantic search

With an embeddings model, search also finds pages by meaning ("car" finds a page about
automobiles): in the search dialog (such results are marked *Similar meaning*), the chat, MCP
`search` and REST `GET /search` (each result says `match: "text"` or `"semantic"`). The two
rankings are merged by reciprocal rank fusion. Without an embeddings model, or with AI off for the
workspace, search is exactly the full-text search.

```bash
AI_EMBEDDINGS_MODEL=text-embedding-3-small   # or nomic-embed-text with Ollama, etc.
# AI_EMBEDDINGS_BASE_URL=https://api.openai.com/v1   # default: the chat provider's endpoint
# AI_EMBEDDINGS_API_KEY=...                          # default: AI_API_KEY on the chat provider's endpoint
# AI_EMBEDDINGS_DIMENSIONS=512                       # for models that can shorten their vectors
# AI_EMBEDDINGS_MIN_SIMILARITY=0.3                   # lowest cosine similarity that counts as a match
```

Embeddings use an OpenAI-compatible `/embeddings` endpoint: the chat provider's by default
(OpenAI, Google, local servers; Anthropic and OpenCode Go have none, so set
`AI_EMBEDDINGS_BASE_URL`). A good `AI_EMBEDDINGS_MIN_SIMILARITY` depends on the model; raise it if
unrelated pages show up, lower it if too few do.

**Indexing.** Each page's title and text (a database row's values too) is cut into chunks of
about 900 characters along its blocks, and each chunk's embedding is stored in `page_chunk` with
its model, dimensions and a hash of its text. Pages are indexed in the background a few seconds
after they are edited, created, renamed or restored, or a row's values change; only chunks whose
text changed are embedded again. A workspace's first search after a restart starts a sweep that
indexes pages the index missed (at most every ten minutes); `pnpm search:index [workspace-id…]`
indexes everything at once, e.g. after setting `AI_EMBEDDINGS_MODEL` or changing the model. Jobs
respect `AI_CONCURRENCY` and `AI_WORKSPACE_RATE_LIMIT`. Trashed pages drop out of results at once
(their chunks stay for a restore); deleted pages take their chunks with them.

**Access** is never stored in the index: every search filters the chunks to the pages the person
can open right now (`page_access_level`) before ranking them, so guests only find what was shared
with them and private pages stay private.

**Scaling.** Vectors are stored as `real[]` and ranked with a small SQL function
(`embedding_cosine`), so any PostgreSQL works without extensions. Each search compares the query
with every chunk of the pages the person can open, which is fine up to some tens of thousands of
chunks per workspace. For larger workspaces, install [pgvector](https://github.com/pgvector/pgvector),
add a `vector(n)` column filled from `embedding` (one model and dimension per column) with an HNSW
index (`vector_cosine_ops`), and order the `ranked` step of `src/server/semantic-search.ts` by
`embedding <=> query` over a larger candidate set before the access filter's final cut.

## Agents

An agent is an AI helper of a workspace with a name, an emoji, a description and instructions of
its own. An automation's *Run an agent* action starts it: when the automation runs on a row, the
agent gets its instructions, the action's task, what happened to the row and the row itself, and
works on it. An event a connection receives can start it too (see [Connections](#connections)).

**Its own user.** Each agent acts as a user of its own: a bot user that can't sign in (its address,
`agent-<id>@agents.leafdesk.invalid`, can't receive mail), added to the workspace as a guest. Like
any guest it sees only the pages shared with it, never through teamspaces, groups or "everyone",
and its changes, comments and page history show its name. It never gets full access, so it can't
share pages or manage databases.

**Sharing pages with it.** Share a page with an agent at view, comment or edit, as with a person;
the pages and rows under it follow. Sharing needs full access to the page. An agent reads and
changes a database's rows only with access to the database; saving an automation that runs an
agent shares that database with it at edit access, unless it already has that much. That access is
taken back once no automation of the database runs the agent (a share you set yourself in the
agent's settings stays).

**What a run may do.** Search and read what is shared with the agent, query its databases, and
change or comment on the row that started the run, nothing else. When a member's change started
the run, the agent is also held to what that member may: it opens, reads and changes only the pages
and property values both of them can, so a run never hands someone what they couldn't open
themselves. A run takes at most 8 model turns,
makes at most 5 changes and comments, and lasts at most 2 minutes. Runs are queued and done a few at
a time (`AI_CONCURRENCY`), each turn within the workspace's AI allowance
(`AI_WORKSPACE_RATE_LIMIT`): a run waits for its turn rather than failing. Each run is kept for
30 days after it finishes, with what the agent did step by step, its final answer, the tokens it
used, and why it failed (`aiOff`, `agentDisabled`, `noAccess`, `rowGone`, `provider`, `timeout`,
`tooManyAttempts` or `error`).

**AI must be on.** Agents use the chat model: the server needs an AI provider (see
[AI features](#ai-features)) and the workspace must have AI on. Otherwise runs end as `aiOff`.

**No chains.** Changes and comments an agent makes don't start automations, so agents and
automations can't set each other off.

**Managing agents.** In Settings → *Agents*, owners of the workspace create, change, pause,
archive and restore agents, choose what is shared with them and look through their runs; members
see the list without the agents' instructions. A run's steps, answer and error show only to owners
who can open its row. Where an agent acted, it shows as an agent: its icon in *Created by* and
*Last edited by*, "(agent)" after its name on comments and in page history. A comment an agent
writes about the whole row rather than about some of its text says *About this page* in the
comments panel, at the top of the list. A
workspace has at most 50 agents. A paused agent doesn't run: its queued runs end as
`agentDisabled`. Archiving one also unshares every page shared with it (each recorded in the audit
log as a removed permission) and takes it off the lists;
its user stays, so what it did keeps its name. A restored agent comes back paused, with nothing
shared. Creating, changing and archiving agents is recorded in the audit log. Over MCP:
`list_agents`, `get_agent`, `create_agent`, `update_agent`, `archive_agent`, `restore_agent`,
`set_agent_access` and `list_agent_runs`. The REST API has no agent endpoints.

> [!WARNING]
> Anything shared with an agent can end up in the rows it writes: a value it copies, a summary in
> a comment. Everyone who can open those rows sees it, even when they can't open the page it came
> from. Share with an agent only what everyone who sees its database may see.

**Built-in agents.** Settings → *Agents* → *Start from a template* sets one up on a database in one
step: it creates the agent with instructions in your language that name the properties you pick
(creating a property or option when you ask), shares the pages it reads at view, and adds the
automation that runs it on every new row.

- **Ticket router** sets the select, status or person properties you pick by rules you write, and
  says why in a comment.
- **Request answerer** looks for the answer in the pages you pick, writes it as a comment with its
  sources, and sets a select or status to "answered" or "needs a person".
- **Duplicate finder** looks for similar rows in the same database and, when it finds some, names
  them in a comment and ticks a checkbox.

## Connections

A connection links a workspace to a service its agents may use: any remote MCP server (Slack,
GitHub, a CRM, another Leafdesk...). It is the other way round from *Connected apps*, where outside
AI apps use Leafdesk; here Leafdesk's agents use the outside service. Owners of the workspace manage
connections in Settings → *Connections*; members and guests don't see them. A workspace has at most
20.

**Adding one.** Give it a name and the server's URL (Streamable HTTP), and how it signs in:

- **OAuth**: Leafdesk registers itself with the server (dynamic client registration), sends you to
  the service to approve access (with PKCE), and keeps the tokens it gets back, refreshing them as
  needed. Who signs in decides what the agents can reach there: they act as that account.
- **Token**: an API key or personal token, sent as `Authorization: Bearer <token>`.
- **None**: for servers that need nothing.

Changing a connection's address signs it out, and starts it over as a new server: a token must be
pasted again (a token is never sent to an address it wasn't given for), its tools are listed
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

- A *read* tool runs at once when the agent calls it, except on a row an anonymous form answer
  added (or a visitor outside the workspace): no member stands behind what that row says, so there
  every tool waits as a *write* tool does.
- A *write* tool doesn't: the run waits, and every owner of the workspace gets an item in their
  inbox (and the run shows it in Settings → *Agents* → *Runs*) with the agent, the tool and its
  exact input. An owner **approves** (the call is sent as is), **declines** (the agent hears no and
  goes on), or **sends it back with a note** (the agent gets the note and tries again, which may
  ask again). After 24 hours with no answer the run ends as `approvalTimeout` and nothing is sent;
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
reads what is shared with the agent but changes nothing in Leafdesk by itself; it acts through
its connection tools, with approval as above. The *Events* tab lists what came in over the last 7
days and what happened to each.

**Audit.** Adding, changing, signing in to and removing connections, tool classes, agents' tools,
triggers, every connection tool call (with its input, who approved it and the outcome) and every
approval answer are recorded in the audit log. Over MCP: `list_connections` and
`set_agent_connection_tools`; connections are added and signed in to only in the settings.

> [!WARNING]
> An agent with a connection acts as the account that signed in. Allow it only the tools it needs,
> keep anything that changes data as *write*, and remember that an event's body is text a stranger
> may have written: an agent can be talked into asking for things, which is why write tools wait for
> a person.

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

The tools cover:

- **Finding things:** `list_workspaces`, `list_teamspaces`, `search`, `list_pages`, `list_recent_pages`, `list_users` (with when each member joined), `list_groups` (member groups with their members and teamspaces).
- **Members:** `invite_member` adds someone to a workspace by email, as Settings → Members does
  (owners only, and not for read-only apps): someone with an account joins right away, anyone
  else gets an invitation, whose link is returned too.
- **Teamspaces:** `create_page`, `create_database` and `move_page` take a `teamspace_id` for
  top-level pages (`"private"` for the user's private pages). Without one, a page an AI app
  creates at the top is private to the user, so nothing an app makes is shared before they
  decide; the user moves it to share it.
- **Pages:** `get_page`, `create_page`, `update_page`, `move_page`, `duplicate_page` (a copy with
  everything under it, beside the original), `archive_page`, `list_trash`, `restore_page`.
  `list_pages` with `favorites: true` lists the user's starred pages, and `get_page` says whether a
  page is starred. `update_page` sets the cover: an uploaded file's URL, an https image link or
  `gradient:<name>`, with `cover_position` for the band of an image that shows. Wherever a tool takes an id, a Leafdesk link the user pasted works too
  (`https://…/w/<workspace>/p/<page>`, `?view=<view>` for a view).
- **Page history:** `list_page_history`, `get_page_version`, `diff_page_version`, `restore_page_version`.
- **Templates:** `list_templates`; `create_page` and `create_database_row` take a `template_id`.
- **Comments:** `list_comments`, `add_comment` (start a thread on quoted text, or reply). A thread
  about the whole page, as agents write them, comes back with `about_page: true` and no quote.
- **Mentions:** page bodies read and write mentions as Markdown: `[Title](/w/<workspace>/p/<page>)`
  for a page, `@Name` for a person, `@YYYY-MM-DD` for a date (see `src/lib/mentions.ts`).
- **Inbox:** `list_notifications`, when the user also grants the `notifications:read` permission.
- **Files:** `attach_file` uploads an image, video, audio or other file to a page (or, with
  `property`, to a row's files & media property) from a public URL or base64 data, when the user
  also grants the `files:write` permission. Files properties can only be set to files already
  uploaded to the workspace. URLs that lead to
  private or loopback addresses are refused. `get_file` reads a file back: text files and PDFs (their
  text layer) as text, PNG, JPEG, GIF and WebP images as images, anything else as a description with
  its link. It needs no extra permission: the user reads a file when they can see a page showing it.
- **Databases:** `get_database`, `query_database`, `create_database`, `create_database_row`,
  `create_database_rows`, `update_database_row`, `update_database_rows`, `add_database_property`
  (including one- or two-way relations), `set_sub_items`, `set_dependencies`, `update_database_property`,
  `change_database_property_type` (converts the values in every row; `dry_run` counts what would
  convert and what would be cleared without changing anything), `delete_database_property`,
  `create_database_view` and `update_database_view` (table, board, calendar, gallery, list,
  timeline, chart or form, including a form's public link; a chart over a date takes `accumulate`
  for running totals or a burndown, and table, list and timeline views take `sub_items`;
  `update_database_view` also moves a
  view's tab with `before_view_id` or `after_view_id`), and `set_property_access` (who may
  see and change a property).
- **Automations:** `list_automations`, `create_automation`, `update_automation`,
  `delete_automation` and `list_automation_runs` (see
  [Automations and webhooks](#automations-and-webhooks)). They need full access to the database;
  properties are named by name or id and people by id, email, name or `"me"`, and
  `list_automations` shows names next to the stored ids. A `run_agent` action names an agent
  by id or name.
- **Agents:** `list_agents`, `get_agent` (its instructions and the pages shared with it),
  `create_agent`, `update_agent`, `archive_agent`, `restore_agent`, `set_agent_access` (view,
  comment, edit or remove) and `list_agent_runs` (each run's steps summarized). Owners manage
  agents; members can list them (see [Agents](#agents)).

An app only ever sees the pages its user can see. Read-only apps can't call the tools that
change anything, and a workspace's owners can let apps only read it, or hide it from them (see
[Workspace security switches](#workspace-security-switches)).

## REST API

Scripts and other programs can use the REST API under `<APP_URL>/api/v1` with a personal access
token. The reference is at `<APP_URL>/docs/api`, generated from the OpenAPI 3.1 document at
`<APP_URL>/api/v1/openapi.json` (import it into Postman, Insomnia or a client generator).

Create a token in My account → *Connected apps* → *Personal access tokens*: give it a name, choose
**Read only** (`pages:read`) or **Read and write** (`pages:write` too), optionally limit it to one
workspace, and pick when it expires (7, 30, 90 days, a year, or never). The token is shown once;
Leafdesk keeps only its SHA-256 hash. Tokens look like `esi_` and 40 letters and digits, so secret
scanners can match leaked ones with `esi_[A-Za-z0-9]{40}`. The list shows when each was last
used; revoking one stops it at once.

```bash
curl http://localhost:3000/api/v1/workspaces -H "Authorization: Bearer $LEAFDESK_TOKEN"

curl -X POST http://localhost:3000/api/v1/databases/<database_id>/query \
  -H "Authorization: Bearer $LEAFDESK_TOKEN" -H "Content-Type: application/json" \
  -d '{"filters": [{"property": "Status", "op": "equals", "value": "Done"}], "limit": 20}'
```

- **Account and workspaces:** `GET /me`, `GET /workspaces`, `GET /workspaces/{id}/teamspaces`, `GET /workspaces/{id}/groups`,
  `GET /workspaces/{id}/pages` (`teamspace_id` narrows it to one teamspace, or `private`).
  `POST /pages` and `POST /pages/{id}/move` take a `teamspace_id` for top-level pages, as the MCP
  tools do.
- **Pages:** `GET /search`, `POST /pages`, `GET` and `PATCH /pages/{id}` (title, icon, cover,
  Markdown body replaced or appended), `GET /pages/{id}/children`, `POST /pages/{id}/move`,
  `/archive` and `/restore`.
- **Databases and rows:** `GET /databases/{id}` (schema), `POST /databases/{id}/query` (filters,
  sorts, a saved view, cursor pagination), `POST /databases/{id}/rows`, `POST
  /databases/{id}/rows/bulk` (up to 100), `PATCH /databases/{id}/rows` (same values on many rows),
  `GET` and `PATCH /rows/{id}`.
- **Comments:** `GET` and `POST /pages/{id}/comments`.

Automations and agents have no REST endpoints: they are managed in the app or over MCP.

The API and the MCP server share one service layer (`src/server/operations.ts`), so they check
input, access and history the same way: a token acts as its user, with that user's own access to
pages, and every body change is saved to page history first. Pages the user can't see (or outside
a token's workspace) answer `404`. Errors are JSON, `{"error": {"code", "message", "details"}}`;
lists page with `next_cursor`. Each token may make 180 requests a minute (`API_RATE_LIMIT`;
`X-RateLimit-*` headers, `429` with `Retry-After` beyond it), and request bodies are limited to
5 MB. Only tokens authenticate (never the browser session), and CORS is off unless
`API_CORS_ORIGINS` lists origins. Like connected MCP apps, tokens are not held back by a
workspace's "require two-step verification" policy: it guards browser sessions. They are held to
its **Connected apps and API tokens** switch: in a read-only workspace write endpoints answer
`403` (`forbidden`), and a workspace with it off answers `404` like one the user isn't in (see
[Workspace security switches](#workspace-security-switches)).

## Development

Requirements: Node.js 24 and pnpm 11 (via `corepack enable`), plus Docker for PostgreSQL.

```bash
pnpm install
cp .env.example .env      # set BETTER_AUTH_SECRET
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
| `pnpm search:index [workspace-id…]` | Builds or catches up the semantic search index (see [Semantic search](#semantic-search)) |
| `pnpm tsx scripts/access-e2e.ts` | End-to-end checks against the database for page permissions, guests and publishing. The other `scripts/*-e2e.ts` files do the same for their areas (teamspaces, membership policies and join requests, databases, filters, bulk actions, AI features, semantic search and AI chat (with a stand-in OpenAI-compatible server), property types, people, trash and its retention, views, formulas, charts, forms, inline databases, publishing options, sites and duplicating published pages, presence, offline editing, uploads, import, Notion import, export, the search box's filters, backlinks and unlinked mentions, the graph, and `roundtrip-e2e.ts` for an export imported again); `mcp-e2e.ts` and `auth-e2e.ts` below need a running server. |
| `pnpm tsx scripts/sw-e2e.ts` | Checks the service worker (`public/sw.js`) in headless Chrome against a stand-in server: offline pages, per-user copies, the offline page (set `CHROME_PATH` outside macOS) |
| `pnpm tsx scripts/mcp-e2e.ts` | End-to-end OAuth + MCP check against a running server (see the header of the file) |
| `pnpm tsx scripts/api-e2e.ts` | End-to-end REST API check (tokens, every endpoint, access, rate limits, OpenAPI) against a running server |
| `pnpm tsx scripts/security-switches-e2e.ts` | End-to-end check of the workspace security switches (export, publishing, connected apps) through the settings action, the export and public routes, MCP and the REST API, against a running server |
| `pnpm tsx scripts/auth-e2e.ts` | End-to-end password reset check against a running server with SMTP pointed at [Mailpit](https://mailpit.axllent.org) |
| `pnpm tsx scripts/two-factor-e2e.ts` | End-to-end two-step verification check (sign-in challenge, recovery codes, workspace policy) against a running server |
| `pnpm tsx scripts/admin-e2e.ts` | End-to-end instance administration check (`ADMIN_EMAILS`, `WORKSPACE_CREATION`, signing out, required password resets) against a running server with the same two settings; it signs everyone out, so only on a development or CI database |

CI (`.github/workflows/ci.yml`) runs every `scripts/*-e2e.ts`, the ones that need a server against
`pnpm start`; each step there shows the settings its script needs.

## Languages

The interface is available in English, Turkish (Türkçe), German (Deutsch), Spanish (Español) and
French (Français). Each person picks a language in My account → Language, stored per browser;
without a choice the app follows the browser's `Accept-Language` and falls back to English. Dates
and numbers are formatted for the language. Emails go out in the recipient's language: the one they
last picked in My account → Language, else their browser's when they first signed in, stored with
their account (signing in on another device doesn't trade a picked language for that browser's). Until they have signed in once since, and for invitations to addresses without
an account, emails use the language of whoever caused them. The editor's own menus use [BlockNote](https://www.blocknotejs.org)'s dictionaries (Turkish is
ours, in `src/i18n/blocknote/tr.ts`).

Texts live in `src/i18n/messages/<locale>/*.json` (app, `email.json`, `templates.json` for the
built-in templates), in ICU MessageFormat. English is the source: `pnpm i18n:check` (also part of
`pnpm test` and CI) reports what each language lacks or gets wrong, and anything missing shows in
English. Adding a language is a new folder of JSON files plus one line each in
`src/i18n/config.ts` and `src/i18n/blocknote/index.ts`. Translations are welcome as pull
requests; see [CONTRIBUTING.md](CONTRIBUTING.md#translations) for the workflow.

## Architecture

- A single Node process (`server.ts`) serves Next.js (App Router) and the Hocuspocus
  collaboration server on the `/collab` WebSocket path.
  - Route handlers, server actions and MCP tools write into open documents through the same
    Hocuspocus instance, so AI edits appear live in open editors.
  - The `/collab` connection is authenticated with a short-lived HMAC token.
- Page access is worked out in SQL (`page_access_level`, migrations `0003`, `0013`, `0021`):
  every read path (sidebar, search, mentions, export, MCP, REST, collaboration) filters with it.
  A page's teamspace is stored on every page of its tree (`page.teamspace_id`, kept in step by
  triggers); null means private.
- The Yjs document is the source of truth for page content. On every save, the app also stores
  derived markdown and plain text in PostgreSQL for search and MCP reads.
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
  stored per person in `ai_conversation`.
- Auth is Better Auth: email/password, GitHub/Google, two-factor and passkey plugins for people,
  and the OAuth provider, JWT, MCP and CIMD plugins for apps. Data access uses Drizzle ORM on PostgreSQL 18.

## Security

Please report vulnerabilities privately, not in a public issue: [SECURITY.md](SECURITY.md) says
how, what is in scope, how quickly we answer and which versions get fixes (the latest release).
It also lists the settings that matter when you run Leafdesk on a server.

## License

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE).

## Trademarks

Notion is a trademark of Notion Labs, Inc. Leafdesk is an independent project, not affiliated with,
endorsed by or sponsored by Notion Labs, Inc. The name appears only to describe what Leafdesk is an
alternative to and what it imports from. Obsidian is a trademark of its owner; Leafdesk is not
affiliated with it either, and names it only to describe what it imports.
