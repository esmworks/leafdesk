# Changelog

## Unreleased

### Added

- **Footnotes.** `/footnote` puts a number in the text and opens its note; hovering the number
  shows the note. Notes are plain text, and footnotes count in the order the page has them. The
  page lists its notes under the body (a number there goes to its place in the text), and
  published pages and the PDF list them at the end, linked both ways. Markdown, MCP and the API
  read and write them as `[^1]` with `[^1]: The note.` lines at the end, and so does the AI
  assistant: rewriting, translating or continuing text keeps its footnotes, and its inline
  equations, instead of running them into the sentence. Word footnotes and endnotes import as
  footnotes instead of a list at the end of the page.
- **Callouts hidden when printing.** *Hide when printing* in a callout's block menu keeps it on
  screen and leaves it out of the PDF and of what the browser prints, for notes that shouldn't
  reach a printout. The callout shows a small mark while it is hidden. In Markdown it is the line
  `<!-- leafdesk:no-print -->` right before the callout.

- **Your own AI keys.** With `OWN_AI_KEYS_ENABLED`, everyone can add AI accounts to their Leafdesk
  account in Settings → Apps → AI: a provider (Anthropic, OpenAI, Google Gemini, OpenCode Go or an
  OpenAI-compatible server), a model and the key, tried with a tiny request before it is kept and
  never shown again, plus optional models for semantic search and voice notes. A workspace runs all
  its AI on one owner's account, picked in Settings → General → AI; a new workspace takes its
  creator's default account, so one key serves all of someone's workspaces. Without an account a
  workspace uses the server's AI settings, or has no AI with `AI_ONLY_OWN_KEYS`. When the account's
  owner leaves or removes it, the workspace falls back and its other owners are told. Semantic search
  indexes each workspace with its own embeddings model. An OpenAI-compatible server must be on a
  public https address unless listed in `AI_ALLOWED_HOSTS`.
- **Email on database rows.** Owners turn it on in Settings → Email and pick the databases mail
  lands on, in order, with the email properties that hold addresses; each member connects their
  own mailbox for that workspace (Google Workspace and Gmail, Yandex, Zoho or any IMAP and SMTP
  server, with an app password). Mail whose other party is a row's address, or that answers mail
  already on a row, shows in the row's new Email section to everyone who can see the row and its
  address; the rest of the mailbox is never read past its headers. Whoever may edit the row writes
  new mail and replies there in plain text, sent from their own mailbox and kept in its sent
  folder. Mail that comes in tells the mailbox's owner and the row's followers, in the inbox's new
  Email tab and by push. `MAIL_ALLOWED_HOSTS` lets mailboxes reach mail servers on a private
  network.
- **Own file storage, turned on with `OWN_STORAGE_ENABLED`.** With it on, people connect storage
  to their own account once, under Account → Apps → Connected storage: an S3-compatible bucket
  (AWS S3, Cloudflare R2, Backblaze B2, MinIO…), or a sign-in to Google Drive or Dropbox once the
  server's administrator has registered their apps (`STORAGE_GDRIVE_*`, `STORAGE_DROPBOX_*`).
  Each is tried with a test file before it is kept. Owners pick one for a workspace in the new
  Settings → Storage, and the first one connected is the default new workspaces use from the
  start. One storage serves many workspaces, each in a place of its own (its own Drive folder in
  a "Leafdesk" folder, its own prefix in a bucket or the app's Dropbox folder). The workspace's new
  uploads go there, served by Leafdesk as before so the storage stays private, and count against
  no workspace quota. Storage that refuses shows as not working with its answer. Drive files sit
  only in folders Leafdesk made (the `drive.file` scope), and expired sign-ins are refreshed and
  kept. Endpoints are reached only over https on public addresses; `STORAGE_ALLOWED_HOSTS` lists
  storage on a private network. While the setting is off nothing can be connected and nothing is
  shown, and workspaces connected before keep working.
- **Files move out of storage whose owner goes.** When the person whose storage holds a
  workspace's files leaves it, is removed, deletes their account or disconnects the storage, the
  files move in the background to another owner's default storage, or to the server's storage
  when that is S3 and they fit the workspace's quota (never onto the server's disk). Leaving is
  refused while they have nowhere to go; someone removed leaves a blocked move the owners see.
  Files stay readable throughout, the old copies are deleted once every file is across, moves
  resume after a restart, and progress and failures show in Settings → Storage, where owners can
  also move all files themselves.
- **Excel workbooks show in place.** An .xlsx file in a page shows its cells read-only, with the
  sheet's row numbers and column letters and a tab for each sheet (the first 200 rows and 40
  columns of a sheet; workbooks up to 10 MB). Published pages show them too. *Turn into a
  database* opens the import with the workbook chosen, to import one of its sheets as a new
  database.
- **Search finds the words inside Excel workbooks.** Full-text search, the AI chat's semantic search
  and the MCP `search` read the workbooks pages show, as they read PDFs and Word documents.
  Workbooks uploaded earlier are read by the background sweep, and pages are indexed for the AI
  chat again in the background so their workbooks go in. The MCP `get_file` tool reads a workbook
  as text, sheet by sheet. A workbook whose contents unpack to more than 64 MB isn't read.
- **File viewer.** Uploaded files open full screen without downloading them: from an image (a
  click on a read-only or published page; the expand button or a double click while editing), a
  file block's name, the expand button of a PDF or workbook, and a files & media property. ← and →
  go through the other files of the page or cell, Esc closes, + − and 0 zoom; on a phone, swipe
  between files and pinch to zoom. Images (SVG included, as a picture whose scripts don't run)
  zoom and pan, PDFs and workbooks fill the screen, video and audio play, Word documents show
  their text, tables and pictures, CSV and TSV show as a table of their first 1,000 rows, Markdown
  shows formatted without its raw HTML or remote pictures, JSON and code show colored, and other
  text shows as is (the first 2 MB). Anything else shows its name, type and size with a download
  button.

### Changed

- **The sidebar names its buttons.** The AI chat has its own row under Home and Today. The footer
  shows Settings and Trash by name, and a More menu next to them holds the people directory,
  skills, templates, import and customizing the sidebar, which used to be a row of icons without
  labels. The people directory is also in the search box's commands.
- **The home page's recently edited pages are a list.** Eight rows instead of twelve cards, each
  showing where the page sits (a row's database, a subpage's page) when you can open it. With
  nothing assigned to you, "Assigned to you" is a single line rather than an empty box, and its
  calendar button says what it does.
- **The full-page AI chat starts in the middle of the page.** A new chat shows a greeting with the
  question box right under it, both near the middle; once you ask, the box moves to the bottom.
  The conversations beside it are one list, newest first, under a Conversations heading.
  Deleting a conversation, or all of them, is now in a ⋯ menu rather than a button you can click
  by accident.
- **Databases made over MCP are named in your language.** Their status and tags properties and
  their first view used to be English whatever language you use Leafdesk in; they now match the
  databases you make in the app.
- In Turkish, teamspaces are now called "ekip alanı".
- **Opening a row beside a view is quicker.** The row panel slides in from the edge it sits on, and
  opening, closing or stepping through rows with J and K no longer redraws every card of a large
  board, table or calendar: only the row that was open and the one now open change.
- **Dragging cards on a large board or calendar is smooth.** Moving a card over columns or days
  used to redraw every card at each step; now only the card being dragged changes.

## 0.6.1 — 2026-10-19

### Upgrading from 0.6.0

- Nothing to do: the server and its database are the same as in 0.6.0. This release brings the
  macOS desktop app that 0.6.0 is missing.

### Fixed

- The macOS desktop app is built and signed for releases again: 0.6.0 shipped without its macOS
  installers because signing failed on macOS 26.

## 0.6.0 — 2026-10-19

### Upgrading from 0.5.4

- **Leafdesk is now licensed under the GNU Affero General Public License v3.0** (AGPL-3.0-only)
  instead of the Apache License 2.0. Using it, running it for your team or your customers, and
  changing it for yourself stay free. What's new is the condition on changed versions: if you
  change Leafdesk and let people use your version over a network, you have to offer them its source
  code under the same license (the About tab in My account links to the source). Releases up to
  and including 0.5.4 stay available under Apache-2.0. Contributions now come under the terms in
  [CONTRIBUTING.md](CONTRIBUTING.md#licensing-of-contributions).
- **Other sites can no longer show Leafdesk in a frame.** Pages, published pages and public forms
  included: every response now says so (`X-Frame-Options: SAMEORIGIN`, and `frame-ancestors 'self'`
  in the pages' policy). A public form or published page put inside another website with an
  `<iframe>` shows an error there instead; link to it.
- **A reverse proxy that sets its own Content-Security-Policy** now adds to the app's: the browser
  enforces both, so drop the proxy's (or make sure it allows at least what the app's does, see
  `src/lib/content-security-policy.ts`).
- **Migrations 0078 to 0085** run automatically when the container starts (from source, run
  `pnpm db:migrate`). Compose users who want to set `SOURCE_URL` (see *Added*) need this
  release's `docker-compose.yml`; nothing else in it changed. 0078 adds a column to `page_link`;
  after the upgrade the server reads each page that links somewhere once, in the background, to
  fill in where its links are. 0079 adds the time zone of calendar feeds (see *Fixed*); feeds made
  before it take their user's zone the next time they open the feed's dialog, and count days in
  UTC until then.
- **Migration 0080 rewrites the `file_text` table once** to give each document's text a search
  vector; the table holds one row per PDF or Word document read so far, so it is quick. Documents
  uploaded before this release are read for search gradually, a couple of hundred per workspace
  at a time as people search; until then their words find nothing.
- **Migration 0081 adds the `journal` and `daily_note` tables** for daily notes.
- **Migration 0082 adds two small tables** for following rows, and columns to `notification` and
  `user_preference`; nothing is rewritten.
- **Migration 0083 adds four small tables** for watching pages, and columns to `user_preference`;
  nothing is rewritten. Existing pages are watched by their creators from the start; people start
  watching other pages as they edit them.
- **Migration 0084 adds the `synced_block_reference` table** for synced blocks (see *Added*);
  nothing is rewritten. It fills in as pages with synced blocks are saved.
- **Migration 0085 forgets single sign-on sign-ins that earlier releases left on record** (see
  *Security*): links to accounts and sessions under a workspace's provider id (`ws-<workspace id>`)
  that are older than the workspace's connection or whose connection is gone, and the sessions
  signed in through those links. As when a connection is removed, the API tokens and connected
  apps of the people they were for are revoked, in all their workspaces; the audit log doesn't
  record it. People are linked again by their address when they next sign in through the
  connection. To see who, before upgrading:

  ```sql
  SELECT DISTINCT u.email, x.provider_id
  FROM (
    SELECT user_id, provider_id, created_at FROM account WHERE provider_id LIKE 'ws-%'
    UNION ALL
    SELECT user_id, sso_provider_id, created_at FROM session WHERE sso_provider_id LIKE 'ws-%'
  ) x
  JOIN "user" u ON u.id = x.user_id
  LEFT JOIN workspace_sso c ON c.provider_id = x.provider_id
  WHERE c.provider_id IS NULL OR x.created_at AT TIME ZONE 'UTC' < c.created_at;
  ```

  A workspace whose connection went with the account of the owner who set it up can still have
  *Single sign-on only* on. Without a connection it holds nobody back, unless the server has its
  own provider (`OIDC_ISSUER`), which it then sends members to; once a new connection's domains
  are verified it applies again. Removing a connection turns it off unless the server has its own
  provider, which a migration can't see, so 0085 leaves it to the workspace's owners (Settings →
  Security). These are the workspaces that have it on without a connection:

  ```sql
  SELECT w.id, w.name FROM workspace w
  WHERE w.settings ->> 'loginMethod' = 'sso'
    AND NOT EXISTS (SELECT 1 FROM workspace_sso c WHERE c.workspace_id = w.id);
  ```

### Added

- **Ready-made skills.** The skills library offers six to start from: *Wrap up meeting notes*,
  *Weekly status summary*, *Reply to a customer*, *Proofread a text*, *Triage a request* and
  *Executive summary*. They fill the library while it is empty, and *Ready-made skills* opens them
  after. Picking one makes a private page in your language, already a skill with its description,
  to change and share like any other. None needs setting up: each works on the page, row or text
  it is pointed at. See [Skills](README.md#skills).
- **Small business template.** One click in the template gallery, or *Start with* in *New
  workspace*, sets up the records a small business keeps, linked to each other: *Customers* (stage,
  city, contact person, phone, email, the next step and when, the quotes and jobs that link to them
  and the total quoted), *Quotes* (customer, status from draft to accepted or lost, amount,
  follow-up date, date, valid until, prepared by), *Jobs* (status, priority, assignee, due date,
  customer and the quote it came from) and a *Balance sheet* (each asset or liability on the day it
  is counted, with its net effect), with boards, calendars, charts and row templates for quotes and
  jobs; a *Dashboard* of twelve widgets over all four (open and late jobs, open quotes, this month's
  net worth, follow-ups, jobs by person) and a *Weekly plan*. It starts without example rows, its
  amounts in the currency of your language. A built-in template can now be such a set of pages and
  databases (a kit, `kind: "kit"` in `list_templates`), and `create_page` lists what it made under
  `parts`. Covered in `scripts/small-business-e2e.ts`.
- **Workspace backups.** Owners download the whole workspace as one file in Settings → General →
  *Back up workspace*: every page with its history and comments, databases, files, teamspaces,
  groups, permissions, published pages, the site, agents, automations and daily notes. *New
  workspace → Restore from backup…* brings it back, on this server after the workspace was deleted
  or on another one, with the same ids, so links keep working. People are matched by email; those
  without an account on the server keep their name on what they wrote, and the restore lists them
  to invite. Connections ask to be signed in to again, and since single sign-on is set up again
  too, *Single sign-on only* comes back as *Any method* unless the server has its own provider
  (`OIDC_ISSUER`). See [Backups](README.md#backups).
- **Synced blocks.** *Turn into synced block* in a block's menu (or `/synced block` in an empty
  line) keeps the chosen blocks in one place; *Copy synced block* and a paste on another page show
  them there, live. Editing them in a reference edits the original when you may edit its page, and
  is read-only otherwise; people who can't open the original page see "No access" and none of its
  text. A reference says when the original page is in the trash or deleted, or the blocks were
  removed, and survives the page moving. The original lists the pages showing it, *Unsync* turns a
  reference into a plain copy, and a synced block can't be put inside another. Published pages,
  Markdown and PDF exports, `get_page` (MCP) and skills show the blocks for whoever reads them, by
  the same rules; a published page shows them only when the original page is published too.
  Markdown written over MCP or the API keeps synced blocks as they are and doesn't change their
  text. Duplicating a page, or a page from a template, gives the copy its own synced blocks.
  Search finds a synced block's text on its original page (not on the pages showing it), and a
  version's changes include its synced blocks', as restoring the version brings them back too.
- **A link to the source code for everyone who uses the server.** Published pages and public forms
  now show *Source code* at their foot, for visitors without an account, next to the one in the
  About tab. It leads to the running release's tag, or to `SOURCE_URL` when set: point it at your
  own code if you run a changed Leafdesk for others (see the README).
- **Desktop app for macOS, Windows and Linux.** Download it from the release, enter your server's
  address once, and Leafdesk opens in its own window, with native menus in your language, links to
  other sites in your browser and offline editing as in the installed web app (on HTTPS). A
  self-signed certificate can be trusted by its fingerprint. *On this computer* needs no server at
  all: the app runs Leafdesk and a database of its own on the computer, signed in to its one
  account, and keeps the pages there. What needs other people, email or a public address (single
  sign-on, SCIM, invitations and join requests, guests, new teamspaces and member groups,
  publishing, email and push notifications) is left out there, and its server refuses it
  (`LEAFDESK_LOCAL_MODE`). The sidebar shows the workspace's General teamspace as plain *Pages*,
  and the teamspaces section only for other teamspaces already there. It backs its workspaces up
  once a day into a folder of your choosing (*Documents/Leafdesk Backups* unless you pick another,
  such as one iCloud Drive or Dropbox syncs), keeping the last seven of each; any Leafdesk restores
  them. The app updates itself from GitHub releases. On macOS the window has no title bar: its
  buttons sit at the top of the sidebar, beside the sidebar's own, and the top of the page drags
  it. The macOS app is signed and notarized; the Windows installer isn't signed yet. See *Desktop
  app* in the README.
- **Follow database rows.** People now hear in their inbox when someone else changes a row they
  follow: its properties (a status moved, a date or an assignee changed), its title or its text.
  A row's creator, the people its person properties name, and anyone who comments or is mentioned
  on it follow it; *Follow* and *Stop following* in the row's page menu change that, and stopping
  wins over the rest. One person's burst of edits is one item, sent once they've left the row alone
  for a minute (ten minutes at most), and it says what changed from what to what ("Status: To do →
  Done"), only for the properties each follower may see, checked again when the inbox or the email
  shows it. Rows you follow have their own switches for the inbox, email and push in My account →
  Preferences; push messages name what changed but not the values. `list_notifications` (MCP)
  includes these updates with their changes.

- **Watch pages.** People now hear in their inbox when someone else edits a page they watch, and
  new comment threads on it reach its watchers instead of only its creator. A page's creator and
  everyone who edits it watch it; *Watch* and *Mute* in the page's ⋯ menu change that, and a mute
  wins over the rest. *Watch all pages* in a teamspace's sidebar menu watches every page in it. An
  author's edits go out as one item once they've left the page alone for two minutes (fifteen at
  most), to watchers who can still open the page and don't have it open right then. Emails are held
  back: at most one about the same page every four hours, and after five a day the rest come
  together in one digest. Pages you watch have their own switches for the inbox, email and push in
  My account → Preferences, which also lists the pages and teamspaces you watch. `get_page` (MCP and
  REST) shows `watching`, the new `watch_page` tool and `POST /pages/{page_id}/watch` change it, and
  `list_teamspaces` shows which teamspaces the user watches.

- **Import from Trello.** Import has a Trello tab that takes a board's JSON export (*Print, export
  and share → Export as JSON*) and makes it a database opening on a board grouped by list. Lists,
  labels (in the nearest colors), members (as people when their name matches one person in the
  workspace, else as text), start and due dates, checklists, custom fields, linked attachments,
  descriptions and comments come along; comments go in the row's body under their author and time.
  Nothing is downloaded from Trello, and archived lists and cards are left out.

- **Daily notes.** *Today* in the sidebar opens your note for the day, made the first time under
  *Journal*, a private page of yours where the newest day comes first. The calendar beside it marks
  the days with a note and opens any day's; the home page shows today's note and the ones before
  it; a date mention's menu opens that day's note; and `type:journal` in the search box lists your
  notes. Pick at the bottom of the calendar whether new notes start with a few headings, blank, or
  from one of the workspace's page templates. "Today" is your browser's day. Over MCP,
  `get_or_create_daily_note` and `list_daily_notes`; over the REST API,
  `GET` and `POST /workspaces/{id}/daily-notes`.
- **Board columns can show a calculation.** Next to its name, each column of a board shows how
  many cards it holds; editors can now click that count and have every column show one
  calculation over a property for its cards on the line under its name: the sum of the estimates,
  the average of a score, the earliest or latest due date, how many are checked, and the rest of
  what table footers calculate (formulas and rollups like their result type). Each board view
  keeps its own choice; published boards don't show it.
  Over MCP, `create_database_view` and `update_database_view` set it on boards with `aggregate`
  and `aggregate_property`, as on charts, and describe it with the view.
- **"Linked from" shows every place a page links here.** Each linking page lists the text around
  each of its links (three, then "N more"), and a click opens that page at the block with the link,
  highlighted for a moment; the page's name opens it at its first link. The heading shows how many
  pages link here, and past the first 100 a button lists the next ones. Over MCP, `get_page` gives
  the text around each link (`contexts`) when a page links more than once, and
  `linked_from_truncated` when not every linking page is listed.
- **Links to one block of a page.** "Copy link to block" in a block's menu (the handle beside it)
  copies the page's address with the block's id (`#block-…`), also on a plain-http address. The link
  opens the page scrolled to that block, highlighted for a moment, once the page has loaded; a block
  deleted since opens the page at the top. Published pages and the print view open at the block too
  (any block with text: paragraphs, headings, list items, quotes, callouts, code and tables).
  Pasted on its own into a page, the link becomes a mention of the page that opens at the block,
  marked ¶ after the title, and counts under the page's "Linked from" like any link to it. In
  Markdown read and written over MCP and the API the link keeps its `#block-…` part (in an export,
  a link to a page left out of it does); a mention of a block on a published page links to that block when its page is published
  too. Search results found by meaning open their page at the passage that matched.
- **Comment notifications open their thread.** From the inbox, the email or a push notification,
  the page opens with its comments, the thread selected and the text it is about in view (a
  resolved thread under *All*).
- **Subpages block.** "Subpages" in the `/` menu lists the pages under this one as links, in the
  sidebar's order, and keeps up as pages are added, moved, renamed or trashed. Each reader sees the
  subpages they may open; databases the page already shows inline aren't listed again. Published
  pages and the print view show the list where the block is instead of at the end of the page. In
  Markdown and over MCP it is `<!-- leafdesk:subpages -->` on a line of its own.
- **Search results mark the words you typed** in the text shown under each page, where the search
  found them: at the start of a word, and inside a sentence for Chinese and Japanese.
- **Search looks inside attached PDFs and Word documents.** The search box, MCP's `search` and
  the REST API's `/search` find a page by the words of the PDFs and Word documents it shows, also
  on servers without an embeddings model: every word of the search in one document, after the
  pages that have the words in their own text. The result names the document and shows the text
  around the words. Only documents the page's readers may open through it count, and `in:` and
  `type:` narrow these results like any other. Documents are read in the background once they are
  uploaded.
- **Synced pages.** "Synced page" in the `/` menu shows another page's body inside this one, live:
  people who may edit that page edit it in place and see everyone's changes as they happen, people
  who may only view it (or while it is locked) read it, and people who can't open it see
  "No access", as mentions show them. The page showing it links there, so the shown page lists it
  under "Linked from"; its own search, history, AI review and Markdown hold just one line for it.
  A page that would show itself, directly or through other synced pages, is shown once and then
  as a link with a note; synced pages inside synced pages go two levels deep. Published pages show
  the block as a link to the page (its public address when it is published too). In Markdown and
  over MCP it is the page's link alone on its line followed by `<!-- leafdesk:synced-page -->`,
  which `update_page` keeps.
- **Number formats on formulas.** A formula whose result is a number gets the "Number format"
  menu too: a plain number, a percentage or an amount in a currency, with its decimal places. Its
  values, column calculations, board column totals, charts, dashboard numbers, published pages and
  rollups summing it show the format, and a percentage filters by the percent shown. Formulas
  giving text, a date or a checkbox have none: one is refused, and changing a formula so it no
  longer gives a number drops its format. MCP's `add_database_property` and
  `update_database_property` take `number_format` for formulas, and `get_database` (and the REST
  API's database schema) shows it. The small business kit's balance sheet shows its net effect, and
  the dashboard its net worth, in the kit's currency.

### Changed

- **Wide boards and tables keep their sideways scrollbar in view.** When the columns run past the
  window's edge, a scrollbar stays at the bottom of the window wherever you are on the page, and
  rests under the board or table once you reach its end; it isn't there when everything fits. It
  used to be under the last row or the longest column, so reaching the columns on the right with a
  mouse meant scrolling all the way down first. A board also pans sideways when you drag its empty
  floor between and below the columns.
- **Large databases and workspaces open faster.** Who may see a database's rows is now worked out
  once for the database wherever that gives the same answer, instead of once for every row: with
  50,000 rows a table loads about three times faster, and a filtered or sorted query through the
  REST API or MCP about five times faster. The search box's recently edited pages show at once in a
  large workspace (about two seconds with 5,000 pages before).
- **Webhooks follow the export switch.** With export turned off in Settings → Security, an
  automation can't get a new webhook (`webhookExportOff`), and a webhook saved before sends nothing:
  its runs and its *Test* ping fail with that code until export is turned back on. Calendar feeds
  already stopped.
- **AI autofill leaves out related rows and people.** Relations, rollups, people and created/edited
  by properties, and formulas reading them, are no longer part of what autofill sends to the model:
  they could name rows and people the readers of the filled-in text can't open. A prompt or a
  translation source naming one is refused (`hiddenInput`).
- **The graph opens on what pages say about each other.** The whole workspace's graph now shows
  only the pages joined by links and relations; the page tree and pages joined to nothing are a
  switch away (around a focused page they still show). A row related to a page in view comes out of
  its database's bubble, so the line says which customer an order is for, unless more than 30 rows
  of that database would. With fewer than 10 links and relations in the workspace, the graph says
  how to add them. It no longer has a button in the sidebar: it opens from a page's graph (*Show in
  graph*, then *Open in the full graph*) or from search.

### Fixed

- **Saving the SSO connection no longer undoes a change made meanwhile.** A save waits for the
  identity provider's discovery document (up to ten seconds), then wrote what it had decided from
  the connection as it was before: domains verified in the meantime were unverified again, and
  when another identity provider had been saved in the meantime, the old one came back with its
  domains verified without a new check, and the sign-ins made through the other one stayed
  instead of being ended. Such a save now fails, saying the connection changed meanwhile.
- **Changing a property's type could undo a cell saved at the same moment.** A value saved in that
  column while the change was being made was replaced by what the older value became; a formula or
  rollup froze from the cells as they were before. The change now reads the rows when it writes
  them and holds them until it is done, so a cell saved meanwhile is the one converted. Changing a
  property that someone else changed in the meantime now starts over from their version.
- **A session length over 400 days broke sign-in.** With `SESSION_MAX_AGE_DAYS` between 401 and
  3650, which the docs allowed, every email sign-up and sign-in failed with a server error: the
  session cookie would have outlived the 400 days a browser keeps one. Sessions are now capped at
  400 days, and a longer setting is read as 400.
- **Imported ZIPs garbled non-English file names** when the tool that made them (macOS's
  *Compress* among them) didn't mark the names as UTF-8: "Çalışma planı.md" came in as
  "Ã‡alÄ±ÅŸma planÄ±.md". Such names are now read as UTF-8 whenever they are valid UTF-8.
- **"Linked from" counted at most 100 pages.** The count now covers every page linking here that
  you can see.
- **Blocks nested under a callout stay inside it in Markdown.** A callout's nested blocks (a list,
  an equation, another callout) were written after it, outside the `> [!NOTE]` quote, so Markdown
  and ZIP exports showed them outside the callout, and an AI app that read a page and wrote it back
  with `update_page` (or replaced the callout with `replace_block`) moved them out of it. They are
  now quoted with the callout, a callout inside a callout as `> > [!NOTE]`, and come back where
  they were.
- **Quotes and toggle lists keep their shape in Markdown.** A quote's nested blocks were written
  after it, outside the `>`, and a quote holding a list came back as one line of text with the list
  run into it; toggle list items were written as plain bullets. So exports lost them, and an AI app
  that read a page and wrote it back with `update_page` (or `replace_block`) turned toggles into
  bullet lists, such as a voice note's "Transcript", and quotes into flat text. Quotes now keep
  their nested blocks inside the `>` and read lists, equations and other quotes in them back as
  nested blocks, and toggles are written as `<details>` with their text in the `<summary>`, so they
  come back as toggles with everything that was nested under them. A callout under a list item
  now also stays under it when read back.
- **Toggle headings keep their shape in Markdown.** A toggle heading was written as a plain
  heading with its nested blocks after it, so an AI app that read a page and wrote it back with
  `update_page` (or `replace_block`) turned it into an ordinary heading and moved what was folded
  under it out onto the page. It is now written as `<details>` with the heading in the `<summary>`,
  and comes back as a toggle heading of the same level with its nested blocks.
- **Edit access given while a page is open now works at once.** Someone who had a page open to
  view or comment on and was then given edit access (by a share, a group, a teamspace or a role)
  could type, but their edits weren't saved until they reloaded the page. Their open page now takes
  them right away, the ones typed before included. Unlocking a page or restoring it from the trash
  sends the edits it held back the same way.
- **Templates keep the access a subpage had.** Saving a subpage as a template copied only its own
  sharing, so a page closed to everyone above it could become a template the whole workspace
  opens. The entries it had from its parents are now copied onto the template too.
- **Comment threads can't lose comments to edits from the future.** An edit could delete parts of
  a page the server hadn't received yet, slipping past the check that keeps others' comments in
  place; such edits are refused.
- **Password resets end everything.** Changing a password with "sign out other devices", a reset
  by email and a reset an instance admin required now also revoke API tokens (and, for a required
  reset, connected apps), and close the pages open in the signed-out sessions. Replacing or removing
  a workspace's SSO connection closes the open pages of the sessions it ends.
- **Pages in the trash can't be changed.** Their content, title, icon, cover, properties and
  snapshots could still be written, by open tabs too. Open tabs turn read-only when a page goes to
  the trash and writable again when it is restored.
- **Moving or adding pages under a page in the trash is refused** (`parentInTrash`). A page moved
  there could be deleted for good with it, and one moved while its new parent was being trashed
  now goes to the trash with it.
- **Guests don't learn members' email addresses.** Naming people in an automation's notification
  by address or name, access requests in the share panel, the inbox and their emails showed guests
  who is in the workspace under which address. Guests now name people by id, and see requesters
  by name only.
- **Pasting into a database view adds options only with edit access.** Pasting values that aren't
  options of a select property yet added them for people who may only change rows; now only those
  who may edit the database (or add rows) do.
- **An owner's own agent runs stay theirs.** A run an owner asked for, or one a schedule without a
  database started, reads with that owner's access, but every owner saw its steps, answer, task and
  the notes it proposed. Others now see only that it ran and how it ended.
- **Tighter checks on addresses the server fetches.** An SSO issuer's discovery document is cut off
  at its size limit even without a Content-Length, file attachments by URL refuse the local NAT64
  and IPv4-translated IPv6 ranges, and MCP clients can't register a back-channel logout address.
- **Times on days the clocks change.** On a day daylight saving starts or ends, a date's time was
  read as the time passed since midnight instead of the time on the clock: 14:30 on a 25-hour day
  showed as 15:30 in the date picker and on the calendar, and editing the date, dragging it to
  another day or a reminder some days before it saved the time an hour off. Times now read as the
  clock shows them, and stay on the clock when moved to another day.
- **Skipped times in zones far ahead of UTC.** A time the clocks skip when daylight saving starts
  (02:30 on 27 September 2026 in New Zealand) moved an hour back instead of forward in zones 13 or
  more hours ahead of UTC, in the date picker, new calendar events and repeating schedules. It now
  moves forward past the change, as it always did elsewhere.
- **Relative date filters on dashboards and calendar feeds.** Dashboard widgets and calendar feeds
  applied filters such as "is within today", "this week" or "is on a day" in the server's time
  zone, so near midnight they counted another day's rows than the table showed. Widgets now count
  days in the viewer's zone and calendar feeds in their user's zone, kept with the feed when it is
  made.
- **Push reminders of timed dates.** A push notification for a reminder on a date with a time
  showed the time in UTC; it now shows it in the reminder's zone, as the email does.
- **Changes to an SSO connection keep their audit log entry when an account or the workspace is
  deleted at the same time.** Setting up, changing, verifying or removing a workspace's connection wrote the
  connection's rows before taking the workspace's, and deleting the workspace, an account in it or
  the account that set the connection up took them the other way round. When the two ran at once,
  PostgreSQL broke the deadlock by cancelling one of them, which could be the change's audit log
  entry: the change went through and the entry went missing. Changes to the connection now take
  the workspace first, which also keeps *Verify domains* and *Remove* run at once from cancelling
  each other.

### Security

- **A workspace's SSO domains are verified only as their records were checked.** *Verify domains*
  looked up each domain's TXT record and then marked the connection verified as it was by then.
  An owner who saved other domains while the lookup ran (their own DNS server answers when they
  like) had those verified on the strength of their own domain's record. Anyone can own a
  workspace, so anyone could claim another organization's domain this way and sign in, through an
  identity provider of their own, as the people with an address there, existing accounts
  included. Now the domains are marked verified only if the connection still has the domains,
  record value and identity provider that were checked, and no other connection verified one of
  them meanwhile; otherwise *Verify domains* says the connection changed and asks to verify again.
  Releases since 0.3.0 are affected. This lists the verified connections whose domains aren't the
  ones their last verification in the audit log names (or that have none left, events older than
  a year being pruned):

  ```sql
  SELECT s.workspace_id, p.domain, last.details -> 'domains' AS last_verified
  FROM workspace_sso s
  JOIN sso_provider p ON p.provider_id = s.provider_id
  LEFT JOIN LATERAL (
    SELECT details FROM audit_event
    WHERE workspace_id = s.workspace_id AND action = 'sso.domains_verified'
    ORDER BY created_at DESC
    LIMIT 1
  ) last ON true
  WHERE p.domain_verified
    AND last.details -> 'domains' IS DISTINCT FROM to_jsonb(string_to_array(p.domain, ','));
  ```

  `UPDATE sso_provider SET domain_verified = false WHERE provider_id = 'ws-<workspace_id>'` stops
  sign-ins through one until its owners verify it again, which only the domains' owner can. Sign
  out everywhere (Server administration) the people with an address in its domains, and have them
  check their API tokens and connected apps.
- **An email domain can no longer be verified by two workspaces at the same moment.** Proving an
  allowed domain checked that no other workspace had it (verified for SSO or proven as an allowed
  domain, subdomains either way) only before looking up its TXT record, and didn't take the lock
  SSO verification checks under. So a workspace proving an allowed domain while another verified it
  for SSO, or proved it too, could each end up with it, though a domain belongs to one workspace
  only. Proving an allowed domain now checks again once its record is found, under the same lock.
  Both workspaces needed the domain's TXT records, so only whoever controls its DNS could do this.
- **Moving or removing a workspace's SSO connection revokes API tokens and connected apps.** Pointing
  the connection at another identity provider, or removing it, ended the sessions signed in through
  it, but the API tokens and connected apps of the people who signed in that way kept working. They
  are now revoked with the sessions, as on a password reset, and the audit log entry says how many.
  A change that keeps the identity provider (a new client secret, other domains) revokes nothing.
- **Deleting a workspace revokes the API tokens and connected apps of its SSO users.** It already
  ended the sessions signed in through the workspace's SSO connection, but those people's tokens
  and apps for all their workspaces kept reaching the others. They are now revoked in the same
  transaction; the workspace's audit log goes with it, so the server log says how many. Their
  other workspaces record each app disconnected as done by the server, on that person, here and
  when the connection is moved or removed, not as the person's own doing from the owner's address.
- **Pages have a Content-Security-Policy.** Only scripts carrying a nonce made for that response
  run, so HTML that ever got past the sanitizers of a published page, a bookmark or a diagram
  can't run script where the session lives; frames may only come from the embed providers, and
  forms and `<base>` stay on this site. Offline copies of pages keep their policy.
- **Bookmark cards in the editor link and load only web addresses.** A bookmark written with
  another kind of address (by hand in the document, or by an app) shows without a link or image.
- **Published pages check links in tables of the older form too**, and refuse image and video
  addresses like `/\example.com/…`, which browsers read as another site.
- **An agent's call waiting for approval goes only to the owners its run is for.** Every owner got
  it in their inbox, with its input, and could answer it, though the input can quote a row an
  owner can't open. Now a run on a row, or a schedule's run on a database, asks only the owners
  who can open it, and a run an owner asked for (or one of their schedules without a database)
  asks only them, as the agent's runs already showed it; a connection's event still asks every
  owner. Only those asked see the call and answer it; a run no owner may answer runs out of time,
  sending nothing.
- **Deleting an account cuts off the SSO connections of the workspaces it deletes.** The
  workspaces nobody else was in went with the account, but the sign-ins through their connections
  stayed on record, with the sessions, API tokens and connected apps of the people who had signed
  in that way, members or not by then. They now go as when a connection is removed. A connection
  the person had set up in a workspace they had already left no longer goes with their account
  either, which removed it without an audit log entry and left "SSO only" holding nobody back: it
  passes to an owner there, as it already did in the workspaces they were still in.
- **A new SSO connection starts without earlier sign-ins under its provider id.** A workspace's
  connection always has the same provider id, so sign-ins through an earlier one could still be on
  record (see the previous entry), also for a deleted workspace restored from a backup. Setting up
  a connection now removes them, ending those sessions and revoking those people's API tokens and
  connected apps as moving the connection to another identity provider does; the audit log entry
  says how many.
- **Single sign-on no longer brings back people who left a workspace or were removed from it.**
  The first sign-in through a workspace's connection joins the workspace, and moving the
  connection to another identity provider, or setting one up again, makes everyone's next sign-in
  through it the first again: someone an owner had removed, or who had left, was back in by signing
  in. Now they stay out, as does someone whose request to join was declined, unless an invitation
  to join as a member or owner is waiting for their address. An owner adding them again, or their
  identity provider over SCIM, still brings them back.
- **Sign-ins through a workspace's earlier SSO connection are forgotten.** The SSO plugin finds a
  person by the connection's provider id, which is always the same for a workspace, and the
  identity provider's id for them, before it looks at the address. A connection set up again before
  this release (after one was removed before 0.5.0, went with the account of the owner who set it
  up, or with a workspace a backup brought back) kept the sign-ins through the one before. Whoever
  ran its identity provider could sign in as those people, in all their workspaces, by sending their
  ids. Migration 0085 forgets them and revokes those people's API tokens and connected apps (see
  *Upgrading*). Releases since 0.3.0 are affected. A connection pointed at another identity provider
  before 0.5.0 kept its sign-ins too, and the migration can't tell them from later ones: if one of
  yours was, remove it and set it up again, which forgets everyone's sign-ins through it.
- **An API token deleted while a request used it no longer serves that request.** Recording when
  a token was last used waits for a transaction deleting the token at that moment (revoking it, or
  cutting off its owner's sign-ins); the request then went ahead with the token gone. It is now
  refused as an invalid token.

## 0.5.4 — 2026-10-17

### Upgrading from 0.5.3

- **Migrations** (0070–0077) run automatically when the container starts. Compose users
  don't need a new `docker-compose.yml`: this release adds no settings.
- **Every passage is embedded again once.** Passages now start with where they are (see
  *Changed*), so their text changes and the embeddings model sees each of them once more after
  the upgrade: through the background sweep as people search, or all at once with
  `pnpm search:index`. On large workspaces with a paid embeddings provider, run it at a quiet time.
- **Migrations 0075 and 0077 each rewrite the `page` table once.** 0075 adds the stored search
  vector (see *Changed*) and fills it for every page, 0077 adds the pieces of Chinese and Japanese
  text to it and keeps it to the first 80,000 characters of each page's text; on a server with
  many pages each takes a while (about 15 seconds for 60,000 pages with 2 KB of text each), and
  pages can't be read or written until it's done: upgrade at a quiet time (from source, run
  `pnpm db:migrate` then).

### Added

- **Eleven more interface languages.** Leafdesk now speaks Italian, Brazilian Portuguese, Polish,
  Russian, Ukrainian, Arabic, Hebrew, Persian, Japanese, Korean and Simplified Chinese, next to
  English, Turkish, German, Spanish and French: in the app, emails, built-in templates and the
  editor's menus, picked in My account → Language or taken from the browser. Arabic, Hebrew and
  Persian lay the whole app out right to left, and emails follow. Each paragraph of a page now
  follows the direction of its own text, so a right-to-left paragraph reads correctly in a
  left-to-right interface and the other way round; alignment runs with it too, so a right-to-left
  paragraph starts on the right without being aligned and the align buttons still put it on the side
  they show. An Arabic, Hebrew or Persian paragraph aligned right before this release now sits on
  the left, where its text ends: align it again. CSV import knows the new languages' title column
  names and yes/no words, quick add understands their date words (Japanese and Chinese, written
  without spaces, a character at a time: "来週の金曜日に打ち合わせ"), and the AI chat's search leaves out their
  question words. The new translations haven't been reviewed by native speakers yet; corrections are
  welcome.

- **Apps can't overwrite edits they haven't seen.** `get_page` (MCP) and `GET /pages/{id}` now give
  the body's `version`, and `update_page` / `PATCH /pages/{id}` take it back as `expected_version`:
  the page changes only while its body still has that version. When someone edited it after the
  app read it, also in an editor that is open right now, nothing is written; MCP tells the app to
  read the page again, and the REST API answers 409 `version_conflict` with the current version.
  Body writes report the new `version`, so an app can make several changes in a row without reading
  the page in between. Comments don't change the version. Without `expected_version` writes work
  as before. Covered in `scripts/mcp-e2e.ts`.
- **The AI chat answers from attached PDFs and Word documents.** The text of a PDF or .docx shown
  in a page's file block now goes into the page's semantic index, in passages that start with the file name and point
  at the file block, so the chat can answer from inside the document and its
  citation opens the page at the file. A document is read once and its text kept (migration
  0071, `file_text`); the same file uploaded again isn't read twice. Only the first 50 pages or
  200,000 characters of a document are read (the record says when it was cut), up to 20 documents
  per page, and files over 25 MB are left out; a scan with no text layer, or a damaged or locked
  file, adds nothing. Only files the page's readers may open through the page count, and search
  checks access to the page when it runs, as for the rest of its text. Existing pages are indexed
  again by the next sweep or `pnpm search:index`; their unchanged passages aren't embedded again.
- **Workspace health.** Settings → Health (owners and members) looks over the pages you can open
  and lists what is worth tidying: links and mentions to pages in the trash or deleted for good,
  top-level pages nothing links to, pages with a title and no body, pages nobody edited for 3, 6,
  12 or 24 months, pairs of pages that say nearly the same thing, and database relations to rows in
  the trash or deleted. Duplicates are compared by the pages' embeddings, so they need an
  embeddings model on the server and AI on in the workspace; otherwise the report says they
  weren't checked. Each finding links to its page, and many have a one-click fix: restore the page
  a link leads to, link an orphan where another page already writes its title, move an empty page
  to the trash, or take a dead row out of a relation. Pages someone can't open are never named or
  counted, not even as a broken link. The same report is the new MCP tool `check_workspace`, which
  changes nothing and says which tools fix each finding. Covered in
  `scripts/workspace-check-e2e.ts`.
- **More filter conditions.** Text, URL, email, phone and title filters (and formulas and rollups
  with a text result) gain *Does not contain*, which ignores case as *Contains* does and matches
  empty values. Numbers gain ≥ and ≤, and dates, created and edited times *Is on or before* and
  *Is on or after*, which match a date range when any of its days does, as *Is before* and *Is
  after* do. Selects and statuses gain *Is any of* and *Is none of*, and tags, relations and
  people *Contains any of* and *Contains none of*: one rule with several values, where "Me" counts
  for whoever looks. They work the same in the app, on published pages, in dashboards, for
  restricted properties and through the API, MCP (`query_database`, saved views) and the AI chat,
  as `does_not_contain`, `gte`, `lte`, `is_any_of` and `is_none_of` (the last two with a list of
  values). Saved views keep working unchanged.

- **AI changes to a page can be kept or undone one by one.** After an AI app, the chat or an agent
  writes to a page body, the page shows a bar above the body with how many blocks changed and
  who changed them: *Review* opens the changes block by block with *Keep* and *Undo* for each,
  next to *Keep all* and *Undo all*. Undoing goes through the page's shared document, so editors
  open on the page follow at once, and *Undo all* saves a version first. Writes in a row are
  reviewed together; the bar goes away once every change is decided or someone edits the page.
  Only people who may edit the page see it (migration 0072).
- **Changing one block instead of the whole body.** The chat and agents have a new `edit_page`
  tool that replaces, inserts after, appends or deletes blocks by id, and `update_page` (MCP) and
  `PATCH /pages/{id}` take the modes `replace_block`, `insert_after` and `delete_block` with a
  `block_id`. `get_page` / `GET /pages/{id}` give the ids with `with_block_ids`. Like every AI
  write, these save the page first and can be reviewed on the page. Agents may use `edit_page` on
  the rows they already may update.
- **Approval cards show what changes.** Before the chat changes a page's text, the approval card
  shows the blocks it changes, adds and removes; for a row it shows each property's old value
  next to the new one, and the old title when it is renamed. Covered in `scripts/ai-chat-e2e.ts`
  and `scripts/mcp-e2e.ts`.

- **Table cells work from the keyboard and the clipboard.** Click a cell (or move with the arrow
  keys) to make it the active cell; Shift with an arrow, Shift+click or a drag selects a range.
  Enter opens the active cell's editor and Esc brings you back to the cell, Delete clears the
  range. Copy puts the range on the clipboard as tab-separated text, the way exports write values,
  and pasting cells copied from a spreadsheet writes them from the active cell on: each value is
  read as the CSV import reads it (numbers like `1.234,5` or `15%`, dates, yes/no, option and
  people names), options a select lacks are added, and rows past the last one are added in an
  ungrouped table. One pasted value fills the whole selected range. Cells that don't fit their
  column or that you may not change are left out and counted.
- **Row activity tells AI values apart.** A value AI autofill filled in now reads as the AI's in
  the row's activity, naming who it was worked out for: "AI (for Ada) set Category to Billing",
  with a sparkle in place of a face. That person is whoever refreshed the row or updated the
  view's rows, or whose change of the row set the value off; for an automation's change, the
  person it acts as, its own entry for the change sitting right below. AI entries never merge into
  that person's own edits of the value. `list_row_activity` (MCP) and `GET /rows/{id}/activity`
  give `actor: "ai"`, with the person in `by`. Needs migration 0074.

- **Agents read every row and write rows safely.** `query_database` (MCP and `POST
  /databases/{id}/query`) now returns `next_cursor` and `has_more`: pass the cursor back with the
  same filters and sorts to read the next page, until it is null. Pages follow on from the last row
  returned, so rows added or removed between calls neither repeat nor go missing; a cursor from
  another query is refused. `properties` narrows each row to the values asked for.
  `create_database_row(s)` take `match_by` (the title or a text, number, email, phone, URL, select
  or status property) to upsert: a row with the same value is updated instead of a new one being
  added, so a retried import adds nothing twice, and each row says whether it was `created` or
  `updated`. A value two given rows share, or that several existing rows hold, is refused before
  anything is written. `update_database_rows` takes `expect` (refuses, writing nothing, unless
  exactly that many rows would change) and `dry_run`. Covered in `scripts/row-safety-e2e.ts` and
  `scripts/mcp-e2e.ts`.

- **Published pages can show databases from elsewhere.** A published page shows the databases that
  lie under it; a dashboard or database view over a database elsewhere used to stay empty for
  visitors. The *Publish* tab now lists those databases, before and after publishing: tick *Show on
  this page* to show one there anyway, or move it under the page to publish it with it. A database
  shown this way appears only in the page's widgets and views, without links to it or its rows, and
  *Duplicate* leaves it out. It is hidden again as soon as the publisher can no longer see it or it
  goes to the trash (migration 0076).

### Changed

- **Search stays fast in large workspaces.** Full-text search (the search box, MCP and REST
  `search`, the AI chat, agents) now matches and ranks pages through an index of a vector Postgres
  keeps for each page (migration 0075, `page.search_vector`: the title's words weighted above the
  body's), and checks access only for the best pages until there are enough. The vector holds the
  first 1,000 characters of a title and the first 80,000 of a body (migration 0077), so a page of
  a few megabytes of distinct words still saves: words past that point of a huge page aren't
  found by full-text search. Before, every search
  read the text of every page in the workspace: in a test workspace of 60,000 pages a search for a
  rare word took 3.7 seconds and now takes under 60 ms, one for a word most pages have went from
  3.6 seconds to 0.4. A word now also matches as the start of a longer word ("kond" finds
  "kondenser"), in the body as in the title, so pages show up while a word is typed; the middle of
  a word no longer matches. Long pages no longer rank above short ones only for their length. The
  list of pages that write a page's title without linking to it uses the same index. Covered in
  `scripts/search-e2e.ts`.
- **Japanese and Chinese words are found inside sentences, Korean ones with a particle joined
  on.** Chinese and Japanese write no spaces between words, so search took a whole sentence as one
  word and found a page only by its first characters: "会議" didn't find "明日の会議について". The
  search vector now also keeps every two-character piece of such text (migration 0077,
  `cjk_bigrams`, for the first 30,000 such characters within the first 80,000 of a page), and
  queries are cut the same way: a word is found anywhere, a single character
  as it is typed, and the pieces of a word only side by side ("東京都" doesn't find a page about
  "東京" and "京都"). Korean is written with spaces, so its words are still found by their start
  ("회의" finds "회의를", not "국회의원"). The AI chat's any-word search takes the words of such a
  question without particles and function words ("车在哪里" looks for "车"), and Korean words
  without a particle at their end. The list of pages that write a page's title without linking to
  it finds such titles inside sentences too, but not inside a longer word ("会議" isn't offered in
  "国会議員", "メモ" not in "メモリー"), so linking one never cuts a word apart. Covered in
  `scripts/search-e2e.ts` and `scripts/backlinks-e2e.ts`.
- **The AI chat gets the matching passage without an embeddings model too.** A page the chat's
  search finds by its words now comes with the part of its text that has the most of them, about
  900 characters, where the model used to get one line around the first word unless the page was
  in the semantic index. Covered in `scripts/ai-chat-e2e.ts` and `src/server/ai-tools.test.ts`.
- **Semantic search knows where a passage is.** Each indexed passage now carries the titles of
  the pages above its page, the page's own title and the heading it lies under (at most 200
  characters; a database row's path includes its database), so a passage under *Sales › 2026 plan
  › Risks* is found for questions about sales risks even when it never says "sales". A heading now
  starts a new passage. Renaming or moving a page indexes the pages under it again. Results and
  the AI chat show the passage without that path, since it can name pages the reader can't open.
  Pages are indexed again after upgrading (the chunking version went up).
- **The AI chat cites the right block for pages found by their words.** A page that only the
  full-text search found reached the model as a short snippet without a block, so its answer
  cited the whole page and it often read the page again. It now gets the page's indexed passage
  with the most of the question's words, and the citation links to that block.
- **Long tables render only the rows in view.** From 120 rows on, a table view renders the rows
  near the visible part of the page and stands in for the rest, so tables with thousands of rows
  open and scroll without lag. Grouped tables, sub-items, frozen columns and group calculations
  work as before.

### Fixed

- **A page that can't be saved says so.** When the database refused to save a page (as an
  oversized search index once did), the failure only reached the server log: creating a page with
  a body, the REST API, AI apps and imports went on as if the body had been written, and the editor
  kept showing the page as live. Such writes now fail with an error (500 `internal_error` from the
  REST API, an error result for AI apps), and the editor's status says "Not saved" until a later
  save goes through. A page created with a body that couldn't be saved stays, without the body.
- **AI autofill values count as row changes.** A value AI filled in was saved past everything a
  row write sets off: semantic search didn't index it until something else changed the row, the
  row's activity didn't show it, and automations waiting for the property to change never ran.
  Values are now saved like any other change (for the person who asked for them), and only when
  they differ from the stored one. They start automations, except when an automation's change set
  them off: those count as the automation's own changes, which start none, so automations and AI
  values can't keep setting each other off. After an AI value is written, only the automatic AI
  values that read it update, and none twice in a row of updates.
  - Other AI values, and formulas over them, go into an AI property's prompt only when its settings
    name them (a `{Property}` placeholder, the translated property); summaries no longer take them
    in on their own. Values whose prompt changes this way are worked out again the next time their
    row changes.
  - Settings that would make an AI property read itself through other AI properties are refused
    with a message naming the property in the way. Covered in `scripts/ai-e2e.ts`.

- **Semantic search catches up when the way pages are cut into chunks changes.** The index
  noticed pages that changed and a new embeddings model, but not a release that chunks pages
  differently: pages kept their old chunks until someone edited them, and `pnpm search:index`
  skipped them. The index now records the chunking it was built with (migration 0070), and pages
  built with another one count as stale for the sweep and `pnpm search:index`. Chunks whose text
  stays the same aren't embedded again. Covered in `scripts/semantic-search-e2e.ts`.
- **Edits of different properties of one row no longer undo each other.** Editing a row's value
  wrote back the whole row as it was read a moment before, so a value someone else, an agent or
  an automation had just set in another property of the same row could quietly disappear. Single
  row edits now merge into the stored values the way bulk edits already did. Covered in
  `scripts/database-e2e.ts`.
- **Stopping the server no longer loses the last edits.** On SIGINT/SIGTERM the server started the
  saves still waiting out their debounce but exited half a second later whether they had finished
  or not, so on a large page or a slow database up to the last ten seconds of typing could be lost.
  It now closes the editors' connections, waits until every open page is saved (at most eight
  seconds, inside Docker's ten-second grace period) and logs it when it had to stop waiting. A
  second Ctrl+C exits at once.
- **Deleted files no longer stay behind in storage.** Deleting a workspace, an account or orphaned
  uploads removed the files' records first and their bytes afterwards, at best once: when storage
  refused or the server stopped midway, the bytes stayed with nothing pointing at them. The objects
  to delete are now queued in the same transaction as the records (migration 0073), and what
  storage refuses is tried again by the hourly file cleanup, waiting longer after each failure (up
  to a day). Covered in `scripts/storage-deletion-e2e.ts`.

## 0.5.3 — 2026-10-16

### Upgrading from 0.5.2

- **Migrations** (0068–0069) run automatically when the container starts.
- **Docker Compose:** download the new `docker-compose.yml`. It passes the settings that are new in
  this release to the app: voice notes' `STT_PROVIDER`, `STT_MODEL`, `STT_BASE_URL`,
  `STT_API_KEY`, `STT_MAX_SECONDS`, `STT_MAX_MB` and `STT_TIMEOUT_SECONDS`, and
  `CONNECTION_OAUTH_CLIENTS`; without it they stay unset in the container, voice notes stay hidden
  and owners enter their own app for services that need one.
- **Apps reach the AI chat's memory.** MCP apps someone connected can now read the notes the chat
  keeps about them and keep new ones. Turn it off per person with *Use memory* in the *Memory*
  dialog, or per workspace under Settings → General → AI → *AI memory*.
- **Event runs may add rows.** An agent that a connection's events run may now add rows to
  databases shared with it to edit; each row waits for an owner's approval in the inbox.

### Added

- **A catalog of ready-made connections.** Settings → Connections now opens on *Browse*: 147
  services in 16 categories, as cards with each service's logo, from Linear, Atlassian, GitLab,
  Sentry and Stripe to Intercom, Zapier and meeting recorders, with search by name or category.
  *Connect* on a card fills in its MCP address, how it signs in and, for GitHub, how its events are signed; *Add another
  server* still takes any remote MCP server. Every listed address was checked to sign in a way
  Leafdesk handles: OAuth metadata naming that address, an API key, or no sign-in at all.
  The workspace's own connections are under *Connected*, and those to a listed service show its
  logo instead of a plug.
- **Connections to services that sign in only registered apps.** Slack, HubSpot, Asana, Box,
  Discord, Front, PagerDuty and Xero are in the connection catalog (Slack, Discord and
  their category *Messaging & chat* are new to it). Their servers don't let Leafdesk register
  itself, so the form asks for the client ID and secret of an app you create at the service, links
  to where it's made and shows the redirect URL to give it; the secret is sealed like a token,
  never shown again, kept when signing out, and must be entered again for a new address. Any
  other OAuth server can take an app the same way, folded under *Sign in as an app registered
  with the service*. An instance can register one app per service for everyone in
  `CONNECTION_OAUTH_CLIENTS` (`slack=CLIENT_ID:CLIENT_SECRET,…`). A server that takes neither
  registrations nor an app now says so instead of failing to sign in. ElevenLabs is listed too: it
  takes Leafdesk's client metadata document (`/api/connections/oauth/client`) as its client ID,
  from an instance on a public `https` address.
- **Voice notes.** Speak, and AI writes what you said up as a clean note: a title, short paragraphs,
  lists kept, filler words gone, and the transcript in a *Transcript* toggle under it. In the quick
  note (and the installed app's new *Voice note* shortcut, which starts recording), the note fills
  the fields to check before saving, on a private page or, with the new *Save to*, as a row of a
  database, whose select and multi-select properties AI fills in from their options. In a page,
  `/` *Voice note* puts the note where you are. An audio file works too, where the browser can't
  record. Speech to text is set up apart from the chat model: `STT_PROVIDER` (`openai` or
  `openai-compatible`, e.g. a local Whisper server), `STT_MODEL`, `STT_BASE_URL`, `STT_API_KEY`,
  with `STT_MAX_SECONDS`, `STT_MAX_MB` and `STT_TIMEOUT_SECONDS` as limits; without them voice
  notes stay hidden. The audio is never stored.
- **Quick notes go into databases.** *Save to* in the quick note adds the note as a row of a
  database you may edit, instead of a private page.
- **Voice notes from apps.** `POST /api/v1/voice-notes` takes a recording as multipart form data
  (`audio`, with `workspace_id` or `database_id`), writes it up like the quick note does and saves
  it as a private page or a database row, answering with the note's id, title, transcript and the
  values AI picked. It needs a `pages:write` token, speech to text on the server and AI on in the
  workspace (else `409 voice_notes_unavailable`), and takes files up to `STT_MAX_MB`. The API's
  reference shows bodies with files as form data.
- **Apps you connect share the AI chat's memory of you.** Over MCP, `list_memory` reads the notes
  the chat keeps about you in a workspace (or in all of them), `add_memory` keeps one,
  `update_memory` changes one and `delete_memory` deletes some or all, with the chat's limits (30
  notes of 300 characters, the same note kept once). The tools tell an app to read the notes at the
  start of a conversation, to keep only what you say about yourself, never what pages or tool
  results say, and to tell you what it kept. *Memory* shows which app kept or last changed a note
  (*Kept by …*). With your *Use memory* switch or the workspace's *AI memory* switch off, an app
  sees no notes and keeps none, but can still delete them for you.
- **Agents run on a schedule.** An agent's new *Schedules* tab (Settings → Agents) sets it to run
  on its own, every day, week (on chosen weekdays), month or year at a time of day in a time zone,
  with a task and, optionally, a database it looks after: for example every day at 08:00, go
  through the board, mark what is overdue and say what needs me. A run on a database reads it first
  and may change and comment on any of its rows (up to 30 changes, where a run on a row makes 5);
  without one it only reads and uses its connections' tools. Each run is held to the access of the
  owner who set the schedule last as well as the agent's, and ends with a report in that owner's
  inbox (and as a push notification, without the report's text). The run's history names the
  schedule, who set it and its task. A schedule whose last run still waits skips a run; a paused
  agent, a database in the trash or one not shared with the agent skips runs; and a schedule pauses
  when the agent is archived or whoever set it is no longer an owner or can't open the database,
  until an owner sets it again. The tab warns when the agent can't open or change the database (it
  isn't shared on its own). A run over a database with rows no one in the workspace stands behind,
  such as anonymous form answers, asks an owner before each connection tool and proposes no notes.
  Up to 10 schedules per agent. The REST API has `GET`/`POST /agents/{agent_id}/schedules` and
  `PATCH`/`DELETE /agents/{agent_id}/schedules/{schedule_id}`,
  MCP has `add_agent_schedule`, `update_agent_schedule` and `delete_agent_schedule`, and
  `get_agent` lists an agent's schedules. Migration `0069_agent_schedules` adds `schedule.agent_id`
  and the `agent_report` notification. Covered in `scripts/agent-schedule-e2e.ts`.
- **Wins log template.** The template gallery has a *Wins log*: a page with a dashboard (wins in
  all, wins by month stacked by type, by area and by impact) above a database of wins with their
  type, area, date, impact, source link and people, a board by type, a row template and a few
  example rows. Built-in database templates can now bring views of any kind and a dashboard.
- **Wins logger agent.** A built-in agent that a connection's events run rather than an
  automation: it reads each event (a Slack message, a GitHub pull request, a CRM deal or an email
  sent through a signed webhook) and adds a row to the wins log when it is a win or praise, and
  nothing otherwise. Its setup picks the log, the connection and the event type, lists which of the
  log's properties it fills, and says so when the workspace has no connection yet.
- **Agents add rows from events.** A run a connection's event started may now add rows
  (`create_row`) to databases shared with the agent to edit, within the run's limit of changes and
  starting no automations. Each row waits for an owner's approval in the inbox and the agent's
  runs, trusted trigger or not, as a connected service's writing tools do.

### Changed

- **A page's icon sits beside its title.** Pages show their icon at the start of the title's line,
  as databases already did, so the content starts higher; *Add icon* and *Add background* show over
  the title's right end on hover (on touch screens as icons after the title). Published pages and
  printouts follow.
- **Pages with a dashboard use the whole width.** Adding a dashboard, in the editor or with the MCP
  `add_dashboard` tool, turns on the page's *Full width*, so its widgets get the room; the page menu
  turns it off again.
- **Dashboard widgets move by dragging.** Editors pick a widget up by its title bar and drop it
  beside another (or above or below one as wide as the dashboard); a line shows where it lands. The
  widget's menu still moves it one place at a time.

## 0.5.2 — 2026-10-15

### Upgrading from 0.5.1

- **Migrations** (0060–0067) run automatically when the container starts. Nothing changes in
  `docker-compose.yml` or `.env`.
- **The AI chat's memory is on.** Where AI is on, the chat may keep notes about the people who use
  it (asking them first, unless the mode is *Auto*), and agents' runs may propose notes for owners
  to review. Owners who don't want it turn it off per workspace under Settings → General → AI →
  *AI memory*; each person can also turn it off for themselves in the *Memory* dialog.
- **Write tokens and MCP apps reach agents.** For a workspace owner, an API token or MCP app with
  `pages:write` can now change the workspace's agents (pause them, set a monthly token limit) and
  ask them for runs, which use the workspace's AI allowance. Give integrations that only read a
  `pages:read` token, or let apps only read under Settings → Security.
- **Apps that reach a workspace** show when each app or token last reached it from this version
  on; earlier use isn't known.

### Added

- **Memory for the AI chat.** The chat keeps short notes about each person in a workspace (who
  they are, what they work on, how they want answers) when they tell it about themselves or ask it
  to remember something, and drops one when asked to forget, with new `remember` and `forget` tools
  offered in every mode. Unless the mode is *Auto*, the chat asks the person (*Yes* or *No*) before
  it keeps or drops a note, also in *Read only*, so text it read can't slip in a lasting note; each
  note kept, dropped or declined shows among the answer's steps and is kept with the conversation
  also when the answer fails, and *Answer again* carries it to the new answer. Only what the
  person says in their questions is kept, never what pages or tool results say. The notes go with
  the person's later questions in that workspace as data, never with anyone else's or in another
  workspace, and never widen what the chat may read or change. The new *Memory* dialog (the brain
  button in the chat's header and panel) lists them, adds, changes and deletes notes, and forgets
  everything. Up to 30 notes of 300 characters per person and workspace; they are deleted when the
  person leaves the workspace or deletes their account. Migration `0063_ai_memory` adds
  `ai_memory`. Covered in `scripts/ai-memory-e2e.ts`.
- **Switches for the AI chat's memory.** *Use memory* at the top of the *Memory* dialog turns the
  memory off for the person in that workspace, and owners can turn it off for the whole workspace
  under Settings → General → AI → *AI memory*, which also hides the *Memory* button. While it is
  off, questions carry no notes and the chat isn't offered `remember` or `forget`; no note is
  deleted, and owners' changes are in the audit log. Migration `0064_ai_memory_switch` adds
  `workspace_member.ai_memory`. Covered in `scripts/ai-memory-e2e.ts` and
  `scripts/ai-chat-e2e.ts`.
- **Memory for agents.** Agents keep short notes that go with each of their runs (where things go
  in the workspace, how a recurring case is handled). Because everything a run reads was written by
  someone else, a run only proposes notes, with a new `remember` tool: each proposal shows among the
  run's steps, with credentials masked, and goes with no run until an owner keeps it. The agent's
  new *Memory* tab (and a "notes to review" link in the list of agents) shows proposals with the run's
  row and time, to keep as they are or changed, or dismiss; owners also write, change and delete
  notes and make the agent forget everything. A proposal from a row an owner can't open is shown to
  them without its text, and only dismissed. Runs drop notes at once with `forget`. Runs no member
  stands behind (anonymous or outside form answers, untrusted triggers) get neither tool but still
  get the kept notes, which reach the model as data inside `<memory>` and never widen what it may
  change. Up to 30 notes of 300 characters per agent and 10 proposals waiting; an unanswered
  proposal goes with its run after 30 days. The workspace's *AI memory* switch holds for agents
  too: off, runs carry no notes and propose none. Changes are recorded in the audit log, counted. MCP's
  `get_agent` lists the notes and proposals. Migration `0065_agent_memory` adds `status` and
  `agent_run_id` to `ai_memory`. Covered in `scripts/agent-memory-e2e.ts`.
- **Owners hear of an agent's proposed notes.** When a run proposes a note, each owner of the
  workspace gets one inbox item for that run, pushed too (without the note's text) and never
  emailed, whatever their notification choices. It shows the first proposal's text, unless the run
  was on a row that owner can't open, and how many more there are; it opens the agent's *Memory*
  tab (`?tab=agents&agent=<id>&agentTab=memory`), can be snoozed, and goes away once every proposal
  of the run is kept or dismissed. Answering an agent's call no longer takes the run's other inbox
  items with it. MCP adds `keep_agent_memory` and `dismiss_agent_memory` for proposals, and
  `add_agent_memory`, `update_agent_memory` and `delete_agent_memory` for an owner's own notes,
  each answering with the agent's memory as `get_agent` shows it; `list_notifications` summarizes
  the new item. Migration `0066_agent_memory_notice` lets `agent_memory` notifications have no page
  and keeps one per run and owner. Covered in `scripts/agent-memory-e2e.ts` and `scripts/mcp-e2e.ts`.
- **Skills.** A page or database row can be marked *Use as skill* in its `⋯` menu (edit access;
  not databases, templates or the pages in them): its body is instructions to reuse, and a bar
  under the title says what it is for. The sidebar's new skills button opens the workspace's
  skills library (searchable, with *New skill*). In the AI chat, `/` at the start of the empty box
  picks a skill whose instructions the next question follows, without widening what the chat may
  change; the question keeps it, and *Answer again* and *Edit* use it again. MCP clients get
  `list_skills`, `get_skill` (which refuses a title several skills share) and `set_skill`,
  `get_page` says whether a page is a skill, and every skill the user can open is also a prompt of
  its name, unique across their workspaces. The page
  menu and the library export a skill as a ZIP holding `<name>/SKILL.md`. Skills follow page
  access everywhere and leave every list while in the trash. Migration `0060_skills` adds
  `page.is_skill` and `page.skill_description`. Covered in `scripts/skills-e2e.ts` and
  `scripts/mcp-e2e.ts`.
- **Skills for agents.** An agent's new *Skills* tab gives it up to 10 skills of the workspace,
  whose instructions each run sends to the model after the agent's own. Only skills no one besides
  the workspace's owners can edit (not members, teamspaces, groups, guests or agents, the agent
  itself included) can be given; a run checks again and leaves out, saying so in its steps, a skill
  someone else can edit by then, one no longer marked as a skill, or one that doesn't fit in what a
  run may read (12,000 characters together), and the tab shows each skill's state. A run started
  by a member's change or a public form leaves out the skills that person can't open, and a run
  that goes on after an approval checks its skills again. MCP clients get `set_agent_skill`, and
  `get_agent` lists the agent's skills. Giving and taking a skill is recorded in the audit log.
  Migration `0061_agent_skills` adds `agent_skill`. Covered in `scripts/agent-skills-e2e.ts`.
- **Apps that reach a workspace.** Settings → Security shows its owners the MCP apps the
  workspace's people connected and their REST API tokens for it, with what each may do, who
  connected it and when it last reached this workspace (not before this version), the 100 apps
  and 100 tokens used here most recently first. An owner can
  disconnect one person's app or revoke their token; as both belong to the person, it stops
  reaching all of their workspaces, and this workspace's audit log records it with the owner as
  who did it. Migration `0062_connected_app_use` adds `connected_app_use`. Covered in
  `scripts/workspace-apps-e2e.ts`.
- **About.** Settings (and the account page) have an *About* tab: the Leafdesk version the server
  runs with a link to its release notes, who makes it, the license, the website, the source code,
  where to report a problem and the third-party notices. The version is read from `package.json`,
  which the MCP server now reports too. No migration.
- **Copy ID.** A page's, database's or row's menu (also in the row panel) has *Copy ID*, and a
  column's menu, in the table and on a row's page, *Copy property ID*: the ids the REST API and MCP
  clients take, where a property's name may change. No migration.
- **High contrast.** Settings → Preferences → Appearance has *Contrast*: follow the system (its
  "increase contrast" setting, `prefers-contrast: more`), *Standard* or *High*, kept for the
  browser in a cookie like the theme and carried by `<html data-contrast>`. High contrast keeps
  the backgrounds and makes, in either theme, secondary text at least 7:1 on the page and 4.5:1 on
  hovered and selected rows, faint text (hints, placeholders) at least 4.5:1 everywhere, lines and
  control edges at least 3:1, the accent and danger colors stronger and the focus ring more opaque; colored and black page backgrounds get the same lines
  and text. The editor follows, as it draws with the same colors. `src/lib/contrast.test.ts`
  checks the ratios from `globals.css`. No migration.
- **Agents in the Share menu.** Typing in a page's Share menu finds the workspace's agents by name
  too (archived ones aren't offered; a paused one says so) for members with full access to the
  page; one picked starts at *Can view*, as from the agent's settings. An agent's row shows its
  icon and "Agent", and its levels are view, comment and edit only. The server already let anyone
  with full access to a page share it with an agent; the menu now offers it.
- **Agents over the REST API, and runs owners ask for.** New endpoints list a workspace's agents
  (`GET /workspaces/{id}/agents`), read and change one (`GET` and `PATCH /agents/{id}`: settings,
  pausing and resuming, the monthly token limit), ask one for a task now
  (`POST /agents/{id}/runs`), and read its runs (`GET /agents/{id}/runs`,
  `GET /agents/{id}/runs/{run_id}`) and usage (`GET /agents/{id}/usage`), owners only except the
  list. MCP clients get `start_agent_run`. A run an owner asks for works on a database row (and may
  change and comment on it) or on none (it only reads and answers), held to the owner's access as
  well as the agent's; it shows who asked, from where and the task, and each request is recorded in
  the audit log. Asking is refused with `409` while the agent is paused or archived or AI is off
  (`agent_unavailable`), once it used its monthly limit (`limit_reached`), or while 5 runs asked of
  it still wait (`too_many_runs`). Covered in `scripts/agent-api-e2e.ts`.
- **Agents' usage and a monthly token limit.** Each turn a run takes is added to the agent's usage
  for the calendar month (UTC): runs, input and output tokens and cost, kept for 12 months. The
  agent's *Runs* tab shows this month against its limit and the months before; MCP's `get_agent`
  shows them too. An owner can set a monthly token limit in the agent's settings (or with
  `update_agent` and `PATCH /agents/{id}`): once the month reaches it, a run under way stops at its
  next turn as `limitReached` and no run starts until the next month. Migration `0067_agent_usage`
  adds `agent_usage` and `workspace_agent.monthly_token_limit`. Covered in
  `scripts/agent-api-e2e.ts`.
- **Dashboards.** The `/dashboard` block shows numbers, charts and lists from any of the
  workspace's databases on one page, in a grid of up to 12 widgets that each take a quarter, half,
  three quarters or all of its width (two columns on narrow pages, one on phones), and that can be
  moved and removed from their menu. A widget is a database seen through its own view: a new
  *Number* chart type gives one value (a count, or a sum, average or other calculation over the
  rows its filters keep), charts and lists are worked out on the server for each reader (only the
  rows and values they may see, and no rows sent for a chart), and other layouts show as a linked
  view. Widgets are set up in place with the linked view's own toolbar, update while their rows
  change, say under them how many rows they count, by what, with how many filters and when, and
  open the rows behind a number, bar or slice. A widget on a database the reader can't open says
  only that. Published pages show numbers and lists, and charts as a table of their figures; a
  widget on a database outside the publication shows nothing of it. In Markdown a dashboard is the
  line `<!-- leafdesk:dashboard <id> -->`, which keeps it through a rewrite. MCP's new
  `add_dashboard` and `update_dashboard_widget` add a dashboard and add, change, move or remove its
  widgets, and `get_page` lists dashboards and their widgets. Copies of published pages keep the
  widgets whose database was copied too. No migration. Covered in `scripts/dashboard-e2e.ts`.
- **Colored dashboard widgets.** A widget's menu has a *Color* row: a widget can take one of the
  option colors as its background, the same light tint board columns use, in light and dark
  themes. Published pages and the print view show the color too. MCP's `add_dashboard` and
  `update_dashboard_widget` take `color` (`"none"` for a plain box), and `get_page` lists each
  widget's color. Covered in `scripts/dashboard-e2e.ts`.

### Changed

- **Published charts show their figures.** A chart view on a published page (a published
  database's tab or a linked view in its body) shows its number, or a table of each group's value
  (and each stacked series'), worked out on the server from the public properties only, instead of
  a table of its rows; no rows are sent. A chart grouped or measured by a property visitors can't
  see shows nothing to group by, or counts rows. Covered in `scripts/chart-e2e.ts`.
- **Dashboards do less work.** An open dashboard used to reload every widget whenever any page in
  the workspace was created, renamed, moved or shared. Now a widget reloads when its own database's
  rows or properties change. Changes elsewhere in the workspace cost one request for the whole
  dashboard, which checks its databases' names, icons, trash state and the reader's access, and
  only the widgets of a database that changed reload. Sharing a single row now also refreshes open
  views of its database. A published or printed page reads each database once, however many
  widgets and database blocks show it, and each widget still applies its own filters, chart and
  list length. Covered in `scripts/dashboard-e2e.ts`.

### Fixed

- **A level set for an agent stays when an automation lets go.** An automation that runs an agent
  gives it edit access to its database and gives back the agent's previous level once no
  automation runs it. A level someone set or removed meanwhile from the Share menu was overwritten
  then (only the agent's settings counted as setting it); now any change to the agent's own entry
  keeps it. Covered in `scripts/agents-e2e.ts`.
- **Sign-in recovers when the database was down at startup.** The sign-in library queries the
  database when it is set up, and it was set up once, when the server loaded it: if the database
  couldn't be reached then, sign-in, sessions, MCP and its keys kept failing until a restart. It
  is now set up on first use and again after a failed setup, and `next build` no longer logs a
  failed query from every worker.
- **`list_agent_runs` names the waiting status as it returns it.** Its description said
  `waiting_for_approval` for a run that waits for an owner; runs come back as `awaiting_approval`.

## 0.5.1 — 2026-10-12

### Upgrading from 0.5.0

- **Migrations** (0049–0059) run automatically when the container starts.
- **Docker Compose:** download the new `docker-compose.yml`. It needs `POSTGRES_PASSWORD` for the
  bundled database (see below) and passes `AUTOMATION_DATE_CHECK_SECONDS` to the app.
- **Automations that set a date to today** use the day in the time zone of whoever saved them
  last. Automations saved before this release count as saved in UTC until someone saves them
  again; before, they used the server's day.
- **`TRUSTED_PROXIES` behind a proxy with a public address.** Unset, the app now trusts only a
  proxy that connects from a private address. If yours connects from a public one (a CDN in front
  of the app, a proxy on another server), set `TRUSTED_PROXIES=1` (or `2` for a CDN plus a proxy),
  or every visitor counts as the proxy's address. Proxies on the same machine or Docker network
  need nothing.
- **`POSTGRES_PASSWORD` is required for the bundled database.** Download the new
  `docker-compose.yml`: with `COMPOSE_PROFILES=bundled-db` and no `EXTERNAL_DATABASE_URL`, it
  refuses to start until `.env` sets `POSTGRES_PASSWORD`. If you never set one, your database
  has the old default: add `POSTGRES_PASSWORD=leafdesk` (and change it inside PostgreSQL later if
  you like). An external database needs nothing.
- **Allowed email domains must be verified.** A workspace's allowed domains stop letting people
  join, ask to join or find the workspace until an owner proves each one: Settings → Security
  shows the DNS TXT record to add at `_leafdesk-sso.<domain>` and a Verify button. Domains its
  single sign-on already verified keep working. Tell your workspaces' owners before upgrading. The
  record's value is derived from `BETTER_AUTH_SECRET`; changing the secret changes it for domains
  not verified yet.
- **Connection events start untrusted.** Migration 0053 adds a "Trust what this service sends"
  switch to each event trigger, off for existing ones: an agent run started by an event now waits
  for an owner's approval at its first connection tool call. In Settings → Connections → Events,
  trust only the triggers of services where nobody outside the workspace can make it send events.
- **Pages more than 64 levels deep.** Migration 0055 gives no access to a page the access rule
  can't follow to the top level within 64 steps, and sharing changes above such a page may be
  refused while it has entries of its own. Find them before upgrading, and move them or a page
  above them higher:

  ```sql
  WITH RECURSIVE d AS (
    SELECT id, 0 AS depth FROM page WHERE parent_id IS NULL
    UNION ALL
    SELECT p.id, d.depth + 1 FROM page p JOIN d ON p.parent_id = d.id WHERE d.depth < 200
  )
  SELECT id, depth FROM d WHERE depth > 64;
  ```
- **Migrations delete stored data nobody used.** Migration 0055 clears the access, refresh and ID
  tokens sign-in providers handed over (Leafdesk never read them). Migration 0056 deletes the page
  and property entries, calendar feeds and workspace-only API tokens of people who are no longer
  members of that workspace; none of them worked while they were out, but they came back if the
  person was let in again.
- **Verification links on another device.** Someone who signs up and opens the verification email
  in a browser that isn't signed in to the account is signed out everywhere else and asked to
  choose a new password, through a link emailed to the address, at their next password sign-in.

### Added

- **Rows open beside the view.** Clicking a row or card in a table, board, calendar, gallery, list
  or timeline, also in a database inside a page, opens it in a panel at the right, and the view
  stays usable next to it: title, icon, properties (with "N more properties"), the body edited
  together with who's there, comments (their panel opens alongside) and the row's menu, where
  Duplicate opens the copy in the panel and Move to trash closes it. The panel steps to the
  previous and next row in the view's order (buttons, or K and J outside text, listed under
  Keyboard shortcuts), opens the row as a full page or copies a link to it, and closes with its
  button or Esc, giving focus back to the row. The open row is in the address (`?row=`): a link or
  a reload opens it again, Back closes it, and moving between rows doesn't add to the history. Its
  width can be dragged (400–1,200 pixels, leaving the view at least 320) and is kept in the
  browser. A row trashed or moved out of its database by someone else, or one the viewer can't
  see, shows that in the panel. A view's layout menu has "Open rows in: Side panel / Full page"
  (side panel unless set), and MCP views take `open_rows` (`panel` or `page`); `get_database`
  shows `open_rows: "page"` on views that open full pages. ⌘/Ctrl-click and middle clicks open
  the row in a new tab; phones and offline pages open the full page. Published pages are
  unchanged. No migration.
- **Automations when a date passes, and moving rows to the trash.** A new trigger, *A date
  passes* (`date_passed`), starts an automation for each row whose date is at least a number of
  days past (0 for the day itself): a date property's start, when the row was added, or when it was
  last edited, optionally only for rows whose status is in some groups (to do, in progress, done; a
  row without a status counts as to do). So "rows not edited for 30 days that aren't done → set
  Status to Stale", "rows whose Completed on is 14 days past → move to the trash" and "the day a
  Due date comes, for rows not done → notify the assignee" are each one automation. Dates without
  a time count by the calendar of the time zone of whoever saved the automation last (the
  browser's in the app, `time_zone` over MCP, UTC without one), and the summary names that zone
  when it isn't the viewer's; times and added/edited times count by the clock. "Today" set by any
  automation is that day in the same time zone (it was the server's), and "whoever made the
  change" isn't offered for a date passing, which nobody's change starts. The server
  looks every 10 minutes (`AUTOMATION_DATE_CHECK_SECONDS`, one server at a time) and runs each row
  once per value of its date, again only once that date changes and passes again; a row restored
  from the trash doesn't run again for the same date, and the automation's own edit doesn't count
  as one. Rows that already match run at the next check, at most 100 per automation per check, and
  the dialog says how many match before saving. Rows in the trash, templates and databases in the
  trash are left out; a deleted date or status property, or a person who lost full access, pauses
  the automation with the reason shown in its settings. A new action, *Move to trash*
  (`move_to_trash`), always last and not with *Run an agent*, works with every trigger; the rows it
  trashes are restorable as usual, go with the trash retention, and are recorded in the audit log
  as `page.trashed` by the automation (a new actor kind, shown as "person (automation “name”)").
  Runs show in the run history as "Date passed" with the date; webhooks get the event
  `row.date_passed` with that `date`; notifications say the row's date has come. MCP's
  `create_automation` and `update_automation` take both and a `time_zone`, `list_automations`
  describes them and shows each automation's `time_zone` and a paused one's `check_error`,
  `list_automation_runs` gives each run's `date`.
  Migration 0058 adds the `automation_fire` table, `automation_run.basis`,
  `database_automation.time_zone` and `.check_error`, and the audit actor kind. Covered by
  `scripts/timed-automation-e2e.ts` and unit tests.
- **Row activity.** A row page has an Activity section under its properties, closed until opened
  (each browser remembers the choice): who created the row and who changed its title or a value,
  from what to what, newest first, a page at a time, updating while others edit. Every way values
  are written counts (the app, bulk edits, forms, quick add, MCP, the REST API, automations and
  agents, which are marked as such); a new row, also from an import or a template, is one
  "created" entry. Changes by the same person to the same value within five minutes are one entry
  (typing in a text, number or the title), and one that ends where it started leaves none.
  Formulas, rollups and who/when values aren't recorded. Viewers see the entries about values they
  may see in the row; linked rows they can't open read as "No access", and entries about a
  deleted property are left out until it is restored. Text is kept with credentials masked. MCP
  clients read it with `list_row_activity`, the REST API at `GET /api/v1/rows/{id}/activity`. The
  activity is kept apart from the audit log, which still leaves row content out, and goes with
  the row when it is deleted for good. Migration 0059.
- **Deleting a workspace.** Owners find Settings → General → Deletion. The dialog asks for the
  workspace's name, typed as shown, and the same proof as deleting the account (the password, a
  two-step code, or a recent sign-in); a mistyped name is refused before the proof is checked, so
  it doesn't use up a code. The workspace goes for every member, with its pages, databases,
  comments, teamspaces, groups, agents, connections and audit log; open editors of its pages are
  disconnected, everyone's sign-ins through its single sign-on connection end, and its files are
  removed from storage in the background. Everyone else in it gets an email saying who deleted it,
  in their language (when email is set up); the audit log goes too, so the server log records it.
  Someone left without any workspace gets a new personal one, as after leaving the last one.
- **Health endpoints.** `GET /api/health` answers 200 `{"status":"ok"}` whenever the server
  handles requests, without reading a session or the database. `GET /api/health/ready` also checks
  that the database answers within 2 seconds and has the newest migration this version ships with
  (a newer one, after going back to an older image, still counts as ready): 200 `{"status":"ok"}`,
  else 503 with which check failed, in fixed words only (`unreachable`, `timeout`, `pending`,
  `unknown`), never the database's error text; the server log gets the error code once per change.
  Both are open without sign-in, never cached and set no cookie. docker-compose.yml marks the app
  healthy on `/api/health/ready`; the image's `HEALTHCHECK` uses `/api/health`, so a database
  outage doesn't get the container replaced. No migration.
- **Calendar subscription of assigned rows.** The home page's "Assigned to you" header has a
  sync button that gives each person a secret address of their own per workspace, for their
  calendar app: the rows that list would show, from every database, that have a date they may see,
  as events at their times, else all day, ranges as ranges, titled by the row with its database's
  name and a link to it. Rows that are done, in the trash, templates, rows they can't open and
  dates or statuses hidden from them by property access are left out or decide nothing, as on the
  home page; it is not cut at the home page's 25 but holds what the 1,000 rows assigned to them
  that were edited last leave once done ones are out. The calendar is named after the workspace
  and "Assigned to you" in the language they last used. Shown once; it can be replaced or turned
  off, and it stops while the workspace's export or connected apps are off or once they leave the
  workspace. The section now stays, saying nothing is assigned, when the list is empty, so the
  address can be made beforehand. Migration 0052.
- **Import Word documents.** Import has a Word tab that takes one or more `.docx` files, each
  becoming a page under the chosen page or teamspace: titled by the heading it starts with (or its
  Title paragraph), else by its file name, with headings, bold, italic, underline, strikethrough,
  links, nested lists, tables with their header row, quotes, monospace paragraphs as code and
  footnotes as a list at the end. Pictures in the document are uploaded to the page; ones linked
  from outside it, of a type pages can't show or over the upload limit are left out and listed.
  Documents are read in a worker with time and memory limits; a damaged or old `.doc` file is
  refused with nothing created. Recorded in the audit log like other imports. No migration.
- **Restore deleted properties and views.** Deleting a database property or view no longer erases
  it: "Deleted properties" (at the bottom of a view's Properties menu) and "Deleted views" (under
  the add-view button) list what was deleted, by whom and when, and the day it goes for good, with
  Restore and Delete permanently. People who can change the database's properties see them; a locked
  database refuses both. A restored property comes back with its row values and with the filters,
  sorts, grouping, form questions and other view settings that named it; formulas and rollups that
  showed it as missing work again. A name taken meanwhile gets a number ("Estimate 2"). Deleting
  either side of a two-way relation now deletes the pair (it used to make the other side one-way),
  and restoring either brings both back, unless the other side is in a database you can't edit or
  that is locked: then only your side goes and the other becomes one-way. While deleted, a property
  is left out of views, row pages, filters, CSV and Markdown exports, the workspace backup, search,
  the API, MCP, forms, templates, automations (whose steps that set only it are skipped) and
  property access rules. Deleted properties and views are deleted permanently with the trash, after
  the workspace's trash retention. The audit log records them deleted, restored and deleted
  permanently. Migration 0051.
- **Date ranges and times.** A date can have an end ("Oct 12 → Oct 14") and a time of day
  ("Oct 12, 14:30", "Oct 12, 14:30 → 16:00"), switched on in the date picker with "End date" and
  "Include time". Times are kept as instants and shown in each viewer's time zone. Filters match a
  range on every day it covers, sorts and groups go by where it starts, rollups and the formula
  functions `dateStart` and `dateEnd` read both ends, timelines draw a range from its own end
  when no end property is set, reminders come before the start (at its time, for dates with a
  time), and calendar subscriptions, CSV and Markdown exports, CSV imports and imports from
  Notion carry both. The API and MCP keep returning a plain `YYYY-MM-DD` for a single day and take
  `start/end` strings or `{start, end}` for the rest. No migration: existing dates keep their
  meaning.
- **Calendar weeks and events over several days.** A date over several days is a bar across them
  in a calendar's month, and a calendar can show a week instead (Month / Week in its header,
  remembered by the view): dates with a time sit on its hours, all-day ones and times over several
  days in a strip above. Clicking an hour adds a row at that time, and dragging a row moves its
  whole date, both ends. MCP: `calendar_mode` on `create_database_view` and
  `update_database_view`. No migration.
- **Formulas over linked rows.** `prop("Tasks")` gives a relation's linked rows, and
  `prop(row, "Hours")` reads a property of one: `sum(map(prop("Tasks"), prop(current, "Hours")))`,
  `filter(prop("Tasks"), prop(current, "Done"))`, `find`, `some`, `every`, `first`, `last`, `at`,
  `sum` and `average` work on them, and `current` stands for each item. A relation alone still reads
  as its titles. Formulas read one step away (a linked row's own relations read as titles; a
  linked formula that reads linked rows itself can't be read) and up to the first 200 linked rows,
  loaded in one batch per database. They read only what you may see there: linked rows you can't
  open aren't in the list, and a formula reading a value hidden from you (or a property you don't
  know of) shows nothing, in sorts, filters, MCP and exports too. Published pages leave such
  formulas out, like rollups. The formula editor lists the linked database's properties under each
  relation. No migration.
- **Styled formula results.** `style(value, "b", "red")` shows a result bold (`b`), italic (`i`),
  underlined (`u`), struck through (`s`), as code (`c`) or in an option color, as text
  (`"blue"`) or background (`"blue_background"`); `unstyle()` removes it. Joined text keeps each
  part's style. Styles show in tables, board, gallery, list and calendar cards, the timeline,
  row pages and published pages, in light and dark; sorting, filtering, grouping, exports and MCP
  use the plain value. No migration.
- **Turn a table into a database.** A table block's menu (the handle beside it) has "Turn into
  database" for people who may edit the page: a database is made under the page, as an inline
  database is, and takes the table's place in one undo step. The first row names the properties
  (the first column holds the rows' names, the others become text properties; blank names become
  "Column N" and repeats are numbered, as in CSV imports), and every other row becomes a row with
  its cells as plain text. A merged cell's text goes to its first column; the cells it covers stay
  empty. A table with only a header row makes an empty database. Undoing brings the table back
  and leaves the database under the page. No migration.
- **Hide or show every property at once.** The properties list of a view's toolbar has "Hide all"
  while any property shows and "Show all" once none does, in every kind of view. The Name column
  always shows. No migration.
- **Hide properties on row pages.** Clicking a property's name on a row page (or "On row pages" in
  a table column's menu) chooses whether it shows on the database's row pages: always, only when
  the row has a value for it, or never. It is set for everyone; the properties a row page leaves
  out are listed under "N more properties" below the others, still editable. Published rows and
  their print show only the properties that aren't left out. Kept when the property's type
  changes. No migration.
- **Numbers as a bar or a ring.** A number property's "Number format" menu has "Show as": the
  number, a bar or a ring, with a color and the value a full one stands for ("Divide by": 100, or
  100 % for a percentage, unless set). Table cells, board and gallery cards, list rows, row pages
  and published pages show it, with the formatted number beside it; stored values, sorting and
  calculations don't change. Rollup bars and rings are drawn the same way. No migration.
- **Colors from the slash menu.** A "Colors" group at the end of the slash menu colors the current
  block's text or background in the formatting toolbar's palette ("Red text", "Blue background",
  and back to the default), found by the color's name in the interface language or in English.
  Blocks that take no color (code, images, databases) don't list them. No migration.
- **Code block languages.** A code block's language is picked from a menu at its top (plain text
  and 42 languages, from Bash, Go and Python to SQL, TypeScript and YAML), and its code is colored
  in that language, in the editor, on published pages and in the print view, in light and dark.
  Fences written with another name for a language (```` ```sh ````, ```` ```py ````) are read as
  it; a language the menu doesn't list stays as written, uncolored. No migration.
- **Search in a database view.** The magnifier in a view's toolbar opens a search box that narrows
  the rows to those whose name or values hold every word typed: option names, people, linked rows,
  checklist items, file names, text, numbers, links and formula results. Case, accents and the
  Turkish dotless ı don't matter. It is your own, for whichever view is open, and isn't saved;
  values hidden from you aren't searched. No migration.
- **"Assigned to you" on the home page.** Above the recently edited pages, the database rows a
  person property assigns to you and that aren't done, from every database in the workspace,
  grouped as overdue, today, the next 7 days, later and no date (by the row's first date property,
  in your time zone), each with its database and status. Only rows you can open count, and only
  where you may see the person property that names you; a status or date hidden from you neither
  shows nor leaves the row out. The 25 most pressing are listed, with the total when there are
  more. The section is hidden while nothing is assigned to you. No migration.
- **Date reminders.** A date property can remind people of its dates: on the day, or 1, 2 or 7
  days before, at 9:00 in the time zone of whoever turned it on (the property's menu → Date
  settings). The people of the row's person properties, or whoever added the row, get it in the
  inbox, by email and as a push, when they can see the row and the date; rows that are done, in
  the trash or templates are skipped. MCP: `date_options` on `add_database_property` and
  `update_database_property`. Migrations 0049 and 0050.
- **Relative dates.** A date property can show its dates as "Tomorrow", "In 3 days" or "2 days
  ago" (up to a week either way), with the full date on hover. No migration.
- **Snoozing notifications.** An inbox item can be put off for an hour, until tomorrow morning or
  until next Monday; it comes back unread then. Push notifications have a "Snooze 1 hour" button.
  Migration 0049.
- **Calendar subscription.** A calendar view gives each person a secret address for their
  calendar app, with the view's rows as events (at their times, else all day) as that person sees them, checked about
  every hour. Shown once; it can be replaced or turned off, and it stops while the workspace's
  export or connected apps are off. Migration 0049.
- **Quick add.** A new row's name can carry its date, `@people` and `#options` ("Send the offer
  friday @Ayşe #urgent"), in the interface language or English; what's recognised shows under the
  name and can be kept in it instead. No migration.
- **Quick notes and sharing to Leafdesk.** The installed app's icon offers a quick note, and
  phones that support it list Leafdesk in the share sheet: shared text and links open the quick
  note, saved as a private page in the workspace you pick. What was shared is posted to the app,
  so it never shows up in an address or a server log. No migration.

### Changed

- **Automation runs take turns by database, and at most 20,000 wait per database.** The worker
  took runs strictly oldest first, so one database's bulk edits (each row times each automation)
  held back every other database's automations until they were done, and nothing bounded how many
  could pile up. It now takes the oldest waiting run of each database in turn. A write that would
  leave more than 20,000 runs waiting for a database's automations starts only the first ones and
  the server log says how many it left out; the write itself is saved as before. No migration.
- **No default password for the bundled database.** docker-compose.yml no longer falls back to
  the password `leafdesk` for the bundled PostgreSQL, which a clone also publishes on the host's
  loopback for `pnpm dev`: while the app connects to it, `POSTGRES_PASSWORD` must be set in `.env`,
  as `BETTER_AUTH_SECRET` must. No migration.
- **Visitor addresses without `TRUSTED_PROXIES`.** Left unset, the app now trusts
  `X-Forwarded-For` from one proxy only when the request comes from a private address (loopback, a
  private network, as a proxy on the same machine or Docker network does). A visitor reaching the
  app's port straight from the internet is counted by its own address, so a header it writes no
  longer gets it past the per-address limits of public forms, uploads and sign-in or into the audit
  log as someone else. docker-compose.yml no longer sets `1` itself. A number you set is trusted as
  before, for every request. The server log says at start how visitor addresses are read. No
  migration.
- **Page changes in the audit log.** The audit log also records pages and databases being created
  (also by duplicating, from a template or from the web), imported (once per import, with how
  many pages it brought in), moved to another page or teamspace, put in the trash and restored.
  Database rows and the pages of templates are content and stay out of it, as edits do; a row
  deleted for good is still recorded. A page recorded before it had a title is listed under the
  title it has now. The "Deleting and publishing" filter is now "Pages". No migration.
- **Credentials masked in what agents, connections and automations keep.** Text that looks like a
  credential is kept as `[redacted]` in an agent run's steps, answer and error; in the input of a
  call waiting for approval, as owners see it in their inbox, in the agent's runs and over MCP
  (approved, the call is still sent as the agent made it); in a connection event's body as the
  runs it starts keep it; in a connection's error and an automation step's error; in the audit
  log's details; and in what the server logs about connections, agents, automations and AI
  provider errors. Masked are passwords in addresses (`https://user:[redacted]@host`),
  credential-named query parameters and fields (`token`, `access_token`, `api_key`,
  `client_secret`, `password`, an OAuth `code` in an address…), `Authorization` headers and
  `Bearer`/`Basic` tokens, private keys, and the token formats of Leafdesk itself, GitHub, GitLab,
  npm, Slack, AI providers, Stripe, AWS, Google and JSON Web Tokens; ids and ordinary words are
  left alone. Pages and rows are not touched, and a webhook sends the row as it is. The model
  still reads tool answers and its own conversation unmasked (an event's body reaches it masked),
  and a run waiting for approval keeps its conversation as it was until it ends. Already stored
  runs, events, errors and audit events stay as they are. Masking takes time in proportion to the
  text's length, however it is made up. No migration.
- **A clearer home page.** The home page greets you with today's date under the welcome, and
  shows the recently edited pages as cards in two columns, with titles up to two lines instead of
  cut off. The assigned section now says so when nothing is assigned to you instead of
  disappearing. No migration.
- **Allowed email domains are proven by DNS.** Anyone could add a domain they don't own to a
  workspace's allowed domains and so let in, or be found by, everyone signing up with it. A domain
  now counts only once its owner adds a TXT record (the same kind single sign-on asks for) and an
  owner clicks Verify; a domain one workspace has verified, for single sign-on or as an allowed
  domain, can't be verified by another. The audit log records it. No migration.
- **Adding someone by email needs a verified address.** Anyone can sign up with someone else's
  address, so adding a member by email, sharing a page by email, approving a member's invitation
  request, MCP's `invite_member` and SCIM provisioning only add an existing account whose address
  is verified. Others get the invitation emailed to the address, as someone without an account
  does ("invited", not "added"); SCIM answers 400 until the address is verified. Approving
  someone's own request to join no longer hands them the invitations waiting for an unverified
  address. No migration.
- **A verification link hands the account to the address's owner.** Following it in a browser
  that isn't signed in to the account ends its other sessions, removes its passkeys, two-step
  verification, API tokens and connected apps, and makes its password be replaced through an
  emailed reset link, so whoever signed up with the address first keeps nothing. Following it
  where you signed up, still signed in, changes nothing. No migration.
- **Leaving a workspace takes what it gave.** Leaving, being removed or being removed over SCIM
  now also deletes the person's page and property entries there, their calendar feeds of it and
  API tokens made only for it (after an owner takes over the pages only they could manage), so
  coming back starts afresh. Migration 0056 clears what earlier departures left.
- **File addresses in a page grant nothing by themselves.** Writing a file's address into a page
  let everyone who could read the page open the file. A file now loads on a page only once someone
  who can already open it puts it there (by editing, the API, MCP, a database value or a
  template); duplicates, templates and published copies keep that. A file held only in a files
  property that property access hides is no longer served through that row, to visitors of
  published pages either. References made before the upgrade keep working. Migration 0057.
- **Less in the Share panel for guests.** Access inherited from a page above names that page only
  to people who can open it ("From a page above"), and guests see people's names but not their
  email addresses, and that a group has access but not which one. No migration.
- **Published databases send less.** Visitors get each property's name, type and what drawing its
  values takes, not its whole settings (formula expressions, relation and rollup settings). No
  migration.
- **Notices name a database only to people who can open it.** Inbox items and assignment,
  reminder and automation emails leave out the database's name for someone who can open the row
  but not its database. No migration.
- **Event runs ask before acting.** Every connection tool call of an agent run started by a
  connection event waits for an owner's approval, unless its trigger is marked "Trust what this
  service sends". Owners approve the call exactly as it will be sent: the run shows it in full and
  unmasked, and the inbox offers Approve only when its shortened view is the whole call, else
  "Open the run to approve". Answering an agent's call holds owners to the workspace's two-step
  and single sign-on policies. A run started by an answer to a public form from someone outside
  the workspace acts with no more access than the form's publisher has. Migrations 0053 and 0054.
- **AI autofill leaves out rollups over restricted values.** A rollup over a related property
  that property access restricts, and formulas reading such a rollup, are no longer given to the
  model. No migration.
- **Formulas stop when they take too much work.** A formula gets 100,000 steps per row, `map()`
  and other lists at most 10,000 items, and `replaceAll()` and `formatDate()` results at most
  10,000 characters; past that, or on any other evaluation error, that formula shows "takes too
  much work" (or an error) on that row and the rest of the page loads. Nested list functions over
  linked rows could otherwise keep the server busy for minutes. No migration.
- **Pages nest at most 60 levels deep.** Creating, moving, duplicating, database rows, templates
  and imports refuse deeper pages, and the access rule gives no access to a page it can't follow
  to the top level, rather than the teamspace's default past a restriction higher up. Migration
  0055.
- **No sign-in provider tokens are kept.** Signing in with GitHub, Google, OIDC or single sign-on
  no longer stores the provider's access, refresh and ID tokens, and those stored before are
  cleared. SECURITY.md lists what is still stored as it is. Migration 0055.
- **Emoji icons only.** Page and teamspace icons take one emoji (up to 8 code points); creating a
  page from the app takes only the fields the app sends, with content up to 500,000 characters.
  No migration.

## 0.5.0 — 2026-10-09

### Upgrading from 0.4.0

- **Migrations** (0036–0048) run automatically when the container starts.
- **Docker Compose:** download the new `docker-compose.yml`. It passes the settings that are new in
  this release to the app (push notifications' `VAPID_*` and `PUSH_ALLOWED_HOSTS`,
  `AUTOMATION_WEBHOOK_ALLOWED_HOSTS`, `CONNECTOR_ALLOWED_HOSTS`, `LEAFDESK_ENCRYPTION_KEY` and
  `LEAFDESK_ENCRYPTION_OLD_KEYS`), and `API_RATE_LIMIT`, `MCP_RATE_LIMIT`, `API_CORS_ORIGINS` and
  `TZ`, which it left out until now; without it they stay unset in the container.
- **Open tabs ask to be reloaded.** A tab opened before the upgrade stops loading pages and shows
  a notice to reload; edits it hadn't synced yet stay in that browser.
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

- **Security policy.** `SECURITY.md` says how to report a vulnerability privately (GitHub's
  private vulnerability reporting), what a useful report contains, how quickly reports are
  answered, what is in scope, and that security fixes go into the latest release only.
- **`[[` links to a page.** Typing `[[` in a page opens a menu of the pages one can open, searched
  by title as typed; below them, "New page" creates a page inside the current one with that title
  and links to it. Typing `[[Title]]` out links to the page of that title when there is one and
  leaves the text as it is when there isn't; so does pasting text with `[[Title]]` in it, and
  Markdown written through MCP or the API (to pages the writer can open, never in code). The links are the same page mentions `@` makes, so
  they show under "Linked from" and in the graph. The `@` and `[[` menus now find titles with the
  dotted and dotless i whichever way they are typed ("ışık" finds "Işık"). No migration.
- **Graph.** A new page (the graph icon beside Home in the sidebar, or `>` in the search box)
  draws a workspace's pages, databases and rows as points, joined by links in page bodies,
  relations (a two-way one drawn once) and the page tree, and lays them out as they connect. Only
  pages the viewer can open are drawn, and no edge leads to one they can't; a relation counts only
  where they may see that property. A database with more than 30 rows in view is drawn as one
  point with their count inside, its rows' links and relations as one edge per page or database
  they lead to, thicker the more it stands for, until "Show rows" brings them out (a focused row
  always shows). Hovering a page brings out its neighbours; clicking it selects it and opens a
  card with what it is inside and what it is joined to, by kind (with counts), and buttons to
  open it, focus on it or show its rows; double-clicking opens it, Esc lets go, and buttons zoom
  in, out and to the whole graph. The box at the top focuses on one page and the pages one to
  three steps away. "Show in graph" in a page's menu opens that view of the page beside it,
  loaded again as pages change, with the full graph a click away. Switches hide the page tree,
  rows and pages without connections. Pages and databases are named from the start, rows once
  you zoom in (or all of them in a small graph); a name that would cover another, or a page
  named, moves to the other side or is left out until there is room. Past 3,000 pages the ones
  edited longest ago are left out. Drawn with `sigma` and `graphology` (new dependencies). No
  migration.
- **Context and unlinked mentions under "Linked from".** Each page in a page's "Linked from" list
  shows the text around its link, with the page's live title in place of the link (other pages'
  titles stay out of it). Below the list, folded away, are the pages that write the page's title
  as whole words without linking to it (last edited first; the trash, templates and pages the
  reader can't see left out); "Link" turns the first place a page writes it outside code into a
  page mention, for someone who may edit that page, also while it is open in an editor, and shows
  only where there is such a place. Titles match whether their letters are written precomposed or
  with combining marks. MCP's `get_page` gives
  each `linked_from` page its `context`. Migration `0048_page_link_context`: links already indexed
  get their context when their page is next saved.
- **Search filters and commands.** The search box (Cmd/Ctrl+K) narrows a search with
  `in:"Page title"` (that page and everything under it) and `type:page`, `type:database` or
  `type:row`, which also work on their own to list what they match; `in:` and the commands find
  titles with the dotted and dotless i whichever way they are typed. Before anything is typed it
  shows the pages last edited, and after `>` it runs commands (new page or database, from a
  template, import, trash, inbox, settings, keyboard shortcuts). A line under the results shows
  the syntax and puts it into the box. MCP and REST search keep their own parameters. No
  migration.
- **Import from Obsidian.** Import takes a vault's folder or a ZIP of it. Wikilinks (with labels,
  headings, block references and folder paths), Markdown links written by name and notes' aliases
  from front matter become page links, resolved across the vault: a path first, then the note of
  that name nearest the linking note, then an alias. Embedded images and files are uploaded, a
  note embedded on its own line becomes a link-to-page block, and callouts keep a matching color.
  Comments, highlight marks and block ids (those a link points to, and generated ones) are left
  out, so text such as `r ^2` stays; links naming nothing stay as text and are listed in the
  result. The import dialog no longer uploads hidden folders such as `.obsidian`, and a folder
  that holds one is still read as a vault.
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
- **More in a table's column menu.** A column's menu filters on it (adding a rule and opening the
  view's filters), groups by it or stops grouping, sets its footer calculation, wraps its cells,
  adds a property to its left or right in this view, freezes it and the columns before it while
  the table scrolls sideways (not on phones or windows too narrow to scroll), and duplicates the
  property with its settings, values and access rules right after it (a two-way relation is copied
  one way). The Name column gets the items that apply to it. Wrapped and frozen columns are view
  settings. No migration.
- **Changing a property's type.** The type under a property's name in its menu opens a list of
  types. Values convert in every row, trashed rows and row templates included: options keep their
  ids between select, multi-select and status, text becomes options, numbers, dates, people and
  links by title, and formulas and rollups keep what they showed. Relations, formulas and rollups
  are set up first, and a change that would clear values says how many and asks. Views drop the
  filters, sorts, groups and other settings the new type can't have; a two-way relation leaves its
  other side one-way. A property with access rules can't become a type they don't apply to. MCP's
  new `change_database_property_type` converts the same way and, with `dry_run`, only counts what
  would convert and what would be cleared. No migration.
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

- **New mark.** An ld drawn from the wordmark's own letters, a green l whose foot curves evenly
  toward the d, replaces the block-leaf mark in the app and touch icons, the favicon and the
  website's preview image. In the logo the mark sits in a dark tile beside the wordmark, so the
  logo is drawn a little taller to keep the letters their size. The wordmark and colors stay the
  same.
- **Dependency checks.** A weekly workflow (`.github/workflows/dependencies.yml`, also on changes to
  the lockfile) runs `pnpm audit --prod` and lists outdated direct dependencies. Advisories that
  can't reach a running server are reviewed in `pnpm-workspace.yaml` (`auditConfig.ignoreGhsas`,
  each with its reason); any other one fails the check. lodash-es 4.18.1 (under Mermaid's parser)
  and source-map-js 1.2.2 (under Next.js's PostCSS) are pinned by override for their advisories.
- **Bundle budget.** CI fails when the JavaScript a browser downloads grows past its budget: the
  largest first load of any route (the page editor, about 700 kB gzipped today, budget 800 kB) and
  all client chunks together (about 2,700 kB, budget 3,150 kB). `pnpm tsx scripts/bundle-budget.ts`
  after `pnpm build` prints the largest routes.
- **CI runs every end-to-end script.** The 34 `scripts/*-e2e.ts` that only ran by hand (agents,
  connections, AI, sub-items, templates, the REST API, SCIM, account security, two-step
  verification, single sign-on and the rest) now run on every push and pull request, the ones
  that need a server against the production build. Under its sign-in rate limit those scripts
  wait out a 429 (`scripts/auth-rate-limit.ts`); three had fallen behind the app and were brought
  up to date: a connection's MCP result has a note after its JSON, a password reset disconnects
  connected apps, and removing an SSO connection signs out who signed in through it.
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

- **A page opened right after a save could lose later changes.** The server unloads a saved page's
  document a moment after the save; when the page had been closed and opened again in between,
  that unload removed the new document instead, so the people editing it and the next server write
  (an MCP or REST write, linking a mention) worked on two copies, and closing the editor saved its
  copy over the other's changes. The unload now leaves a document that has replaced the saved one.
- **View access could rewrite a page's text through MCP and the REST API.** `update_page` (and
  `PATCH /api/v1/pages/{id}`) with `markdown` checked only that the caller could see the page before
  replacing or appending to its body, so someone with view access, or a connected app acting for
  them, could change it. It now needs edit access, like the title, icon and background already did.
  Checked in `scripts/access-e2e.ts`.
- **A tab left open from an earlier release could delete newer blocks.** Its editor dropped blocks
  it didn't know, and the deletion reached everyone. Each build now has an id: the collaboration
  server refuses a tab of another build before sending it a page, and the tab doesn't load its
  offline copies either. It shows a notice to reload instead; its unsynced edits stay in the
  browser.
- **Formulas:** `constructor()` and other names of built-in objects are reported as unknown
  functions.
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
