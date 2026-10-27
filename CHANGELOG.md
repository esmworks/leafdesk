# Changelog

## Unreleased

### Added

- **Keep a database in step with a Google Sheets sheet.** Import's new *Google Sheets* tab reads one
  sheet through the workspace's Google Sheets connection, so a private spreadsheet needs no public
  link: paste the sheet's address and each row below its header becomes a row, found again by its
  key column (the first column unless you name one) and kept up to date every 15 minutes to every
  day, or when asked. The header is the sheet's last frozen row unless you name another, so totals
  above it stay out; every other named column becomes a property by what its cells hold (numbers,
  dates, dates with times, checkboxes, else text as the sheet shows it), read typed so the
  spreadsheet's language doesn't change a number. Rows that leave the sheet stay. Changes come from
  the sheet, and with *Direction: Both ways* go back to it too: a change made in Leafdesk waits
  (migration 0155, table `sheets_write`) and is written to its cell at the next run, within about a
  minute, where the cell still holds the value from before it; where both changed, the sheet's value
  stays. The key column and columns of formulas are never written, new rows are added below the
  last row, and deleting a row deletes nothing in the sheet. Owners can sync through the
  connection, members once an owner allows the AI chat its `get_spreadsheet` tool (and
  `update_values` and `insert_dimension` to write back), checked again on every run; each read and
  write is in the audit log. Up to 100,000 cells.
- **Connect a Gmail or Google Workspace mailbox by signing in with Google.** Settings → Email and
  calendar offers *Google account* beside the app password: the member signs in at Google, allows
  Leafdesk to read and send their mail, and comes back with the mailbox tried and connected. No app
  password is needed, so it works where an organization turned app passwords off. IMAP and SMTP
  sign in with XOAUTH2; the access token is renewed as it runs out, and a sign-in taken back in the
  Google account shows on the mailbox, to sign in again. App passwords stay for every provider.
  Offered once the server sets `MAIL_GOOGLE_CLIENT_ID` and `MAIL_GOOGLE_CLIENT_SECRET`, a Google
  OAuth client with the redirect URI `<APP_URL>/api/mail/oauth/callback` (docs/email-on-rows.md).
  Migration 0153.

- **Automations that run when a total crosses a line.** A new trigger, *A total crosses a line*,
  watches a calculation over the rows a shared view shows: their number, or the sum, average,
  median, smallest or largest value of a number property. "When the sum of Amount in Cash and bank
  goes below 50,000" notifies once when the balance drops under it, and again only after it went
  back up and dropped once more. The total is worked out as the automation's person sees the
  view, a moment after rows change and every few minutes for filters on today; its steps get the
  value and the line as `{{trigger.value}}` and `{{trigger.threshold}}`. Over MCP the trigger is
  `view_threshold`. Migration 0152.
- **Dashboards show a period, and numbers their change from the period before.** A period above
  the grid (this week, month, quarter or year, last week, month, quarter or year, a range of days,
  or all time) cuts every widget's rows at once, on each widget's date property (the first date
  property by default, else the first created time; a widget without one shows every row and says
  so). Anyone may switch the period for themselves; editors can save it for everyone. A number
  widget shows the change from the period before of the same length, as "▲ 12 % vs Sep 2026",
  green or red as the widget says a rise is good or bad, or not at all; an earlier period without
  a figure shows none. Published pages and print show the saved period's figures and name it.
  Dashboard views of a database have the same period. Over MCP, `add_dashboard`,
  `update_dashboard_widget` and the dashboard views of `create_database_view` /
  `update_database_view` take `period`, and widgets `period_by` and `comparison`; the MCP tool list
  budget goes from 165,000 to 165,500 bytes for these settings. View filters gain *this quarter*,
  *last quarter* and *next quarter*, and the first-load JavaScript budgets go up by 1 kB for
  them (a page to 776 kB, all routes together to 1,181 kB). No migration.
- **Email a dashboard on a schedule.** *Email* above a dashboard (a `/dashboard` block or a
  dashboard view) sends its figures to chosen people every day, week, month or year at a time in a
  time zone, by default every Monday at 08:00 for last week. The email shows the period that just
  ended (or this week so far, or the dashboard's own period), each number with its change from the
  period before, lists and charts as short tables of figures, and a link back to the dashboard.
  Each recipient gets what they may see, worked out when it is sent; emailing others takes edit
  access to the page, and the email runs as whoever set it up, pausing when they lose access or
  the dashboard is removed. A link in the email (with one-click unsubscribe headers) and Settings →
  Preferences → Dashboard emails stop it; a test can be sent to yourself first. Setting up,
  stopping and sending are audit events. Needs SMTP. Migration 0154 adds `schedule.page_id`.
- **A new chat suggests questions to start from.** Under the empty full-page chat's box are
  questions about the pages you opened last (summarize a page, what's in a database) and the start
  of a search and of a new page; picking one fills the box without sending it.
- **Right-click in the sidebar for Leafdesk's own menus, with Open in new tab and Copy link.** A
  page's row opens its actions (rename, move to trash, keep offline) where it was right-clicked,
  now starting with Open in new tab and Copy link; other links there (My tasks, Meetings, Home …)
  get those two. Open in new tab opens a tab of the desktop app's window, or the browser's. A right
  click no longer selects the sidebar's text, and the page menu, from its button too, no longer
  runs off a narrow sidebar's edge.

### Changed

- **A table's column names stay in sight as you scroll down.** On a database's own page, the view
  tabs and toolbar stay under the top bar and the table's header row stays under them, while the
  title scrolls away. A database inside a page and every table on a phone keep the header row only.
- **Recordings are written down in the language people use Leafdesk in.** Dictation, voice notes
  and meeting recordings tell the speech to text server the recorder's interface language, so a
  few seconds of speech are no longer taken for another language.
- **Dictating in the AI chat shows how to stop.** While recording, the microphone becomes a red
  *Stop* button with the time in it, beside the button that cancels.
- **The AI chat's box is tidier.** *Chat* and *Research* are two tabs above the box; files and
  skills are in a *+* menu; *Answer from* (under the box in the panel), the mode and the model sit
  beside it as chips, the model shown by name ("Claude Opus 5.5") rather than id; dictation is next
  to *Send*, which fills in once there is something to send. The conversations in the sidebar are
  grouped by today, yesterday, the previous 7 and 30 days and older.
- **A crisper look across the app.** Grays lean slightly warm, with white surfaces edged by fine
  lines in the light scheme and a deeper black in the dark one; buttons are lifted by a soft
  shadow. A database's views sit on a track with the open one raised, and the line under the
  page's top bar and a database's views is gone. Board cards show their values side by side, each
  in a small chip of its own; a table's header row is gray with smaller text. Database titles are
  smaller and semibold, pages keep their large titles, and the sidebar's section labels are
  quieter.
- **A row opened from a database lies over the page's right side** instead of pushing the page
  aside. While it is open, boards and tables keep room at their end, and the opened card scrolls
  into view beside the panel when the panel would cover it.

- **Scheduled agents read only the web pages of their task and their searches.** A schedule's
  run used to read any address without asking, so text planted in a page or a row it read could
  make it send what it read to any site. It still searches freely, as its words reach only the
  server's search service, and reads pages whose address is in the schedule's task or among its own
  search results; any other page read is refused at once, without holding the run, and its steps
  show the address it didn't read. A helper's run for a scheduled run reads only its search
  results.
- **Images and other media an agent or the AI chat writes into a page become links when they
  would load another site.** An image, video, audio, embed or new bookmark loads its address as
  soon as someone opens the page (a bookmark through the server), so text planted in what the
  model read could make it hide what it read in such an address and have it sent out without a
  click. Those blocks are written as links to the same address instead; files uploaded to
  Leafdesk and media the page already showed stay as they are, and a row an agent proposed is
  written the same way once approved.
- **What models read from outside is framed more firmly.** Web pages, search results, connected
  services' answers and other agents' answers reach the model in a frame whose end line carries
  an id new each time, so text can no longer end the frame early and speak outside it. Characters
  that show nothing on screen (hidden Unicode tag characters, zero-width spaces, direction
  controls) are taken out of everything sent to a model, so a page or an email can't hide
  instructions in them.

### Fixed

- **Long AI answers are no longer cut off after a minute.** `AI_TIMEOUT_SECONDS` used to limit a
  whole answer, so a chat or agent turn writing many rows at once (a large tool call) failed with
  "The AI took too long to answer" while it was still coming. It now counts only silence: every
  part the provider sends starts it again, and the answer's length stays bounded by
  `AI_MAX_OUTPUT_TOKENS`.
- **AI work is limited by what it costs, not by turns or minutes.** A chat question took at most
  six turns, so a task that searched and read a few pages before changing one ran out of them and
  ended in "The AI gave no answer", although the change was made; agents stopped after 8 turns
  (16 on a schedule's run over a database) or 2 minutes (6), and research after 14 turns and
  400,000 tokens. Each chat question, research answer and agent run now goes on until it answers or
  has spent the new `AI_RUN_LIMIT_USD` (10 US dollars by default), and then answers with what it
  has; a last turn that still calls tools is asked once more, its calls not run, instead of
  failing. Models without a known price (local and OpenAI-compatible ones) take at most 100 turns.
  The workspace's rate and cost limits still count each turn; a long chat answer waits for the
  workspace's rate limit instead of ending with "Too many AI requests".
- **Text is drawn in the system's own typeface again** where Inter isn't installed. Since 0.6.4
  Latin letters fell to a Chinese typeface on macOS, whose faces came before the system's.
- **Recordings no longer end in lines nobody said.** Over silence or a mumbled stretch, Whisper
  models can write a subtitler's credit or a video's sign-off ("Altyazı M.K.", "don't forget to
  subscribe", "Thanks for watching") in the recording's language. Dictation, voice notes and
  meeting recordings now leave these out, and a recording that was only such a line counts as
  nothing heard.
- **The desktop app's tab strip takes clicks again on macOS.** Beside a page's sidebar, New Tab,
  back, forward and the tabs themselves moved the window instead (pressing New Tab twice zoomed
  it), because the page's own region for moving the window ran on under the strip. That region now
  ends at the sidebar.
- **A table's calculations sit right under its rows, and sums come out exact.** The footer row
  with the results comes before New and is closed off like a row; a sum or range keeps to the
  decimals its values have (19,966,877.69, not 19,966,877.689999998, also in rollups and charts);
  a long result no longer hides the label beside it.

## 0.6.5 — 2026-10-26

### Upgrading from 0.6.4

- **Download the new `docker-compose.yml`.** It passes the new `WEB_FETCH_ALLOWED_HOSTS` setting
  on to the app. An existing `.env` keeps working, with the change to allowed hosts below.
- **Migrations 0149 to 0151** run automatically when the container starts (from source, run
  `pnpm db:migrate`). They add the `unique_value` table with its triggers and
  `database_view.owner_id`.
- **Check your allowed-hosts lists.** In `CONNECTOR_ALLOWED_HOSTS` and
  `AUTOMATION_WEBHOOK_ALLOWED_HOSTS` a name without a port now reaches only ports 80, 443, 8080
  and 8443: write a service on another port with it, as in `n8n:5678`. Saving web pages,
  downloading files pages show and web link checks no longer use `CONNECTOR_ALLOWED_HOSTS`; list
  hosts on your own network they should reach in `WEB_FETCH_ALLOWED_HOSTS`.
- **The AI chat asks before every web search and page read,** in every mode, research included.

### Added

- **Calendar and PostgreSQL syncs.** Import has two more synced sources. *Calendar* takes an iCal
  address (Google Calendar's secret address, an Outlook published calendar, any `.ics` or
  `webcal://` feed) and keeps a database of its events from 90 days back to a year ahead, each
  occurrence of a repeating event a row of its own, with a calendar view. *PostgreSQL* takes a
  connection address and a table or view and keeps a database of its rows (up to 5,000), a property
  for each column by its type, read in a read-only transaction; a server on your own network needs
  its host in `CONNECTOR_ALLOWED_HOSTS` (with its port unless it is 5432). Both sync every 15
  minutes to once a day or on demand, one way, with the address kept sealed. A PostgreSQL run hangs
  up after a minute and reads at most 50 million characters, each value cut at 10,000; keys past
  2^53 keep every digit.
- **Personal views.** *Only for me* when adding a view: nobody else sees, changes or finds it in
  the sidebar. Anyone who may read a database can make them, on a locked database too, so people
  with view access keep their own filters and layouts; *Share with everyone* turns one into a
  shared view. They are never published or copied with the database, and go when their person
  leaves the workspace. MCP's `create_database_view` takes `personal`. Migration 0150 adds
  `database_view.owner_id`.
- **Forms that ask one question at a time.** A form's builder has *One question at a time*: each
  question on a page of its own, with a progress bar, Back and Next, each answer checked before the
  next question, in the app and on public form links. The AI chat's `create_form` takes
  `one_by_one`, and MCP's `get_database` reports it.
- **Ratings and durations.** *Rating* and *Duration* when adding a property: a rating shows 1 to
  10 stars, clicked right in the cell or a form, and a duration shows minutes as hours and minutes
  ("1:30"), typed as `1:30`, `1h 30m` or minutes. Both are number properties in new formats
  (`rating` with `max`, `duration` with `seconds` in MCP's `number_format`), so filters, sorts,
  calculations, charts and rollups work on them as numbers; values a rating can't hold are refused.
- **Unique values.** A text, number, email, URL or phone property can keep its values unique
  (*Unique values* in its menu, `unique` in MCP's `update_database_property`): a value another row
  already holds is refused, case and spaces aside, however it is written. It can't be turned on
  while two rows share a value, a row in the trash frees its value, and a duplicated row leaves it
  out. Postgres keeps the rule, so imports, the API, automations and syncs are held to it too;
  pastes, imports and synced databases leave out a repeated value and count it with the other
  values that couldn't go in. Migration 0149 adds the `unique_value` table and its triggers, 0151
  indexes each value's hash so long values fit.

### Changed

- **A bare host name in an allowed-hosts list reaches only the usual ports.** In
  `CONNECTOR_ALLOWED_HOSTS`, `AUTOMATION_WEBHOOK_ALLOWED_HOSTS` and the new
  `WEB_FETCH_ALLOWED_HOSTS`, a name without a port allows ports 80, 443, 8080 and 8443 (and 5432
  for PostgreSQL syncs); name any other port, as in `n8n:5678`. An entry such as `n8n` for a
  service on port 5678 stops working until its port is added.
- **Addresses members give no longer reach hosts in `CONNECTOR_ALLOWED_HOSTS`.** Saving a web
  page, downloading a file a page shows from another site and web link checks reach public
  addresses only; the new `WEB_FETCH_ALLOWED_HOSTS` lets them reach hosts on your own network.
  Connections, their sign-ins and synced databases keep using `CONNECTOR_ALLOWED_HOSTS`.
- **One import per person at a time.** A second import while one is reading its files (or while
  the server runs three) is answered "Another import is still running".
- **MCP `invite_member` invites only members and guests.** Owners and membership admins are made
  in Settings → Members.
- **The AI chat asks before every web search and page read.** What a call carries leaves the
  workspace, so text planted in a page could make the chat send what it read to any address. Each
  `search_web` and `read_web_page` now waits for the person's approval in every mode (Auto, Read
  only and research too), showing the exact words or address in the app and in the Telegram bot. A
  page whose address the person wrote in the conversation is still read without asking.
- **Agents' runs asked for in words wait for an owner before web calls they weren't given.** On a
  chat, mention or request run, a page read or search whose address or words aren't in the
  person's message waits for an owner (and is refused at once where no owner can answer); a
  helper's run for such a run waits before every web call.
- **A Jira sync's sign-in reads only what its owner set it to read.** Others with full access give
  their own email and token to change the query or list projects. Syncs set up before this need
  the sign-in given again for that.
- **The desktop app keeps tabs on your server.** Pages that lead to other sites open in the
  system's browser; single sign-on started from the sign-in page still happens in the tab, which
  shows the identity provider's host until it is back. The connect screen asks before using plain
  HTTP or following a server to another host, certificate trust warns when a server's good
  certificate is replaced (*Forget Trusted Certificates* drops trusted ones), pages ask once per
  server before using the microphone and no longer read the clipboard, and the packaged app sets
  Electron's fuses (no `NODE_OPTIONS` or `--inspect`, asar only with integrity checks, encrypted
  cookies).
- **Client bundle budgets** go to 774 kB for a page's first load and 1179 kB for all first loads
  together, for the web-call approvals, the invitation limit note and the sign-in policy gate.

### Fixed

- **Turning a page into a teamspace keeps closed sub-pages closed.** Sub-pages the person turning
  it has no full access to move with it but keep their own sharing; before, a sub-page closed to
  everyone else opened up to the new teamspace, that person first. The dialog counts only the
  sub-pages they can see, and a top-level page of a teamspace whose top level is locked can only
  be turned by those who may arrange it.
- **Crafted import files no longer freeze the server.** Readers of web archives, Markdown, Notion
  and Obsidian exports, Evernote notes, CSV and Excel files, Asana, Monday and Trello boards and
  Confluence exports read in time growing with the file's length; files whose path is longer than
  2,048 characters or 100 folders deep are left out with a warning. Imports check where they go
  before reading any file, so someone who can't add pages there, or isn't in the workspace, is
  refused before the upload is parsed.
- **Workspace sign-in policies cover the review queue, email on rows, follow-ups, watched pages
  and the row panel.** A session held back by approved networks, required two-step verification
  or SSO only could still list and answer changes for review, read and send a row's email, and
  start or stop follow-ups. Such a session can no longer link Telegram or change an API token's
  scopes either, as it already couldn't make a token; it is sent to meet the policy first.
- **Turning two-step verification on signs out your other devices.** Sessions signed in earlier
  with the password alone kept working and counted as two-step. Every session that ends, by
  signing out, revoking sessions, turning two-step on or claiming an account, now also closes its
  live collaboration connections.
- **Claiming an account by its address removes the earlier holder's other logins.** The earlier
  GitHub, Google and single sign-on logins now go too, not only the password, passkeys and
  two-step setup, so someone who signed in through an identity provider that doesn't vouch for
  addresses (`OIDC_ISSUER` without `OIDC_DOMAINS`) can't sign in again. Resets of verified accounts
  leave their logins alone.
- **Invitation emails are rate limited:** 100 an hour per person inviting, 200 per workspace and 3
  per invited address. Past a limit the invitation is still made and its link shown to share, and
  MCP's `invite_member` answers `email_sent: false` with a note.
- **What a connection's tool returns makes the AI chat ask before changes.** Once a service
  answered (mail, issues written by outsiders), Auto asks before every change and note for the
  rest of the answer, as it already did after reading the web.
- **A stalled synced database no longer holds up the others:** a run gets eight minutes before
  the sweep moves on.
- **Setting up a sync checks access before reaching out.** Jira, GitHub, calendar and PostgreSQL
  setups check that you may make the database there before contacting the other server; checking
  a Jira sign-in needs workspace membership; setups and checks are limited to 10 a minute and 60
  an hour per person. Jira and GitHub answers are read up to 10 MB and 20 MB, and a connection's
  server can send at most 20 MB in one answer.
- **Duplicating a page, or saving or using a template, copies the edits still on screen,** not
  only what was last saved.
- **Uploads to public forms are limited in size:** 256 MB an hour per address and 1 GB waiting per
  database; uploads whose answer never came go after two hours. Public form answers also follow
  dependent selects.
- **Duplicating a published page copies only the rows its database views show on the web.**
- **MCP `list_automations` no longer returns webhook secrets or incoming webhook addresses** where
  the workspace lets connected apps only read.
- **Server fetches refuse Azure's platform address 168.63.129.16, and `attach_file` downloads keep
  to the usual web ports.**
- **A restored backup's site settings are checked as saving them is.**
- **GitHub pull request deliveries are remembered for 30 days, so a resent one is refused.**
- **Only the person who began a connection's sign-in can finish it.**
- **The desktop app signs in to Leafdesk on this computer only once its own server holds the
  port.** The server reports it over its IPC channel, and in local mode answers only to
  `127.0.0.1` and `localhost`.

## 0.6.4 — 2026-10-26

### Upgrading from 0.6.3

- **Download the new `docker-compose.yml`.** It passes the new settings on to the app:
  `APPLE_CLIENT_ID`, `APPLE_CLIENT_SECRET`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`
  (Sign in with Apple) and `WEB_LINK_CHECKS`. An existing `.env` keeps working unchanged.
- **Migrations 0136 to 0148** run automatically when the container starts (from source, run
  `pnpm db:migrate`). They add tables and columns; 0141 redefines the page access rule. 0147 and
  0148 queue the existing pages, whose to-dos and `#tags` the server then indexes in the
  background after the upgrade.
- **The image installs the Noto CJK fonts**, for Chinese, Japanese and Korean text in PDFs made on
  the server, which makes it larger.
- **Broken web links are looked for once a week:** the server fetches the web addresses in pages
  (as for bookmarks) to list the ones that stopped working in Settings → Health. Set
  `WEB_LINK_CHECKS=off` to keep it from fetching them.
- **The desktop app's new tab layout on macOS needs this server:** with an older one it keeps the
  tab strip across the top.

### Added

- **Dictate into a page at the caret.** Where voice notes work, Cmd/Ctrl+Shift+D in a page you can
  edit, or `/` *Dictate*, records and writes what you said where the caret was, as you said it (no
  AI rewrite), replacing what was selected then. Press the keys again, Enter or the chip beside the
  caret to finish, or hold the keys while you talk and let go; the chip shows *Starting*,
  *Listening* with a level meter, and *Writing…*. Esc, clicking elsewhere in the page, leaving it or
  starting another dictation cancels without writing. The text goes in as one undo step, spaced
  from the words around it, follows edits made around its spot meanwhile, and goes to the caret or,
  failing that, the clipboard when the spot is gone. Not in code blocks or read-only pages; the
  recording limits, usage limits and the workspace's AI setting apply as for voice notes, and the
  transcription counts as voice usage (`voice.dictate`; the transcribe route takes `use=page`). The
  shortcut is in the keyboard shortcuts list. Dictating in the AI chat's box and in a page now
  cancel each other.
- **To-dos written in pages show up in My tasks.** An unticked to-do that mentions someone is
  listed in their My tasks and on the home page beside the rows assigned to them: its text without
  the mentions, the page it is on with its icon, and the first date mentioned in it as its due
  date, grouped by date like rows (or under its page when grouped by database). Clicking one opens
  the page at the to-do; ticking it ticks the to-do in the page, for people who may edit it. The
  calendar feed of assigned rows includes the dated ones. Group and agent mentions don't count.
  Migration 0147 adds the index (`page_task`), kept in line on every save, and queues the pages
  written before it, which the server indexes in the background after the upgrade.
- **`#tags` in page text.** Write `#tag` anywhere in a page (letters, digits, `_` and `-`, at
  least one letter, `/` for a hierarchy such as `#home/renovation`) and find every page carrying
  it with `#tag` or `tag:tag` in the search box; a tag also finds the tags under it, and case and
  accents don't count. Tags stay plain text: code, equations, diagram sources, links and mentions
  hold none, and `# ` at the start of a line still makes a heading. Typing `#` and a letter in the
  search box or in a page offers the tags of pages you can open, most used first with how many
  pages carry each; pages mark tags in the accent color, and clicking one (with Ctrl or Cmd where
  the page can be edited) searches for it. MCP's `search` and the REST API's `GET /search` take a
  `tag`. Migration 0148 adds the index of tags, kept in line on every save, and queues pages
  written before it, which a background job reads once; a restored workspace's pages are read
  again the same way.
- **Type dates in words, everywhere a date is typed.** One grammar reads dates after `@` in a page,
  in a new box on top of a date property's picker, in a date mention's menu (for its date and for
  a reminder at any time) and under a date filter's value; the box shows what the words name and
  Enter sets it. Besides what `@` read before (today, next friday, in 3 days, 3 days ago, ISO
  dates, in the interface language and English) it takes weekday abbreviations (`fri`, always the
  next one), months by three letters or more (`aug 31`, `31 sept`, `aug 31, 2027`), slash dates
  read in the language's or the date property's order unless only one number can be the month,
  times (`fri 5pm`, `aug 31 at 9 pm`, `17:30`, or a time alone: today, or tomorrow once passed),
  durations from now (`30m`, `4h`, `3d`, `2w`, `2mo`, with or without `in`) and `+2w` / `-3d`
  counted from the date shown. A time sets a date property's time only with *Include time* on; in
  `@` (`@fri 5pm`) it gives the date mention a reminder then. Bare numbers, two-digit years, days
  that don't exist and `in +2w` are refused rather than guessed. `next friday` and `next week`
  now count weeks from the first day of the week in the interface language there.
- **Named versions in page history.** People who can edit a page save a version with *Save
  version* in the page history or Cmd/Ctrl+S on the page (listed in the keyboard shortcuts), and
  can give it a name. When nothing changed since the newest version, that version gets the name
  instead of a copy being saved. Any version can be named, renamed or have its name cleared from
  the history, which shows a named version's name in place of its kind and can list named
  versions only. The daily history cleanup never removes named versions, and they don't count
  toward its 200 versions per page; legal holds work as before. MCP's `get_page_history` and the AI
  chat's page history give a version's `name`. Migration 0146 adds
  the column.
- **Import TextBundles, TextPacks and OneNote exports.** Import's Markdown tab takes `.textpack`
  files, ZIPs of them and folders of `.textbundle` folders: each bundle becomes a page titled by its
  heading (else its name), with the pictures and files of its `assets/` folder that the text shows
  uploaded. A new *OneNote (.mht)* tab takes OneNote's *Single File Web Page* export: a page's file
  becomes a page, a section's file a page named after it with one page under it per OneNote page,
  their pictures uploaded and OneNote's tag icons left out. Any other web page saved as one file
  (`.mht`, `.mhtml`) comes in on that tab as one page. Nothing outside the file is fetched. The
  import route takes `mode=mhtml`, and the audit log names the formats.

- **Save to Leafdesk browser extension.** A new extension for Chrome, Edge and Firefox
  (`extension/`, a zip in every release) saves the page you are on from its toolbar button
  (Alt+Shift+S), and a page, a link or selected text from the context menu. It opens Leafdesk's
  quick note on your own server, where you choose where it goes or save the whole page, and sends
  nothing anywhere else.
- **Read aloud.** A page's ••• menu has *Read aloud*: the browser's own speech reads the page
  block by block, marking the block being read, with pause, previous and next block, speed and
  voice. Nothing leaves the device.
- **Related pages.** Under a page's backlinks, up to five pages close to it in meaning that it
  doesn't link to yet, with when each was last edited and its closest passage. They come from the
  embeddings semantic search already keeps, so no model is called; the list shows only where the
  server has an embeddings model and the workspace has AI on.
- **Broken web links in Settings → Health.** Web addresses in pages and URL properties that stopped
  working: the server fetches them in the background about once a week, lists 404 and 410 at once
  and a site that is down only after three failed checks a day apart. `check_workspace` over MCP
  reports them too. Migration 0145 adds the `web_link_check` table; the new `WEB_LINK_CHECKS=off`
  stops the server from fetching them.
- **Sort search results.** The search box has a *Sort* menu beside its filters: best match (the
  default), or last edited or created, newest or oldest first. A date order takes every page that
  matches into account, not only the best few.
- **Whimsical embeds.** A link to a Whimsical board, flowchart, wireframe or doc embeds it in a
  tall frame, a pasted one offers *Embed*, and `/whimsical` finds the Embed block.
- **Empty toggles look empty.** A toggle with nothing in it shows a fainter arrow, so you can tell
  without opening it.
- **A heads-up before adding to a large teamspace.** A new page or database at the top of a
  teamspace of ten people or more asks first, once per teamspace in each browser.
- **Code block captions, and a web link's address on hover.** A code block's menu has *Caption*: a
  line under the code, kept with the block, shown on published pages and in PDFs, and written in
  Markdown (MCP, the API, exports) as `<!-- leafdesk:caption … -->` right before the fence. Resting
  on a web link in a page shows where it goes at the start of its toolbar.
- **Link pages as you write: `+`, the link button and "Turn into page in…".** `+` and a title after
  a space offer a new page inside this one, linked where you typed (or a page of that title). The
  formatting toolbar's link button (Cmd/Ctrl+K) searches the workspace's pages besides taking a web
  address, so the selected text can link to a page, or to a new page with the text as its title. A
  block's menu has *Turn into page in…*: the block, or the selected blocks, become a page inside
  this one, under another page or as a row of a database, the first block's text as its title, and
  a link to the new page takes their place. The client bundle budgets go to 767 kB for a page's
  first load and 1169 kB for all first loads together for these.
- **Backlinks below the page, in a popup or hidden.** A page's ••• menu has *Backlinks*: *Below the
  page* as before, *In a popup* (a "N pages link here" button under the title opens the list), or
  *Hidden*. Kept with the page's style in its document, so it applies for everyone and comes along
  with copies and templates.
- **`/new` makes a page, and the browser tab shows the page's icon.** Typing your Leafdesk address
  with `/new` (or a bookmark of it) makes a private page in the workspace you were in last and opens
  it with the caret in its title; `?workspace=<id>` picks another. A page's emoji or built-in icon is
  its tab's icon, following changes as they happen (drawn by `/api/page-icon`).
- **Timelines zoom out to quarters and years.** A timeline's *Zoom* has *Quarter* (years above) and
  *Year* (decades above) besides day, week and month, laying out up to thirty and a hundred years;
  MCP's `zoom` takes `quarter` and `year`.
- **Rollups show unique values, quotes start with `|` or `"`, and Cmd/Ctrl+P searches.** A rollup's
  *Show unique values* lists each related value once (MCP's rollup function `show_unique`). `|` or
  `"` and a space at the start of an empty line start a quote, as `>` does. `/ltp` finds *Link to
  page*. Cmd/Ctrl+P opens search too, and Cmd/Ctrl+K with text selected in a page is the link box
  only, without opening search behind it.
- **More over MCP: comment changes, meeting notes, chats with agents and moving many pages.**
  `change_comment` edits or deletes a comment, deletes a thread, resolves or reopens it, reacts to
  a comment or marks the thread *Come back later*; `add_comment` also starts a thread about the
  whole page, or on a row's value with `property` (the REST API's comment endpoint takes both too).
  `list_meeting_notes` lists a workspace's meetings, narrowed by words and days. `chat_with_agent`
  sends a message to an agent as the app's agent chat does and waits for its answer, and
  `get_agent_chat` reads those conversations. `move_page` takes `page_ids` to move several pages
  to one place. The tool list stays within its budget (90 tools, 164 KB).
- **Sign in with Apple.** Set `APPLE_CLIENT_ID` with either `APPLE_CLIENT_SECRET` or, so the
  secret never runs out, `APPLE_TEAM_ID`, `APPLE_KEY_ID` and `APPLE_PRIVATE_KEY`: Leafdesk then
  signs a new client secret itself before the old one expires (see
  [Social login](docs/self-hosting.md#social-login)).
- **Lock a teamspace's top-level pages.** Teamspace settings have *Lock top-level pages*: only those
  who manage the teamspace then add, move, reorder, trash or restore the pages at its top, while
  members keep editing in and under them. The REST API and MCP list it as `top_level_locked`.
  Migration `0144_teamspace_top_level_lock`.
- **Chemical equations.** Equations understand `\ce{…}` and `\pu{…}` for chemical formulas,
  reactions and units.
- **Miro embeds.** A Miro board link embeds as a live board, a pasted one offers *Embed*, and
  `/miro` finds the Embed block.
- **Ctrl+Shift+L switches between light and dark** (⌘⇧L on a Mac); the keyboard shortcuts list
  shows it.
- **Go to a collaborator.** Clicking someone among the people in a page's header scrolls to where
  they are typing.

- **Report a published page.** Published pages and site pages have *Report page* at their foot,
  for visitors without an account too: a reason, a few words and, if they like, an email address.
  The workspace's owners hear about it in their inbox (once a day per page) and handle the open
  reports in Settings → Security: *Take off the web* unpublishes the page, *Dismiss* closes the
  report; reports and what was done with them are in the audit log (`page.reported`,
  `page.report_dismissed`). Five reports an hour per address, thirty a day per public address.
  Migration `0143_page_reports`.
- **Large quotes.** A quote's block menu has *Quote size*: the size of the text around it, or large
  for a pull quote, in the editor, on published pages, in the print view and in PDFs. Markdown and
  MCP write `<!-- leafdesk:large-quote -->` before a large one.
- **Chinese, Japanese and Korean text in PDFs.** *Export as PDF* sets CJK text in Noto Sans CJK, in
  the face of the reader's language, where the server has the font. The Docker image now installs
  Debian's `fonts-noto-cjk` (about 90 MB more); other installs add that package or its
  equivalent, or keep printing such text as empty boxes as before.
- **Replit, Excalidraw, Framer and Sketch embeds.** Links to a repl, an Excalidraw drawing (shared
  or live), a Framer prototype or a Sketch document, artboard or prototype embed in their own
  players, a pasted one offers *Embed*, and `/replit`, `/excalidraw`, `/framer` and `/sketch` find
  the Embed block.
- **Nested numbered lists count in letters and roman numerals.** A numbered list inside a numbered
  list counts a, b, c, the next level in i, ii, iii, then numbers again, in the editor, on published
  pages, in the print view and in PDFs.
- **Text size of PDF exports.** *Export as PDF* has a *Text size* menu, from 75 to 150 percent;
  the letterhead keeps its size.
- **More currencies.** The number format menu offers over 40 currencies, and the one you last
  picked comes first and is what the next new amount starts in.
- **Julia code blocks** are colored like the other languages (`julia`, `jl`).
- **A code block's language from the keyboard.** Cmd/Ctrl+Alt+L in a code block opens its language
  menu; picking one goes back to the code.
- **New quotes take the size last picked.** The *Quote size* picked in a quote's menu is what new
  quotes start with in that browser.
- **Faces for Chinese, Japanese and Korean.** Such text is set in sans and serif faces chosen for
  each language (by the app's language), on pages, published pages and the page's *Serif* typeface.
- **Back to where you were when switching workspaces.** With *Start page* set to the page opened
  last, switching to another workspace opens the page you opened last there.
- **A date mention's day in full.** Resting on a date mention shows its day with the weekday (and
  its reminder, when it has one).
- **Sub-groups on boards.** *Sub-group* on the Group page of a board's *View settings* splits the board into sections by a
  second property (a status, a select, a person, a date…), each holding every column: a card
  dragged into another section changes both values, and *New* in a section's column starts the
  card with both. Sections fold away (for everyone when you may change the view, else just for you),
  Cmd/Ctrl+Alt+T opens or closes them all, and *Hide empty groups* leaves out empty ones too. The
  same menu's *Color columns* turns the option colors of the columns off. MCP's
  `create_database_view` and `update_database_view` take `sub_group_by` and `color_columns`, and
  `get_database` names them.
- **Group lists and galleries.** Lists and galleries group their rows into sections by a property,
  like tables: each section folds away, can be hidden and adds rows with its value, published pages
  show the sections, and MCP's `group_by` takes them.
- **Colors and headers in simple tables.** A table block's row and column handles color their
  cells' text or background and make the first row or column a header, in the editor, on published
  pages and in PDFs.
- **Typographic quotes.** Quotes typed in a page become “ ” and ‘ ’ (and ’ in "don’t"), except in
  code, code blocks, equations and diagram sources; Backspace right after one gives back the
  straight quote.
- **Copy a value from a row page.** Text, number, URL, email, phone, ID, created time and last
  edited time values have a copy button beside them on row pages.
- **Links in rollups.** A rollup showing the related rows' URL, email or phone values shows each
  as a link that opens it.
- **Start on the page you left.** My account → Preferences → *Start page* opens Leafdesk on the
  workspace's home page (as before) or on the page you opened last, on any device, while your page
  views are recorded. Migration `drizzle/0142_open_on_start.sql` adds
  `user_preference.open_on_start`.
- **Copy link to original, and open a linked page in a new tab.** A bookmark's or embed's block
  menu copies the address it shows, beside *Copy link to block*, and a link to a page has *Open in
  new tab*.
- **All of a view's settings in one menu.** The layout button beside a database's toolbar is now
  *View settings*: its layout, properties, filters, sorts and grouping, each a page of the menu,
  then the layout's own settings and *Duplicate* and *Delete*. The calendar date and grouping
  moved there from the toolbar. A table, board, calendar, gallery, list, feed, timeline or map view
  can now switch to any of the others, keeping its filters, sorts, properties and grouping; MCP's
  `update_database_view` takes the new layout as `type`.
- **Page covers.** The background picker has a *Cover* row: a band across the top of the page in one
  of eight gradients, shown on the published page too. Like colors and patterns, covers are drawn by
  the app's stylesheet and load no image; MCP and the REST API read and write them as
  `cover:<name>` in the page's `background`.
- **Import a Confluence space.** Import has a Confluence tab: a space exported as HTML (a ZIP)
  becomes pages nested as in the space, with info panels as callouts, code macros as code blocks
  in their language, expand sections as toggles, task lists as to-dos, links between pages as page
  links, and pictures and linked attachments uploaded under their own names (`POST /api/import`
  `mode=confluence`).
- **Load limit for boards and galleries.** A board column and a gallery show 50 cards, then *Load
  more* adds as many again; Layout → *Load limit* sets 10, 25, 50 or 100 per view (MCP
  `update_database_view` `load_limit`). Filters, sorts and counts still take every row. List views
  draw only the lines near the visible part of the page from 120 rows on, as tables do.
- **Writing synced blocks and tables as Markdown.** Markdown written over MCP, the REST API or
  *Edit as Markdown* now saves what changed between a synced block's marker lines to its blocks,
  when the writer may edit the original page (that page is saved to its history first; writing
  back what `get_page` read changes nothing, and a synced block with nothing between its lines is
  only placed; imports and new pages only place synced blocks). *Edit as Markdown* shows the blocks of synced blocks from other pages too, and warns
  only of changes to ones you may not edit. Tables rewritten from Markdown keep their column
  widths, header rows and columns, cell colors and alignment.
- **Sync GitHub pull requests.** Import has a GitHub tab: a repository (and a token for a private
  one, or a GitHub Enterprise Server's address) becomes a database of its pull requests that stays
  in step one way, with number, state (Draft, Open, Merged, Closed), author and assignees (people
  who sign in with that GitHub account, others by login), labels, branches, dates and a link, and a
  board by state. It takes the open pull requests, finishing the rows of those merged or closed
  since, or all of them (the 1,000 most recently updated); the database's sync dialog changes it,
  syncs now or stops it. Runs alongside Jira syncs in `database_sync` (no migration).
- **Only approved apps.** Owners can let in only the MCP apps they approved: *Only approved apps*
  in Settings → Security, with *Approve* and *Withdraw approval* on each app in *Apps that reach
  this workspace*. To an app not approved the workspace is hidden, as when connected apps are off;
  the server's own clients and REST API tokens aren't held to it. The consent screen names the
  workspaces an app won't reach until an owner approves it, and the audit log records approvals
  (`connected_app.approved`, `connected_app.unapproved`).
- **"Can edit content" access.** The Share panel, invitations by email, groups and access requests
  have a level between *Can comment* and *Can edit*: people with it write the page's body, title
  and icon, add, fill in, duplicate, merge and trash rows, and fill in forms, but don't change a
  database's properties, views, forms, automations or row templates, and don't lock, move or share
  the page; to them a database shows as locked, and the filters and sorts they set stay their own.
  Migration 0141 widens the level checks of `page_permission`, `page_invitation` and
  `page_group_permission` and redefines `page_access_level`, whose ranks move up by one above
  *Can comment*.
- **Embed any website.** The Embed block shows any https site as it is, not only the named
  providers: Hex apps, Deepnote blocks, Pitch presentations and the like, in the same sandboxed
  frame, without a referrer. Sites that refuse to be framed show an empty frame with their link,
  and the app's own pages are never framed; plain http links still become bookmarks. The pages'
  Content-Security-Policy now allows frames from any https origin (`frame-src 'self' https:`)
  instead of the providers' list.
- **A card for links shown as mentions.** Resting the pointer on a link mention shows its title,
  site and address, with *Copy link* and, on pages you can edit, *Refresh*, which fetches its
  details again, and *Turn into bookmark*. A link's toolbar has *Copy link* and *Turn into
  bookmark* too; the bookmark goes under the line, or replaces the line when the link was all of it.
- **Open rows in a centered window.** *Open rows in → Centered window* in a view's layout menu
  opens its rows in a window in the middle of the screen, over the view, with everything the side
  panel has (properties, body, comments, next and previous row). Esc or a click beside it closes
  it. MCP's `create_database_view` and `update_database_view` take `open_rows: "center"`; the MCP
  tool list's size budget goes from 276,000 to 276,500 bytes for it.
- **Membership admin role.** Owners can make someone a *membership admin* in Settings → Members.
  On content a membership admin is exactly a member (pages, databases, teamspaces, AI, agents,
  MCP and the REST API). With people they do what owners do: add and remove members and guests,
  change roles among member, membership admin and guest, approve or decline join requests and
  members' additions, manage invitations (into teamspaces too) and groups, and export the member
  list; join requests reach them in the inbox and by email. They never make, demote or remove an
  owner, don't see invitations to become an owner, can't add themselves to a group, and get no
  other owner tab or action (security, join link, ownership, audit log, analytics, connections,
  SCIM, single sign-on). When a membership admin removes someone, the pages and teamspaces only
  that person could manage pass to the oldest owner: choosing who takes them over is for owners.
  MCP's `list_users`, `list_workspaces` and `invite_member` and the REST API's workspace list name
  the new role; SCIM treats it as a member. Migration `drizzle/0140_membership_admin.sql` adds the
  role, a check on the role column and the role to `page_access_level`.
- **Published links that expire.** The Publish panel sets a date and time a page's web link stops
  working, and extends or removes it later. Once it passes, the link, its subpages, the files they
  show, copying it and the workspace site treat the page as unpublished, checked whenever they are
  read; the panel says *Expired on …* and Settings → Security lists links with their expiry. Setting
  or removing one is in the audit log. Migration `drizzle/0138_admin_extras.sql` adds
  `page_publication.expires_at`.
- **Invite someone into a teamspace by email.** Typing an address nobody in the workspace has into
  a teamspace's *Add members* field invites them to the workspace with that teamspace and the role
  picked; they join both on accepting. Who can add members, owner approval, allowed domains, sign-in
  policies and guests apply as for any invitation. The same migration adds `teamspaces` to
  `workspace_invitation` and `workspace_join_request`.
- **Choose who receives a removed member's pages.** Removing a member asks who takes over the pages
  only they could manage (and the teamspaces nobody else runs), says how many there are, and
  defaults to the owner removing them. The audit log records who received how many, also when
  someone leaves or the identity provider removes them.
- **Who could reach a page, in the audit log.** Page events record the page's audience at that
  moment (private, specific people, a teamspace, the whole workspace, or the web), shown in
  Settings → Audit log, as the CSV's last column and as `target.audience` in the audit stream.
- **The whole workspace as PDFs.** Settings → General → Export offers PDF next to Markdown and CSV: a
  ZIP of PDFs in folders following the page tree, databases as tables, rows with text of their own
  as their own PDFs, at most 1,000 PDFs, streamed as they are made.
- **Built-in icons and the full emoji set.** The icon picker has two tabs: *Emoji*, every emoji
  by category with search by name in the interface language (English as a fallback) and a skin
  tone it remembers, and *Icons*, a few hundred line icons in nine colors that read well in light,
  dark and high contrast, the last color picked remembered too. *Random* picks one. Built-in icons
  show wherever icons do (sidebar, header, breadcrumbs, mentions, search, tabs, home, published
  pages and sites, their favicons, print and PDF) and are stored as `icon:<name>:<color>`, which the
  REST API, the MCP tools and Markdown export return as is and writes accept. The editor's ":" menu
  also finds emoji by their names in the interface language. View tabs and properties can have
  their own icon from the same picker. Migration `0137_icon_preferences`.
- **Limit a relation to one page.** *Limit to one page* in a relation column's menu works like
  *Limit to one person*: picking another row replaces the linked one, and the server refuses writes
  (app, API, MCP, automations) linking more, with a message naming the property. Rows that already
  link several keep them until they're changed. Each side of a two-way relation has its own limit:
  linking to a row whose side links one moves it away from its old link. MCP's
  `update_database_property` takes `one_row` and `get_database` says `one_row`, as it says
  `one_person`.
- **Linked rows show their properties.** A relation's options pick up to four properties of the
  linked rows (status, person, date and the like, not formulas, rollups, relations or files) to
  show beside or before their title, in table cells, cards, row pages and the row picker. The
  values come with the rows, within the viewer's property access.
- **Relations as a section of the row page.** *As a section* lists a relation's linked rows under
  the row page's properties, ten at a time with *Show more*, with the properties they show editable
  in place and links added or removed there. *Inline* stays the default.
- **Date formats.** Date, created time and last edited time properties pick a full or short date,
  month/day/year, day/month/year, year/month/day or relative, and a 12- or 24-hour clock, written
  in the viewer's language in the app and on published pages. Exports, CSV, the API and MCP keep
  ISO dates.
- **`@today`, `@now` and `@me` in row template titles.** Each row made from the template gets the
  day, the moment (in the maker's time zone) or the maker's name in its title; the template's page
  says so under its title. Rows made through the API, MCP, automations or repeats get ISO dates.
- **Jira reporters.** Jira syncs fill a *Reporter* person property from the issue's reporter,
  matched by email like the assignee; the sync dialog picks which person property it goes to, or
  none.
- **Duplicate a view, and hide a linked view's title.** *Duplicate view* in a view's tab menu
  makes a copy of the view with its layout, filters, sorts and shown properties, named "… (copy)",
  right after it, and opens it. A linked view on a page can leave out the database's name above it
  (*Show title* in its layout menu), on published and printed pages and in PDFs too.
- **Undo a move or a trip to the trash.** Moving a page with *Move to* shows a note at the bottom of
  the window with a link to where it went and *Undo*, which puts it back in its old place among its
  siblings. Moving a page to the trash (from the sidebar or the page) and moving database rows to
  the trash show a note with *Undo* too, which brings them back. The note closes after a few
  seconds; a new one replaces it.
- **Copy a code block's code.** A *Copy* button sits in the corner of every code block, in the
  editor and on published pages and sites (shown on hover, always on touch screens), and copies
  the code as written.
- **Escape throws away an empty new row.** In a table, board, list, gallery, calendar or timeline,
  pressing Escape in a new row's name before anything is typed moves the row to the trash instead
  of leaving an untitled one behind. With a name typed, Escape keeps the row as before.
- **Fit a table column to its content.** Double-clicking a column's edge in a table view sets its
  width to fit its header and the rows shown, wider or narrower, and keeps it with the view.
- **See text that's cut short.** Anything in a workspace that ends in an ellipsis because it doesn't
  fit (a column's name, an option, a linked row, a page in the sidebar) shows in full as a tooltip
  when the pointer rests on it, and a cell's list of options, people, linked rows or files that
  doesn't all fit shows every one of them.
- **Limit a person property to one person.** *Limit to one person* in a person column's menu makes
  each row name one person at most: picking someone puts them in the place of whoever was there, and
  writes naming more (API, MCP, automations, imports) are refused. Rows naming more when it is turned
  on keep them until they're changed. MCP's `get_database` shows such a property with `one_person`.
- **Show a status as a checkbox.** *Show as checkbox* in a status column's menu shows a box,
  ticked while the row's status is in the done group. Ticking it picks the first done status,
  unticking it the first to-do one; filters, groups and the API still see the status itself.
- **Make a relation two-way later.** A one-way relation's column menu offers *Show on <database>
  too*, which adds the paired property there and links every row back from the rows it already
  links to (edit access to both databases).
- **More editor shortcuts.** Alt/Option+Shift+L copies a link to the block the cursor is in (as
  "Copy link to block" does, with a "Link copied" note), Cmd/Ctrl+Shift+X strikes text through as
  well as Cmd/Ctrl+Shift+S, and Cmd/Ctrl+Alt+T opens every toggle on the page (toggle lists and
  toggle headings, nested ones too, and the groups of grouped table and timeline views), or closes
  them all when none is closed. The keyboard shortcuts dialog lists them.
- **Toggle headings take their section.** Turning a heading into a toggle heading moves the blocks
  under it, up to the next heading of the same or a higher level, inside it, so the section folds
  away; turning it back into a heading lets them out again. One undo step either way.
- **Alignment for files, audio, bookmarks and embeds.** Like images and videos, they can sit at the
  start, in the middle or at the end (the block menu, and the formatting toolbar where it shows),
  and embeds and PDFs shown in place can be made narrower by dragging their edge. Published pages,
  print and PDFs keep it.
- **Wide columns.** On a page of standard width a column list can reach past the text into the
  page's margins, up to the page's full width: drag its outer edges, or pick "Wide columns" in the
  block menu of a block inside it. Full-width pages, phones and published pages show it at the
  text's width.
- **Download from the block menu.** Images, videos, audio and files get "Download", which saves
  uploaded files as files rather than opening them, and fetches files on other sites through the
  server (public https addresses only, up to 100 MB, signed-in readers of the page only). The image
  viewer now also steps through the page's images from other sites.
- **More code languages:** Agda, Coq, Dhall, EBNF, Idris, LLVM IR, Mathematica, PureScript and
  Racket, highlighted.
- **Dates written out in the @ menu.** "next friday", "in 3 days", "3 days ago", "yesterday" or a
  date like "15 Oct" become a date mention, in the interface language or English, as quick add
  reads them.
- **Links to comments.** A comment thread's menu has "Copy link". Pasted into a page of the same
  workspace, such a link offers "Paste as mention" (the author and the start of the comment, inline),
  "Paste as preview" (a block with the author, time, page and text, and a link that opens the
  thread) or the plain link. Readers who can't open the thread's page see "No access", never the
  comment; published pages show neither.
- **The theme follows in every tab.** Light, dark or system picked in one tab applies at once in
  the person's other open tabs of the app.
- **Fill cells by dragging.** A selected cell or range in a table has a small handle at its
  bottom-right corner: drag it up or down and the values are copied into the cells it passes over
  (a range of several rows repeats in its order), in one write that goes through the same checks as
  pasting. Cmd/Ctrl+D fills a range down from its top cell in each column; with a single row it
  duplicates the row, now also without the row menu open.
- **Edit values on board and gallery cards.** Clicking a value shown on a card opens the same
  editor a table cell uses (a select's options, a date picker, a person list…) without opening the
  row. Read-only viewers and properties they can't edit still show the plain value.
- **More date ranges in filters.** "Is within" on a date now also offers last and next week, last
  and next month, and this, last and next year, in views and in MCP, REST and AI chat filters.
  Weeks run Monday to Sunday, as "this week" already did; a new row in a view filtered on one gets
  the day in that range closest to today.
- **Find a property type by typing.** The name box of the header's "+" also searches the types by
  their names in the interface language; Enter (or the arrow keys, then Enter) creates the
  highlighted type, and a name that is just a type's name gives the property that type's default
  name.
- **A default row template per view.** "Set as default" in a database's row templates menu asks
  whether the template is the default for this view or for all views. "New" in that view then
  starts from the view's own choice (a template or a blank row), while other views and other doors
  (MCP, REST, forms) keep the database's default; "For all views" clears the views' own choices.
- **Hide vertical gridlines in tables.** Layout → "Show vertical lines" turns off the lines
  between a table's columns, for that view and where it is published.
- **Jump back in.** The workspace's home page starts with the pages you opened last, and the search
  box lists them before you type, newest first and only pages you can still open. While the
  workspace or you don't record page views (or for guests, whose views aren't recorded), the home
  page shows only *Recently edited* and the search box the pages last edited, as before.
- **Search filters.** Menus under the search box's query narrow a search by teamspace, by who
  created a page, by who edited it last, and by when it was last edited or created: today, the
  last 7 or 30 days, or days you pick, in your time zone. They work with the typed `in:`, `type:`
  and `is:verified`, and list pages without words too. The REST API's `GET /search` takes the
  same filters as `teamspace_id`, `created_by`, `edited_by` (`me` for yourself), `created_after`,
  `created_before`, `edited_after` and `edited_before`, and no longer needs a query when a filter
  is given. MCP's `search` tool doesn't take them: its schema is at the tool list's size budget.
- **Exact phrases in search.** Text in double quotes (`"launch plan"`) finds only pages with those
  words whole, side by side and in that order, in the search box, the REST API and MCP; Chinese
  and Japanese phrases too. A page found only by meaning isn't listed for such a search. A quote
  still being typed searches its words as before, and the AI chat's searches leave quotes alone.
- **Sprints and Docs templates.** *Sprints* makes a page holding a task database with two-week
  sprints turned on: a board by status, the current sprint, sprint planning and a backlog, with
  example tasks in the current and next sprint and the backlog. *Docs* makes a doc library with a
  category, an owner and the last edit, a board by category and a view by last edit, and four
  example docs, two of them verified by you for three months. Both in every language.
- **Save a web page.** *Save from web…* in the sidebar's *New* and *+* menus (and the new *Web page*
  tab of Import) takes the address of a web page and saves it as a page: its title, a link back to
  it, and its main text without the menus, ads, comments and footers around it. Its pictures (up to
  20, 5 MB each) are copied into the workspace rather than loaded from the site. A page with a
  schema.org recipe starts with it: what it makes and how long it takes, the ingredients as a
  checklist and the steps as a numbered list, then the rest of the page. It goes under a page,
  into a database as a row (with the address in its first URL property) or, by default, to a
  private page at the top; the form starts where you saved the last time. The dialog offers a
  *Save to Leafdesk* bookmarklet that opens the quick note with the page you are on (its address,
  title and the text you selected); there, and when a link is shared to the installed app,
  *Save full page* saves the whole page instead of the link. The REST API saves one with
  `POST /api/v1/pages/from-web`. The server fetches only public addresses over http or https on
  the usual web ports, checks every redirect again, and stops after 15 seconds and 5 MB of page.
  Migration `drizzle/0139_web_clip_target.sql` adds where each person last saved to
  (`workspace_member.web_clip_target`). No MCP tool: the tool list is at its size budget.
- **Archive notifications.** Each inbox item has *Archive*, and *Archive read* clears every read
  one at once. Archived items are marked read, leave the inbox and its count, and are listed under
  the inbox's *Archived* tab, where *Move to inbox* brings one back. Migration 0136.
- **Copy links to rows, and paste lists of links as mentions.** *Copy links* in a table's selection
  bar copies the selected rows' links, one per line. Pasting several links to pages of the
  workspace into a page makes a mention of each, one block per line (list items when pasted into a
  list).
- **Images in comments, and emoji shown large.** The image button under a comment box (or pasting or
  dropping images into it) attaches up to ten PNG, JPEG, GIF, WebP or AVIF images to the comment,
  which can then be posted without text. People who may only comment can attach them too. One
  image shows larger, several as thumbnails, and past four the rest fold into a *+N* tile. A
  comment of only one to three emoji shows them large. Exports list a comment's images after its
  text.
- **More ways to make columns, and Turn into.** `/col2` and `/col3` find the column layouts in the
  slash menu. Dragging a block by its handle to the left or right side of another block puts the
  two side by side (beside a column, it becomes a new column there), with a line showing where.
  *Turn into* in a block's menu changes the selected text blocks into another kind (text, headings,
  lists, toggle list, quote, code) or puts them in columns, one to a column (a single block gets
  an empty column beside it). Typing a space right after `/` closes the slash menu.
- **Export just this view.** A view's tab menu has *Export this view* as CSV, an HTML page or a
  PDF: the rows the view shows after its filters, sorts and search, in its order, with the
  properties it shows, in its column order. People who can only view the database can export too,
  while the workspace allows exporting; the audit log names the format.
- **Filter chips you can click.** The chips under a view's toolbar that show its filters open
  just that filter to change it when clicked, and their ✕ removes it.

### Changed

- **On macOS the desktop app's tabs sit beside the sidebar.** The sidebar runs the window's full
  height again, the window's buttons over its first row with the inbox, new page and hide buttons
  beside them, and the tab strip lies over the top of the page next to it, following the sidebar
  as it is resized, hidden or shown. Panels at the window's edge (a row's side peek, AI chat) and
  full-window views (the Markdown source, presentations, the file viewer) start below the strip.
  Pages without a sidebar, windows too narrow for one, and servers older than this keep the strip
  across the top, as Windows and Linux do. On every system the strip now takes the page's
  background, its tabs are rounded chips (the shown one highlighted) instead of joining the page
  below, and back and forward buttons for the shown tab come before them.
- **Client bundle budgets** go to 771 kB for a page's first load and 1174 kB for all first loads
  together, for typed dates, tags in the search box, named versions and page dictation.
- **Home, My tasks and Meetings are laid out like a database page.** They use the same width and
  margins, a title the size of a database's, and meeting names in the list are set at the size of
  table rows.
- **One player at a time.** Starting an audio or video block on a page pauses the one playing.
- **`/grey`** finds the gray text and background colors, like `/gray`.

- **A copied column is as wide as the original.** Duplicating a property gives the copy's column the
  original's width in every view that set one.
- **Inline code isn't spell-checked.** The browser no longer underlines words in inline code.
- **A smaller MCP tool list, with docs on demand.** Every client sends the tool list to its model at
  the start of each session; it goes from 99 tools and 277 KB to 86 tools and 158 KB, and the largest
  tool from 25 KB to 9 KB. What a model needs only now and then is now MCP resources,
  `leafdesk://docs/<topic>` (`markdown`, `properties`, `filters`, `views`, `dashboards`,
  `automations`), written from the same schemas the tools check, so they never drift; `get_page`
  reads them too, for clients that don't read resources. Filters, view settings, dashboard
  widgets, automation triggers and steps, and row values show as an outline with a pointer and are
  checked in full when a tool is called. Writes of the same kind and risk are one tool each now:
  `change_memory` (was `add_memory`, `update_memory`, `delete_memory`), `change_agent_memory`
  (`add_`, `update_`, `keep_`, `dismiss_` and `delete_agent_memory`), `set_agent_schedule`
  (`add_`, `update_`, `delete_agent_schedule`), `set_agent_archived` (`archive_agent`,
  `restore_agent`), `answer_pending_change` (`approve_` and `dismiss_pending_change`),
  `change_enrollment` (`stop_` and `resume_enrollment`), and the reads `get_page_history`
  (`list_page_history`, `get_page_version`, `diff_page_version`). Reads stay apart from writes, so
  clients still ask before every change. The budget in `tools-context.test.ts` goes down to 90
  tools, 165 KB and 12 KB per tool.
- **Copies are numbered.** Duplicating a page or rows names the copy "Plan (1)", then "Plan (2)",
  instead of "Plan (copy)"; a copy of a copy counts on from the original. MCP's `duplicate_page`
  does the same.
- **Page history says when in words.** Versions of the last week read "2 hours ago" or
  "yesterday", older ones their date written out, with the exact time on hover.
- **The page's own crumb goes back to the top.** Clicking the current page in the breadcrumbs of a
  page scrolled down scrolls it back to the top; at the top it still lists the pages beside it.
- **New properties hide when empty like the others.** While a property of a database hides on
  row pages when it is empty, properties added to that database start the same way.
- **Colleagues first in @ menus.** People whose email address has your domain come before others
  when you mention someone.

- **Bars and rings for formulas and rollups.** Formulas giving a number and rollups can show as a
  colored bar or ring with a divisor, like number properties (*Show as* in a rollup's menu). A
  rollup's older bar or ring setting is taken as the starting point.
- **Changing a view's filters and sorts makes a draft first.** For people who can change a view,
  new filters and sorts apply for them alone, marked *Not saved*, until *Save for everyone* saves
  them to the view; *Reset* throws them away. A linked view's filters save as before, and other
  view settings still save at once.
- **Filter groups nest three levels deep**, in the filter menu (one before), MCP, the REST API and
  the AI chat (two before).
- **The documentation moved from the README into `docs/`.** README.md keeps the overview, the
  quick start, security, license and trademarks, and lists the rest: features, running a server,
  install and offline use, export, email on rows, accounts and security, automations and webhooks,
  AI, agents, connections and MCP, the REST API and development, one file each. Section titles are
  unchanged, so a link to a README section other than the quick start now finds it under the same
  anchor in its `docs/` file.

## 0.6.3 — 2026-10-24

### Upgrading from 0.6.2

- **Download the new `docker-compose.yml`.** It passes the new settings on to the app:
  `AI_FAST_MODEL`, `AI_CHAT_MODELS`, `AI_IMAGE_INPUT`, `AI_MONTHLY_LIMIT_USD`, `WEB_SEARCH_*`,
  `TELEGRAM_*`, `GEOCODER_URL`, `MAP_TILE_URL` and `MAP_TILE_ATTRIBUTION`. An existing `.env` keeps
  working unchanged.
- **Migrations 0093 to 0135** run automatically when the container starts (from source, run
  `pnpm db:migrate`). 0093 rewrites the `page` and `file_text` tables once to rebuild their search
  vectors, which takes a while on a large instance; the others add tables and columns. 0107 marks
  every existing API token as legacy, so it keeps the access it had; 0104 and 0110 fill the shares
  of existing agents and the first version of existing automations.
- **Place properties and map views use OpenStreetMap's public servers** for address search and map
  images unless `GEOCODER_URL` and `MAP_TILE_URL` are set. Set them empty to keep the server and
  browsers from reaching them, or point them at your own servers for more than light use.
- **`AI_MAX_OUTPUT_TOKENS` defaults to 8192** (was 2048), and **`AI_MAX_INPUT_CHARS` is unset by
  default** (was 48000): a request may then send what the model's context window takes. A server
  that sets either keeps its value.
- Off until set: web search for agents and the AI chat (`WEB_SEARCH_PROVIDER`, `WEB_SEARCH_URL`),
  the AI chat from Telegram (`TELEGRAM_BOT_TOKEN`), a monthly AI cost limit
  (`AI_MONTHLY_LIMIT_USD`). Streaming the audit log and finding sensitive content stay off until an
  owner turns them on in Settings → Security.

### Added

- **Danish, Dutch, Norwegian, Finnish and Swedish.** The app, its emails, templates, the editor's
  menus and the desktop app now speak Dansk, Nederlands, Norsk bokmål, Suomi and Svenska, chosen in
  My account → Language or taken from the browser (one asking for Norwegian or Nynorsk gets
  Bokmål). Quick add knows their date words ("i morgen", "ensi viikolla", "over 2 weken"), CSV
  import their title columns and yes/no words, the AI chat's search their question words, and the
  AI translates into them.
- **Tabs in the desktop app.** Each desktop window holds tabs in a strip that follows Leafdesk's
  light or dark look, with the window's own buttons on macOS, Windows and Linux. Cmd/Ctrl+T opens
  a tab on the workspace's home, Cmd/Ctrl+W closes one (the last one closes the window),
  Cmd/Ctrl+Shift+T reopens the last closed tab, Ctrl+Tab and Ctrl+Shift+Tab move between them,
  Cmd/Ctrl+1–9 pick one and Cmd/Ctrl+Shift+N opens a new window; all are in the File and Window
  menus. Cmd/Ctrl+click or a middle click on a link to a page of the server opens it in a tab
  behind the current one. Tabs show their page's title and emoji, reorder by dragging and have a
  menu with *Close*, *Close Other Tabs*, *Duplicate Tab* and *Reopen Closed Tab*; every window
  comes back with its tabs at the next start, and all tabs share one sign-in. Reload, zoom, back
  and forward act on the current tab. A file the server shows (a PDF, an image, an export) still
  opens in a window of its own with the system's title bar.
- **Open Leafdesk links in the desktop app.** *My account → Preferences → Desktop app* (*Off*, *Offer to open
  them* or *Always open them*) lets a browser hand Leafdesk pages to the desktop app: the offer is a
  card to open the page there, with an *Always* box; *Always open them* tries the app
  once per browser tab and stays on the web page when it isn't installed. The app accepts
  `leafdesk://open?url=…` only for the server it is connected to (same scheme, host and port) and
  opens the page in a new tab. Not shown in Leafdesk on this computer. Migration
  `drizzle/0133_desktop_links.sql` adds the person's choice to `user_preference`.
- **Row templates can say "Me", "Today" and "Now".** In a row template, a person property's picker
  has *Me – whoever adds the row* and a date's has *Today* and *Now*; the template shows them as
  chips. A row added from the template gets the person who adds it and the day (in their time
  zone) or moment it is added, whether by hand, a button, an automation, a repeating template (as
  the person who set the repeat, in the repeat's time zone), the AI chat, the REST API or MCP (in
  UTC). An agent adding a row leaves "Me" empty. No migration.
- **Buttons and automations can add rows from a row template.** A button's *Add a row* step and an
  automation's *Create a row* step have a *Row template*: none, the database's default, or one of
  its templates (MCP: `template_id` on the step, `"default"` for the default one). The row gets the
  template's values and content, with the values the step sets on top. A step whose template was
  deleted stops and says the row template is gone. No migration.
- **Saved prompts in the AI writing assistant.** An instruction typed into *Ask AI* can be saved,
  with a name, from the bookmark next to *Send*; the menu lists your saved prompts under its
  actions to run, rename or delete. They are yours alone, up to 50 per workspace, and left out of
  workspace backups like AI chats; while there are none the menu points to skills for instructions
  the whole team shares. Migration `0135_ai_saved_prompts`.
- **Link previews for URL properties.** A URL property's menu has *Show as link preview* (off by
  default): row pages then show the linked page's icon, title and image under the link. The server
  fetches the address stored in the row, never one the browser sends, behind the same guard as
  bookmarks, keeps each preview a day (an hour after a failure) and counts only actual fetches
  towards a person's limit. No migration.

- **Task databases can be planned in sprints.** A view's settings have *Sprints*: asked only for
  the sprint length (one to four weeks) and the first sprint's day, it adds a Sprints database
  beside the task database (dates and a state of current, next, future or completed; the first
  sprint current, the second next), a two-way "Sprint" property on the tasks, a status if the
  database had none, and the views *Current sprint* (a board by status), *Sprint planning* and
  *Backlog*, all at once or not at all. *Complete sprint*, on the current sprint's board and on the
  sprints database, says what will change and then, in one step, marks the current sprint
  completed, makes the next one current, plans a new next one of the same length and moves the
  tasks whose status isn't done to the new current sprint (tasks the person can't edit stay and are
  counted). The current sprint's board follows the current sprint without its filter changing, and
  new cards on it go into the current sprint. The states can be renamed: filters on a rollup that
  lists a select's options (as these views' do) follow a rename of those options, in every
  database; the four state options can't be deleted while sprints are on. Turning sprints off keeps the sprints database and
  every task's sprint; turning them on again picks them up. REST API: `POST
  /databases/{database_id}/sprints/complete` (with `dry_run`). No migration.
- **My tasks.** A new sidebar section (it can be hidden or moved like the others) opens a page
  listing every database row assigned to you across the workspace, in any person property, that
  isn't done and that you can open: by due date (overdue, today, the next 7 days, later, no date)
  or by database, with each row's status and first date, the first 200 due soonest. Rows open in
  the row panel beside the list. A row with a status has a box that sets it to the first option of
  its *Done* group, written like any change of the row (automations and activity included), and
  unticking it puts the status back; the home page's *Assigned to you* list gets the same box and
  a *See all* link. Finding the rows assigned to you now works out access once per database rather
  than once per row: about 40 ms instead of 450 on a database of 50,000 rows.
- **Turn a page into a teamspace.** The page menu's *Turn into teamspace*, for people with full
  access to a page who may create teamspaces, makes a teamspace named after the page, with its
  icon, after a dialog that says what will happen. The page and the pages right under it become
  the teamspace's top-level pages, in one step. Whoever turns it and the people with full access to
  the page become its owners, those who could edit it its members (with edit access to its pages),
  groups that could edit it join as groups; viewers, commenters and guests keep the access they
  had, and every page that moves keeps the people and groups it inherited, so nobody named on the
  page gains or loses access. The teamspace is private when the page was private or in a private
  teamspace, closed when it was in a closed one, open otherwise. The audit log records it as
  *Turned the page … into the teamspace …*, with who joined and each page moved. The sidebar of whoever
  turns it unfolds the new teamspace at once, as it now does whenever the open page moves to
  another place.

- **Stream the audit log to your security tools.** Settings → Audit log gains *Stream to your
  security tools* for owners: an HTTPS address and a signing secret, shown once, sealed and
  replaceable. New audit events go out as signed JSON batches (up to 100, within about 30 seconds,
  oldest first, at least once) with the same headers and signature as automation webhooks, are
  tried again with growing waits up to an hour under the same delivery id, and are given up on
  (and counted) after 7 days. The settings show whether it streams or fails and since when, the
  last error and delivery, what was sent and what waits, and *Send test event*. Starting, changing,
  replacing the secret of and stopping a stream are in the audit log. The REST API gains
  `GET /workspaces/{id}/audit-log` with the new `audit:read` scope, which only owners can give, and
  only to a token limited to their workspace (no preset includes it): filters by time, actor,
  actor kind, action and category, either order, with a cursor. Migration
  `drizzle/0132_siem_dlp.sql` adds the stream and the outbox a trigger on `audit_event` fills. The audit
  log's *Single sign-on and SCIM* filter is now called *Security*, as it holds these too.
- **Sensitive content detection.** Owners can turn on *Look for sensitive content* in Settings →
  Security (off by default): pages and rows are read in the background after they change for
  payment card numbers (issuer and Luhn checked), IBANs (mod 97), Turkish national ID numbers and
  secrets (private keys, AWS keys, GitHub and Slack tokens, `sk-` keys, JSON Web Tokens and more).
  A finding keeps only a masked excerpt and a keyed hash, never the value; each is in the audit
  log, owners hear of a page and kind in their inbox at most once a day, and Settings → Security
  lists the open ones with their pages and *Dismiss*. A finding resolves itself once the value is
  gone from the page; turning detection off deletes the findings. The same migration adds the
  `sensitive_finding` and `sensitive_scan` tables.
- **People from your domains.** Settings → Security lists, for owners of a workspace with verified
  email domains, every account on the server with an address in them: whether it is in the
  workspace and as what, when it was last active and how it signs in, with *Add as member* and
  *Remove*.
- **GitHub pull requests update tasks.** A database with an ID property with a prefix has *GitHub
  pull requests* in its ••• menu: a payload URL and a secret to add as a repository webhook. A pull
  request that names rows by their ID (`TASK-12`, in its title, description or branch) adds its
  link to a text or URL property (a new *Pull requests* property if wanted) and can move a status
  property when it is opened or ready for review, merged, or closed without merging. Drafts only
  link, and a row already done moves only for a merge. Deliveries are checked against the secret
  and taken once, the writes are made as whoever saved the setup with their access when the
  delivery comes (rows they can't edit are skipped), the dialog lists the latest deliveries, and
  setting it up, changing and removing it are in the audit log. Migration
  `drizzle/0134_github_sync.sql` adds the `github_sync` and `github_delivery` tables. No new
  settings.
- **Send to Slack.** Automations have a *Send to Slack* step that posts a message, with variables
  and Slack formatting, to a Slack incoming webhook with a link to the row. The address is stored
  sealed and shown again only as a hint, in the app, MCP and the run history. *Slack
  notifications* in a database's ••• menu makes such an automation for a row added or a property
  changing (to a value). Addresses other than `https://hooks.slack.com/services/…` are refused,
  except on hosts in `AUTOMATION_WEBHOOK_ALLOWED_HOSTS`.
- **Page views and page analytics.** Opening a page, database or row in the app now records a
  view, once the page has been open two seconds and at most once per person and page every five
  minutes, kept as one count per page, person and UTC day and deleted after a year. Only owners
  and members are recorded: never guests, agents, API tokens, MCP clients or visitors of published
  pages. Settings → Analytics gains *Record page views* (on by default; off, nothing more is
  recorded and analytics show edits only), total views, unique viewers and pages viewed for the
  period, *Views per person* and *Most viewed pages* (pages the owner can't open counted but not
  named), each with a CSV download. Each person can turn off *Record my page views* for
  themselves under Settings → General. The page menu has *Analytics* for owners and members who
  may edit the page: views and unique viewers over 7, 30 or 90 days with a daily chart, who
  viewed it and when last, and who edited it. Migration `drizzle/0130_page_views.sql` adds the
  `page_view` table and the members' own switch.
- **Mention a group with @.** The @ menu in pages and comments offers the workspace's groups next
  to people, with how many are in each. Each member of a mentioned group who can open the page is
  notified like a person mentioned by name (once, even when named too; never the author; someone
  who joins the group later isn't told about mentions made before), and taking the mention out
  before it was read takes the notifications back. Hovering a group mention lists its members.
  Markdown, MCP, the API and exports write it as `@Group name` and read it back as the group (a
  person of the same name wins); comments keep it as that text.
- **Hover a page mention or link to see the page.** Resting the pointer on a mention of a page or a
  link to one, in the editor or in comments, shows a card with the page's icon, title and place,
  who last edited it and when, and its first lines, or for a database row its first values (as
  property access lets the reader see them). Nothing shows for a page the reader can't open, and
  no card opens on touch screens; Escape, a click or moving away closes it.
- **Format code blocks.** *Format code* in a code block's menu formats JavaScript, TypeScript, JSX,
  TSX, JSON, CSS, SCSS, HTML, Vue, Markdown, YAML and GraphQL with Prettier, which loads only when
  used, as one change everyone sees and one undo step. Code with a syntax error stays as it was
  and the message names the line. New dependency: `prettier`.
- **Narrower bookmark cards.** Dragging a bookmark card's edge sets its width as a share of the
  column; published pages and the print view keep it, and Markdown written back keeps it.
- **Databases can number their rows with a unique ID property.** The new *ID* type gives every row
  a number, 1, 2, 3… in the order rows are made, shown after an optional prefix of up to ten
  letters and digits (`TASK-12`). Adding it numbers the rows already there by when they were made;
  every row made afterwards gets the next number whatever made it (the app, imports, templates,
  forms, automations, the API, MCP, duplicating a row), including rows made at the same moment,
  and a number is never given out twice, not even after a row is deleted for good. The value
  can't be edited; changing the prefix only changes how IDs show, and a prefix belongs to one
  database of the workspace. A duplicated database keeps its rows' numbers (without the prefix,
  which the original keeps), and backups keep the numbers and the counter. IDs show in tables,
  boards, lists, calendars, timelines, row pages, published pages, print, PDF and exports, sort by
  number and filter with number operators that take `TASK-12` or `12`. Search, quick find and
  relation pickers find a row by its ID, and `prop("ID")` in a formula is the number. Turning
  another property into an ID numbers every row; an ID turns into text (`TASK-12`) or a number.
  MCP's `add_database_property` and `update_database_property` take a `prefix`, `get_database`
  shows it, and rows read their IDs as shown (`"TASK-12"`) in MCP, the REST API and the AI chat,
  which refuse to write them. Migration `drizzle/0131_unique_id.sql` adds the counter and the
  triggers that hand out the numbers.
- **Import from Evernote.** Import has an Evernote tab for exports (.enex, several at once, or ZIPs
  of them): each becomes a database named after its file with a row per note. Tags become a
  multi-select, the creation and update times dates (read as UTC), the author and source URL a
  text and a URL property, each only when some note has it. A note's content becomes its row's
  page: headings, text styles, highlights, links, nested lists, to-dos as checklist items, tables,
  code blocks, quotes and dividers. Its pictures are uploaded as images and its other attachments
  as files (one over the upload limit or the workspace's storage is left out and reported).
  Encrypted text is replaced by a line saying it was left out, a note whose content can't be read
  is skipped with a warning, and an export that declares entities in its DOCTYPE is refused.

- **A workspace site can have its own domain, theme, header links, search descriptions, favicon and
  Google Analytics.** In Settings → Site, owners set a domain like `docs.example.com`: requests for
  that host get the site at its root (`/` is the home page, pages at `/<title>-<id>`, links stay
  on the domain) and nothing else, so sign-in, the app, the API, MCP and the collaboration socket
  answer 404 there and no session is used on it; the README says how to point DNS and the reverse
  proxy at the server. Owners also pick the site's theme (light, dark or the visitor's system, over
  whatever visitors chose in the app), up to six header links to listed pages or web addresses, a
  default search description, and a Google Analytics 4 measurement ID, which loads Google's tag
  only on the site's pages at its own domain (never at `/s/<slug>` on the app's address, where
  members' session cookies live) with exactly Google's hosts added to their Content-Security-
  Policy. Each published page can have its own search description (Publish tab). Pages carry it as
  the meta description and in Open Graph and Twitter tags, site pages point search engines at the
  domain, their titles no longer end in "Leafdesk", and the favicon is the home page's emoji, drawn
  as SVG. Migration 0128 adds the columns.

- **Board and gallery cards can show long values whole.** Their Layout menu has *Wrap all
  properties*: text, tags, relations, people and links on the cards take more lines instead of
  being cut off, published views too. MCP's `create_database_view` and `update_database_view` take
  `wrap_properties`.
- **Sort a select's options by name.** The options editor of select, multi-select and status
  properties has *Sort A → Z* and *Sort Z → A*, which put the options in that order once, compared
  as the viewer's language reads them (accents and case aside, "Phase 2" before "Phase 10"); a
  status's options are sorted within each group. Options can also be dragged by their grip to a new
  place.
- **Values edit in place in list views.** Clicking a value on a line opens the same editor as a
  table cell; Tab and Shift+Tab move between the line's title and values (also out of a text
  editor, saving it), and Shift+Enter on a line adds a row right below it, with the view's filter
  values and, while sub-items nest, the same parent.
- **Date ranges from the date picker's month.** The date editor shows the month to pick a day
  from; Shift-clicking a second day makes the date a range from one to the other.
- **Give selected rows an icon.** The bar for selected rows has *Set icon* and, while any of them
  has one, *Remove icon*, for all of them at once; rows the viewer may not edit, and locked rows,
  are left as they are and counted as skipped.
- **People who can only view a database filter and sort it for themselves.** The view's Filter
  and Sort menus now show for them too, locked databases included: the rules apply only in their
  own window, replace the view's while set, are marked *Only for you* beside them, and are never
  saved, so nobody else's view changes; *Reset* goes back to the view's own filters and sorts.
- **Duplicate a database without its rows.** The database's page menu has *Duplicate without
  rows*: the copy gets the properties, views (forms start closed, as with any copy), row templates
  and the database's own page, but no rows and nothing inside them. Relations behave as in a full
  copy (a relation to the database itself points at the copy; one to another database becomes
  one-way), and automations are not copied, as before. MCP's `duplicate_page` takes `without_rows`,
  which empties every database it copies.
- **Calendars without weekends, and views without page icons.** A calendar's Layout menu has
  *Show weekends* (on by default): turned off, the month and the week show Monday to Friday across
  the whole width, bars are cut where a weekend interrupts them, and rows dated only on a Saturday
  or Sunday are listed under the calendar with their day (and time), where they open and can be
  dragged onto a weekday, instead of being drawn on a day they aren't on. Every view with rows has
  *Show page icons* (on by default) to leave the rows' icons out of the table, board, gallery,
  list, feed, timeline, calendar and map; published views leave them out too. MCP's
  `create_database_view` and `update_database_view` take `show_weekends` and `show_icons`, and
  `get_database` reports them.
- **Formulas take the median and the mean of numbers.** `median(numbers)` gives the middle
  number (the mean of the two middle ones for an even count) and `mean(numbers)` is another name
  for `average`; both take numbers or a list of them and leave empty values out. The editor's
  function list, the reference AI formula writing reads and the MCP description list them.
- **Exports can include the comments.** "Include comments" in the page menu adds the comment
  threads you can see after each page in Markdown and ZIP exports, and a switch in "Export as PDF"
  adds them to the PDF: each thread under the text it quotes (or the page, or a property's value),
  marked when resolved, its comments under their author and time. Comments on property values you
  may not see stay out. The format is in the README's Export section.

- **Ask for more access to a page you can open.** Someone who can view or comment on a page can
  ask to comment on it or edit it from its Share menu, with an optional message, and sees that
  the request waits until it is answered. The people with full access hear about it in their
  inbox, by email and by push notification, which say what was asked; they share at that level or
  another one above what the person has, or decline, from the inbox or the Share panel. A person
  has one request per page (asking for more replaces it), a request answered some other way goes
  away by itself, and the audit log records what was asked along with what was given. Requests
  from the "You don't have access" screen work as before; the workspace's *Access requests*
  setting covers both. Migration 0129 adds the requested level to `access_request`.
- **List the comment threads someone wrote in.** The comments panel has a person picker next to
  its sort: everyone who wrote a comment still there, you first, and choosing one lists only the
  threads they started or replied in, alongside the Open, Resolved, Marked and All filters.
- **The desktop app opens on the page you left.** At start, the window goes back to the last
  page it showed instead of the home page, when that page is on the server it is connected to
  (or on Leafdesk on this computer); the app keeps only the page's path, never another address.
- **Mark a push notification read from the notification.** Next to *Snooze 1 hour*, push
  notifications have a *Mark as read* button that marks the inbox item read without opening
  Leafdesk; an email still to come about it then doesn't go.
- **Import a PDF as a page.** Import has a PDF tab: each PDF becomes a page made of its text, with
  headings guessed from font size, paragraphs joined across lines and page breaks, and bulleted
  and numbered lines as lists; running headers, footers and page numbers are left out. The PDF
  itself is attached at the end of the page unless that's switched off. A scan without a text
  layer is refused with a note to run text recognition first, rather than making an empty page.
  The `/api/import` route takes `mode=pdf` (with `attach=1`).
- **Ask the AI chat about one teamspace.** *Answer from* now lists your teamspaces beside the whole
  workspace and the page you are on (with its subpages), in the panel and in the full-page chat.
  Searching, reading, querying, the map of what there is and changes all keep to the teamspace's
  pages on the server. Each question shows the page or teamspace it was asked of. `/api/ai/chat`
  takes `scope: {teamspaceId}`.
- **Pages show a floating outline of their headings.** A page with two headings or more gets a
  short line per heading at its edge, the one being read darker; hovering the lines (or tabbing to
  them) lists the headings, and a click scrolls there, opening collapsed toggles on the way. Hidden
  on narrow screens, beside the comments panel, on full-width pages and in print, and loaded only
  where it shows.
- **Links can show as mentions.** A pasted link offers *Mention* next to *Bookmark* and *Embed*
  (and within text, next to keeping the link), and a link already in the text has *Show as
  mention* in its toolbar: the site's icon, the page's title and the site's name inline, fetched
  once by the same guarded fetch as bookmarks and stored with the mention. Markdown, MCP and
  exports write it as `[Title](url)`, and Markdown written back into the page brings the mention
  back; published pages, the print view, PDFs and comments show it as a link.
- **Images can be cropped without changing the file.** *Crop…* in an image's block menu opens a
  frame over the image, moved and resized by dragging or with the arrow keys. The editor, read-only
  and published pages, the print view, HTML exports and PDFs show only the part; Markdown has the
  whole image, and a page's Markdown written back keeps the crop of each image whose file didn't
  change. The crop can be changed or removed at any time.
- **Buttons take a color.** The `/button` block's settings offer the option colors, as select
  options and board columns have them, in light, dark and high contrast; published pages and the
  print view show the color too.
- **Keep a database of Jira issues in sync.** Import has a Jira tab: connect a Jira Cloud site
  with an email address and API token, pick a project or write a JQL query, and get a database
  whose rows are the issues (key, summary, status, assignee, priority, type, labels, due date and a
  link back) on a board by status. It syncs every 15 minutes, hour, 6 hours or day, or only when
  asked, one way from Jira: synced properties and titles follow Jira, properties added in Leafdesk
  stay, and an assignee whose Jira email address is a member's becomes that person, who is told
  when assigned later. The database's ⟳ button shows when it last synced and why it paused, and
  lets people with full access sync now, change the query, sign-in or interval, or stop syncing.
  Migration 0127 adds the `database_sync` table.
- **Form questions can depend on earlier answers, take a number of choices, and show people their
  own answers.** In the form builder, *Show only when…* asks a question only when an earlier
  question's answer is (or isn't) one of some options, contains (or doesn't contain) a text, is
  ticked or not, or is empty or not; the question shows and hides as people answer, in the app and
  on the public link. A question not asked isn't required and its answer is dropped: the server
  works out which questions were asked from the answers it gets, whatever the page sent. A
  condition must be about an earlier question and name only its options; one whose question or
  options are deleted, or whose property changes type, stops applying and the question is asked
  always. Multi-select, people, linked-row and file questions take *At least* and *At most* a
  number of choices, checked in the form and on the server. With *Show people their own answers*
  (off by default) someone who signed in to answer sees, under the form and when they come back
  to it, what they sent through it: only the form's questions, never other properties or rows,
  even without access to the database; anonymous answers are never shown and the answers can't be
  edited there. `get_database` describes conditions, limits and the setting, and replacing a form's
  questions over MCP keeps them. Migration 0121 adds the `form_submission` table, which records the
  form and the person behind each signed-in answer.
- **Import from Asana and Monday.com.** Import has an Asana tab that takes a project's CSV or JSON
  export and a Monday.com tab that takes a board exported to Excel (or saved as CSV). Each becomes
  a database opening on a board grouped by section or group, with Asana's completion as a status,
  assignees and people as people (by email address, else by name, when one person in the
  workspace matches; text otherwise), start and due dates and Monday's timelines as dates, tags as
  a multi-select, locations with their coordinates as places, and the other columns typed by
  their names and values, shown and changeable in the dialog before importing. Subtasks and subitems become sub-items, Asana's *Blocked By* and
  *Blocking* and Monday's *Dependency* column the database's dependencies, notes the rows' bodies
  and comments and updates follow there under their author and time, with links between items
  leading to their rows. Nothing is downloaded; columns left out (such as *Created At*) are listed
  in the result.
- **Indonesian, Thai and Vietnamese.** The app, its emails, templates, the editor's menus and the
  desktop app now speak Bahasa Indonesia, ไทย and Tiếng Việt, chosen in My account → Language or
  taken from the browser. Quick add knows their date words, CSV import their title columns and
  yes/no words, the AI chat's search their question words, and the AI translates into them. Thai
  is searched by whole runs of text for now: a word inside a longer run isn't found.
- **Rows can give the people they name access.** *Row access* in a database's ⋯ menu (full
  access) adds rules: the people in a person property, or a row's creator, get view, comment, edit
  or full access to their rows and the pages inside them, on top of what sharing gives. A database
  can also show each row only to the people it names: others who can open the database see only
  the rows a rule or the row's own sharing gives them, while people with full access to the
  database still see every row (the dialog says who). Changing a row's people changes who can open
  it at once; search, the sidebar, the API, MCP and the AI chat follow the same rule. Copies of a
  database keep its rules; changes go into the audit log. Migration 0116.
- **Reactions to your comments reach your inbox.** When someone reacts to a comment you wrote, you
  get “Maya reacted 👍 to your comment” with the start of the comment, opening the thread. More
  reactions to the same comment, by anyone, gather in that one notification while it is unread
  (“Maya and 2 others reacted 👍 🎉”), taking a reaction back takes it out again (and the
  notification away once none is left), and deleting the comment or its thread takes them all
  back. Your own reactions tell nobody, and agents hear about none. *Reactions* is a kind of its
  own in Settings > Preferences: in the inbox by default, never by email, and pushed or sent to
  Telegram only once turned on. MCP's `list_notifications` lists them too. Migration 0117.
- **The inbox groups notifications about one page.** Comments and reactions on the same page that
  came within a few hours of each other, or edits to the same page or row, show as one entry
  (“5 new comments, 1 new reaction” with the people's pictures), which opens to the single ones.
  Opening the entry, marking it read or snoozing it does so to all of them.
- **Pages can be verified.** Someone with full access marks a page, database or row as checked
  from its `⋯` menu, for a week, a month, three months, a year, until a chosen day or with no end;
  a badge under the title says who verified it and until when, or that it expired, and editing the
  page keeps it verified. The verifier is reminded three days before the end and when it comes
  (*Pages you verified* in Settings > Preferences: inbox and email by default). Search ranks verified
  pages above otherwise equal ones, marks them and takes `is:verified`; the AI chat prefers
  verified sources and marks their citations; MCP's `get_page` and `search` and the REST API say
  `verified`, and `update_page` / `PATCH /pages/{id}` take it. Settings > Health lists expired
  verifications, and verifying goes into the audit log. Migration 0124.
- **Page webhooks.** Workspace owners send page events (`page.created`, `page.updated` once a page
  is left alone, `page.moved`, `page.trashed`, `page.restored`, `page.deleted`, `comment.created`)
  to an https address as signed POSTs, for the whole workspace, a teamspace or a page and those
  under it, under the new Settings > Webhooks tab or the REST API's new `webhooks:read` and
  `webhooks:write` scopes. Each sends as the owner who saved it last and is checked for every
  delivery: pages they can't open are skipped, it pauses when they are no longer an owner, and
  nothing is sent while export is off. Failed deliveries are retried like automation webhooks;
  a *Send test* ping and a 30-day delivery log come with each. Migration 0124.
- **The comments panel lists a page's discussions newest first, and keeps threads to come back
  to.** Threads, on text or about the whole page, are now in order of their latest comment (or,
  from the sort menu, in the order of the page), and those with comments by others since you last
  looked at them say *New*. Choosing a thread scrolls the page to its text and highlights it, as
  before. A thread's menu has *Come back later*, which only you see; the new *Marked* filter lists
  those threads until you take the mark off. MCP's `list_comments` and the REST API's comments
  say `marked: true` for threads the asking user marked. The marks and when each person saw each
  thread are kept per person (migration 0117) and go with the thread.
- **Comments on a row's property values.** Each property on a row page and in the row panel has a
  comment button that starts a thread on that value, with the number of open threads beside it.
  The comments panel lists these threads under their property's name; they resolve, mark, mute
  and notify like others, and MCP's `list_comments` names the property. Only people who see the
  value read, write and hear about them, and people a restricted row leaves out read none; a
  deleted property's threads go away until it is restored. They are kept apart from the row's
  document, in a table of their own (migration 0126).
- **Buttons on pages.** The `/button` block does a few things in order when someone clicks it:
  inserts blocks written in Markdown (below the button, or at the top or end of the page), adds a
  row to a database, changes the rows of a database that filters match, notifies people, sends
  the page to a signed webhook and opens a web address or a page. Texts take `{{today}}`, `{{now}}`
  and `{{me}}`, and a button can ask before it runs. It runs as whoever clicks, each step with
  their access, and stops at the first step they can't do, saying which and why. Its row changes
  are the clicker's own: they start the database's automations, and the row's activity marks them
  as made through a button (migration 0126). Published pages and the print view show buttons
  disabled; Markdown over MCP and the API keeps a button as a line with its id and label.
- **Images can link somewhere.** *Link…* in an image's block menu sets a web address or a page of
  the workspace. In the editor a small button on the image follows it; read-only pages, published
  pages and the print view make the image itself the link. Markdown writes and reads a linked
  image as `[![alt](image)](link)`.
- **Suggested edits.** The page header switches between *Editing* and *Suggesting*: while
  suggesting, typed text shows underlined as an insertion, deleted text stays, struck through, and
  new formatting is marked as a change, live for everyone on the page. Each suggestion is a thread
  in the comments panel, opened in its author's name, with *Accept* and *Reject* for people who may
  edit and *Withdraw* for its author; the page menu accepts or rejects them all. People who may
  only comment always suggest, and the server takes nothing else from their connection. Until a
  suggestion is accepted the page reads without it: its Markdown, search, published pages, PDF
  and print, exports, history, MCP, the REST API and the AI. A page's watchers (a row's
  followers) hear about new suggestions as about new threads, by inbox, push and email, and the
  author hears when theirs is accepted or rejected. MCP's `list_comments` and the REST API say
  `suggestion` for a suggestion's thread. The writing assistant can apply its text as suggestions.
- **Views color rows by rules.** *Color rules* in a view's layout menu (tables, boards, galleries,
  lists, calendars and timelines) colors the rows that match conditions: each rule has a color
  from the option palette, colors the whole row or card or one property's value, and tests rows
  with the same filters, groups and and/or as the view's filters, formulas, rollups, relations,
  people ("me") and relative dates included. For each target the first matching rule wins, so
  rules can be moved up and down. Timeline bars take a row's color. Someone who can't see a
  property doesn't get the rules that name it, and saving the view keeps those rules; deleting a
  property sets aside the rules that name it until it is restored, and copies of a database keep
  their rules pointed at the copied properties. MCP: `update_database_view` takes `color_rules`
  and `get_database` lists them. Exports, prints and published pages show rows without colors.
  No migration: rules live in the view's settings.
- **Workspaces can allow sign-in only from approved networks.** Owners list IPv4 and IPv6
  addresses and CIDR ranges, with optional labels (at most 100), under Settings → Security next to
  the other sign-in policies. While the list has entries, browser sessions from other addresses,
  owners' and guests' included, are held back from the workspace like the two-step and single
  sign-on policies hold them back: pages send them to a page that shows the address the server
  sees, actions and routes refuse them, and the live collaboration connection is checked by the
  address it comes from (open ones close when a list is saved). An unknown address counts as
  outside the list. Their other workspaces keep working. A list that leaves out the saving owner's
  own address is refused, and instance administrators can clear a workspace's list on `/admin`;
  both changes go into the audit log. Apps connected over MCP, REST API tokens and SCIM tokens
  aren't held to it. The address comes from the client address rules of `TRUSTED_PROXIES`, which
  the collaboration websocket now follows too. A restored backup starts without a list. Migration
  0118.

- **Place properties and map views.** A *place* property holds an address with its coordinates:
  its cell suggests places as you type an address or name (looked up by the server) and takes
  pasted coordinates, and links to the spot on a map. It can be filtered on its address, sorted,
  exported, read by formulas and written through MCP, the REST API, the AI chat and imports as an
  address, coordinates or `{lat, lng, address}`. A *map* view shows a database's rows as pins at a
  place property, colored by a select or status if wished; a pin's card shows the row's shown
  properties and opens the row, and rows without a place are listed under the map. Linked views,
  dashboards, MCP and the AI chat can make map views. New env vars: `GEOCODER_URL` (address
  search, OpenStreetMap's by default, empty turns it off), `MAP_TILE_URL` and
  `MAP_TILE_ATTRIBUTION` (the map's tiles and their credit, OpenStreetMap's by default, an empty
  URL turns maps off). No migration. New dependency: Leaflet.
- **Feed views.** A *feed* view shows a database's rows as posts in one column, newest first
  unless the view sorts otherwise: each with who wrote it and when, the view's shown properties and
  the start of its body, which "Show more" opens in place. Under each post people who may comment
  react with emoji and read and add the row's comments. Reactions to rows follow page access and
  are new; color rules color posts. Linked views, dashboards, MCP, the REST API and the AI chat
  can make feed views; published pages show each post's date, title, values and the start of its
  body, without reactions or comments. Migration 0125 (the reactions, and the row page setting
  below).
- **Database tabs.** The `/tabs` block shows several databases, or views of one, as tabs, each a
  view of its own that editors set up with its toolbar, rename, reorder and remove. Readers get only
  the tabs whose database they can open. It is a dashboard laid out as tabs, so Markdown, `get_page`
  and the dashboard tools read and change it (`add_dashboard` takes `layout: "tabs"`); published
  pages switch tabs in place and print every tab.
- **Row page layout.** People with full access to a database pin up to four properties into a
  strip under its rows' titles, from a property's menu on a row, and choose whether the other
  properties show above the body or in a column beside it where the page is wide enough (above it
  on phones and in narrow side panels). The choice is the database's, for everyone. Published rows
  show pinned properties first.
- **The AI chat reads comments and page history, takes CSV files, and makes databases and
  forms.** It lists a page's comment threads, open and resolved, with their authors, the text
  they are on and their replies, and can comment or reply as the person (`list_comments`,
  `add_comment`). It lists a page's saved versions and reads one or shows what changed since it
  or by it (`page_history`, `page_version`, the same operations as MCP's history tools). A CSV
  file attached to a question (see *Attach images and documents to the AI chat*) is read as a
  table (up to 1,000 rows and 100 columns, with a clear message beyond): its chip shows its rows
  and columns, the model gets the table cut to fit and reads the rest with `read_attachment`, and
  the file stays with the conversation for the questions after it. The chat makes a new
  database with the properties, types and options asked for, or one from an attached file with
  each column's type guessed from its values and its rows imported, under a page the person may
  edit or at the top, private to them (`create_database`, `create_database_from_csv`). It adds
  a form view to a database the person may edit, with the questions, title, description and
  confirmation asked for, opened to the web when asked and allowed, and answers with its links
  (`create_form`). Each change is asked for first in *Ask* mode, shown with what it would make,
  and made as the person through the same code as the app's own edits (a new or imported
  database goes into the audit log as one made in the app does); the Telegram bot asks the same
  way.
- **Attach images and documents to the AI chat.** The paperclip under the question box, dropping
  files on it or pasting them attaches up to 5 files to a question: images (sent as images to
  models that take them; the box says so for one that doesn't), PDF, Word and Excel documents
  (read to text as search reads them), CSV, Markdown and text files, up to 20 MB each (images
  5 MB). Each is uploaded as it is attached and shows as a chip, in the box and on the question,
  where it opens the file; a question may be only files. Files stay with the conversation, so
  later questions see them again (cut to fit) and the chat reads on in one with `read_attachment`.
  They are stored apart from the workspace's pages: only the person who attached them can open
  them, backups and exports leave them out, and they are deleted with their conversation (an
  upload never sent after a day). Migration 0123 (`ai_chat_file`, `ai_conversation.model`).
- **Pick the AI chat's model.** `AI_CHAT_MODELS` lists more models at the server's provider that
  the chat's box offers next to `AI_MODEL` and `AI_FAST_MODEL`; with more than one, a picker sits
  under the box. A conversation keeps its model, a new one starts with the person's latest, and
  usage and cost are counted per model as before. `AI_IMAGE_INPUT=true` says that models the
  catalog doesn't know (OpenAI-compatible and local ones) take images. New env vars:
  `AI_CHAT_MODELS`, `AI_IMAGE_INPUT`.
- **Research mode in the AI chat.** The telescope button under the box asks for a report instead
  of an answer: the model plans sub-questions (shown as a step), searches and reads the workspace
  as the person, attached files and, where web search is on, the web, then writes a long report
  with a section per sub-question, citing every source. It only reads (no changes, notes or
  connections, whatever the mode) and has up to 14 turns and 400,000 tokens, counted against the
  workspace's limits like other requests (as *AI chat* in the usage view). *Save as page* makes a
  report a private page with its citations as links and a list of sources.
- **Web search in the AI chat, and Brave or Tavily as the search service.** Where the server has
  a search service, owners can turn on Settings → General → AI → *Web search in the AI chat* (off
  by default): the chat then searches the web and reads web pages (`search_web`,
  `read_web_page`), read-only, fetched with the same address checks and size and time limits as
  agents' reads, their text framed as outside data, and once an answer read from the web every
  change it wants is asked about, also in *Auto*. Web sources are cited as links. Besides a
  self-hosted SearXNG (`WEB_SEARCH_URL`), `WEB_SEARCH_PROVIDER=brave` or `tavily` with
  `WEB_SEARCH_API_KEY` uses those services, for agents with web access too. New env vars:
  `WEB_SEARCH_PROVIDER`, `WEB_SEARCH_API_KEY`.
- **Build databases with AI.** *Build with AI* in the sidebar's *+* menus, on the home page, in
  Cmd+K and as `/` *Build databases with AI* in a page: describe what you want to keep track of and
  the AI drafts up to four databases for it, with typed properties, select options with colors,
  statuses with their groups, relations between them, a few views (boards, calendars, timelines,
  galleries and lists, with grouping, filters and sorts), example rows linked to each other, and a
  page about them. The plan is checked against the real property and view types (one that doesn't
  pass goes back to the AI once with what is wrong), shown to rename or remove databases,
  properties and views and to leave out the example rows or the page, and then created as you,
  where you opened it, all of it or nothing. The AI chat's `create_database` (still one
  database with its properties) now goes through the same check and creation, so a status it
  makes needs a done option. It counts
  as *Other* in Settings > AI usage and is held to the workspace's AI limits. No migration.
- **Write a formula by describing it.** Where the workspace has AI, the formula editor has a
  *Describe it* box: say what the formula should work out ("days left until the due date") and the
  AI writes it from the database's properties you may know of (names and types, never row values)
  and the formula functions. The formula is checked like one you type; one that doesn't work goes
  back to the AI once with the error, and if it fails again the error shows instead. A working one
  shows with what it gives on the first rows; *Use formula* puts it in the editor, where you save
  it as usual. It counts as *Formulas* in Settings > AI usage and is held to the workspace's AI
  limits.
- **AI usage by person.** Settings > AI usage now breaks the month shown down by person: each
  person and agent (marked as one) with their requests, tokens, cost and share of the month,
  costliest first, and the features they used most; requests nobody asked for show as background
  work. Only owners see it, as the rest of the page. Requests are counted by person from this
  update on (migration 0119, table `ai_usage_person`); what came before stays in the totals and
  shows as one line of its own.
- **Automations can celebrate.** A new *Celebrate with confetti* step plays confetti in the app
  for whoever made the change that started the run, in every window they have open, a moment
  after the change; a ready-made *Celebrate finished rows* automation does it when a row is
  marked done. With reduced motion asked for, a still "🎉" note shows instead. Runs nobody
  started (schedules, dates passing, incoming webhooks, anonymous form answers) skip the step, as
  do runs that reach it more than two minutes after the change. MCP `create_automation` and
  `update_automation` take it as `celebrate`.
- **Find in page ignores accents.** Searching a page now finds "café" for "cafe", "naïve" for
  "naive" and "Çiğdem", "Şükrü" or "ışık" for "cigdem", "sukru" or "isik", whichever way round
  they are typed; accents written as separate marks after their letter count too, and Replace
  takes them along. A new *Match accents* button next to *Match case* makes accented letters match
  only themselves again, with the Turkish pairing of "I" with "ı" kept as it was.
- **Meeting notes.** `/` *Meeting notes* (or *Add meeting notes below* in a block's menu) adds a
  block with a title, date and time, attendees and *Start recording*. The recording goes on across
  tabs and pages, can be paused, and is sent every 30 seconds to be transcribed, so the
  *Transcript* fills in with `[mm:ss]` times while people talk; a piece that keeps failing is left
  as a gap, and the audio is never stored. On *Stop and summarize* AI writes a summary, decisions
  and action items (assigned to attendees it names), each linked to its moment in the transcript;
  they can be edited and regenerated. *Meetings* in the sidebar lists the meeting notes you can see,
  upcoming and past, with search, and makes new ones on private pages. The AI chat, MCP and REST
  API read the block as Markdown, and search finds words in the transcript. Needs speech to text
  (`STT_*`, as for voice notes); up to three hours a meeting. Migration 0120 (`meeting_note`).

- **Pages can be downloaded for offline use.** "Available offline" in a page's ⋯ menu, or in the
  menu beside a page in the sidebar, downloads the page to this device now: its content, the page
  itself, a database's rows or a row's values, and the files and images it shows (up to 10 MB each
  and 50 MB per page). "Include sub-pages" (for a database, "Include rows") brings up to 50 pages
  under it along. Downloaded pages are fetched again in the background while the app is open and
  online (shortly after it starts and every 15 minutes), and they are never pushed out by newer
  recently opened pages. Favorites are downloaded too unless "Keep my favorites available offline"
  is turned off. A quiet mark in the sidebar shows which pages are downloaded, and the offline page
  lists them beside the recently opened ones. The new Settings → Offline tab lists what this device
  keeps, with each page's size, when it was last updated and whether it holds edits not yet sent.
  There you can remove one page or all offline copies (with a warning when edits would be lost),
  and see how much storage the browser uses and whether it keeps the copies persistently. Leafdesk
  asks for persistent storage the first time a page is downloaded. Downloads are per device and,
  like all offline copies, are removed on sign-out. No migration.
- **The AI chat makes PDF files.** Asked for a PDF (a quote, a letter, a report), the chat writes
  it into a page or row if it isn't in one, then makes the page's PDF on the server
  (`create_pdf`) and attaches it at the end of the page's text, or in a row's files property, and
  links to it in its answer. Like other changes it is asked for first in *Ask* mode and needs edit
  access; like other exports it is off while the workspace has export off and goes into the audit
  log. Tables keep their layout, with amounts on the right; a row's values are left out unless
  asked for. An agent can do the same in its owner's chat. New dependency: pdfmake.

- **PDF letterheads.** Owners set up the workspace's letterheads in the new Settings → PDF
  templates tab: a logo on the left, in the middle or on the right, lines at the top of every page
  (company, address, tax number) and at the foot (bank details), an accent color and page numbers.
  One is the default. PDF files from the page menu and the AI chat print in it, or in another one
  picked by name, or in none. Guests make PDFs without letterheads. Migration 0115 adds the
  `pdf_letterhead` table.

- **Owners can put people under a legal hold.** Settings → Security → Legal holds lists the holds
  of the workspace, each with its name, reason, who set it and when, and the people it covers:
  members, guests, or people who have left but created or edited something there. While a hold
  stands, nothing they created or edited (a page they made, last edited, saved a version of,
  changed a value of, uploaded a file to or commented on, and any page above one) is deleted for
  good: it can still go to the trash and come back, but *Delete forever*, the trash and history
  retention, the file cleanups, deleting a template, a deleted property's values or a comment keep
  it or refuse with a message, the workspace can't be deleted, and the people's accounts can't be
  deleted. Removing a held person from the workspace, also over SCIM, keeps their pages, as it
  always did. Setting and releasing a hold is recorded in the audit log, and backups carry the
  holds. Migration 0122 adds them.
- **Settings can be searched.** A box at the top of Settings' navigation finds a setting on any tab
  you have, your account's included, by its name, its tab or other words people look for it by
  ("dark mode", "2fa", "ip", "backup"): picking one opens its tab, scrolls to the setting and
  highlights it for a moment. Only what you can see is found: owners' settings for owners, and
  nothing a guest's or a one-computer Leafdesk's Settings leave out. The search box (Cmd/Ctrl+K)
  finds them too after `>`, as *Settings: Security → Approved networks*.
- **Swipe inbox items on a phone.** On a touch screen, swiping an item of the inbox toward the end
  of the line marks it read, or unread again, and swiping it toward the start snoozes it until
  tomorrow at 9:00; what letting go will do shows behind the item as it moves. A group of
  notifications about one page goes the same way, all of it. The buttons stay, and a mouse or pen
  works as before.
- **The desktop app has a system-wide shortcut to AI chat.** Pressing Cmd+Shift+J on macOS
  (Ctrl+Shift+J on Windows and Linux) in any app brings Leafdesk forward and opens AI chat in the
  workspace its window shows, or a quick note where AI is off in that workspace. *Go → Ask AI
  Shortcut* switches it to Cmd/Ctrl+Shift+Space or Cmd/Ctrl+Option/Alt+L, or turns it off; when
  another app already has the keys, the menu says so and another can be picked. The choice is kept
  in the app's settings.
- **Table rows move by their handle, which also opens a fuller row menu.** The ⋯ button before
  each row of a table is now a handle: drag it to move the row among the others (in its group, and
  under the same parent when sub-items nest) while no sort orders the view; the order is the one
  boards keep. Clicked, it opens the row's menu, which now has a search box and adds to favorites,
  edits the row's icon (now shown before its name in the table), opens a property's value for
  editing, opens the row in the side panel, as a full page or in a new tab, opens its comments,
  copies its link, duplicates it, moves it elsewhere, merges it with another row, follows it,
  moves it to the trash and copies its or the database's id, with who last edited it and when
  and how many words and characters its body has. While the menu is open ⌘D (Ctrl+D) duplicates
  the row, ⌘⇧P moves it, ⌘⇧M opens its comments and Del moves it to the trash; the menu shows
  the keys, and so does the shortcuts list. The page ⋯ menu counts a page's words and characters
  too.
- **Skills live in a skills database.** *New skill* in the skills library, and the ready-made
  skills, now add a row to a skills database: the person's own, made private at the top of the
  workspace the first time, with *Description*, *Files*, *Tags* and *Created by* properties and its
  rows opening beside the table. Every row of a skills database is a skill, however it was added
  (the table, MCP, the REST API, an import or a move), and its description is the *Description*
  property: written there, on the row's skill bar or with MCP's `set_skill`. Any database can be
  turned into one, or back, from its ⋯ menu (*Skills database*, full access), which adds a
  *Description* property when it has none. The library links to the person's skills database.
  Pages marked as skills stay as they are; moved into a skills database, or in a database turned
  into one, they keep their description, which goes to the property. Migrations 0113 and 0114 add
  the setting and a trigger that marks the rows.
- **Several AI conversations can be deleted at once.** In the chat tab of the sidebar a box takes a
  conversation's dot on hover: tick some, shift-click for a range, or pick *Select all* from the
  heading's ⋯ menu (where a touch screen starts). The heading then counts them and deletes them together after asking how many
  will go; Escape or × clears the selection.
- **Automations can ask for approval.** A new *Ask for approval* step makes a run wait until one of
  the people it asks approves or rejects it: chosen people and the people the row's person
  properties name, with a message that can use templates, for 1 to 30 days. The question shows
  under *For review* and on the row like other proposals, with the message, the automation, a link
  to the run and what the next steps will do, and its people are notified (inbox, push and
  Telegram). Approving goes on with the next step, which can use `{{<step>.approved_by}}` and
  `{{<step>.answered_at}}`; rejecting stops the run, which the history now shows as *Stopped*.
  Without an answer in time the run stops, or goes on when set to. Only the people asked can
  answer, once, and nobody can edit the question; answers are in the audit log. Test runs ask
  nobody and say whom they would have asked. MCP's `create_automation` and `update_automation`
  take the step, and the review tools and the REST API's pending changes answer it. The
  automations dialog also offers templates to start from, one of them asking for approval before
  a row is closed. Migration 0111 adds the question's kind and its links to the automation and run.
- **Follow-ups on rows.** Owners add follow-up sequences to a mail database in Settings → General →
  Email: a name and steps, each with how many days after the one before it goes out, the text, and
  whether it is sent on its own or put in the sender's For review queue first ("ask me first").
  The first step has a subject; later ones answer in the same thread. Templates use the row's
  values as `{{Company | there}}`: every variable needs a fallback, used when the row's value is
  empty, and a sequence without one isn't saved. Start one from a row's Email section, on the rows
  selected in a table, with an automation's new *Start a follow-up* step (sending as the person the
  automation runs as; a row already in it is skipped), over MCP (`list_sequences`,
  `enroll_in_sequence`, `list_enrollments`, `stop_enrollment`, `resume_enrollment`) or the REST
  API (`/databases/{id}/sequences`, `/sequences/{id}/enrollments`, `/enrollments`, with
  `rows:read` and `rows:write`). A row is in a sequence once at a time. Emails go out from the
  sender's own mailbox, on weekdays from 09:00 to 17:00 in their time zone unless the sequence
  says otherwise, at most 50 a day per mailbox (set under My account → Email and calendar), a few
  minutes apart. Each is checked like an agent's email draft: one that doesn't pass isn't sent,
  and the follow-up pauses and tells its sender. A follow-up stops when the contact answers, the
  row goes to the trash, the mailbox is disconnected, a draft is dismissed or someone stops it; an
  out-of-office reply pauses it until the day it says they are back (a week when it says none).
  The row shows each follow-up with its step, why it paused or stopped, and *Stop* / *Resume*;
  a draft under For review says which step of which sequence it is. Starts, stops and sends are in
  the audit log, and ended follow-ups are deleted after 90 days. The automations dialog has a
  *Start from an example* button with one that starts a follow-up when a row reaches a quote stage.
  Migration 0112 adds `email_sequence`, `sequence_enrollment` and `sequence_send`, a daily limit,
  time zone and next send time to `mailbox`, and the enrollment a notification is about.
- **Property descriptions.** Every property can say what it holds and how to fill it, in plain
  text of up to 1,000 characters, set in its menu under the type. It shows as a hint when you rest
  on the column header or the property's name on a row page, and it guides whatever writes values
  with AI: AI autofill gets the description of the field it fills, the AI chat and agents get each
  property's description with the database's schema (also when they read a row), and MCP's
  `get_database` and the REST API's database schema return it as `description`. MCP's
  `add_database_property` and `update_database_property` set it. A form question without help text
  of its own shows the property's description. Duplicates, templates, backups and type changes keep
  it. The importer for Markdown & CSV exports has none to bring: those exports don't carry them.
- **Selects that depend on another select.** A select or multi-select can depend on a select of the
  same database ("City" on "Country"): in its menu, pick the property under *Depends on*, then for
  each option the options of that property it goes with (none picked: it goes with any). A row's
  editor offers only the options that fit its value of the property it depends on, and says how
  many it left out. A write that sets an option that doesn't fit is refused, from the app, a bulk
  edit, the REST API, MCP, an agent or AI autofill (which is offered only the options that fit);
  changing (or clearing) the value it depends on clears what no longer fits, down a chain of them
  and also when a row is moved on a board; a CSV import or a paste leaves misfits empty. Removing an option of the parent takes it off the lists; turning the parent
  into another type, or the dependent into a type that can't depend, undoes the dependency. MCP's
  `get_database` and the REST schema show `depends_on` and `option_parents`, which
  `add_database_property` and `update_database_property` set. Public forms filter the options the
  same way when the question it depends on is asked too. Stored in the property's settings: no
  migration.
- **Company researcher agent.** A new template in Settings → Agents → *Start from a template* looks
  each company added to a database up on the web and fills the properties you choose that are
  still empty (website, sector, address, phone and the like), following their descriptions, and
  comments on the row with its sources. It never overwrites a value, and it gets web access.
- **AI fills in selects, multi-selects, statuses, numbers and checkboxes.** *AI autofill…* is in
  the menu of these properties as well as text ones: from your prompt over the row's values, AI
  picks one of a select's or status's options (or none), the options of a multi-select that apply
  (never new ones), a number (a percent number as the fraction it shows) or yes/no for a checkbox.
  Answers are read leniently (a full stop, quotes or another case don't matter); one that doesn't
  fit fails and leaves the value as it was. The values are ordinary ones, so filters, boards and
  automations such as "Status changes to Done" work with them. MCP describes such properties with
  their `ai_autofill` settings like text ones.
- **AI values only for rows that have what they need.** *Only rows where these have a value* in
  an AI property's settings picks up to 10 properties that must be filled in (a checkbox: ticked);
  other rows are skipped without asking a model and keep their value. MCP lists them as
  `only_rows_with`.
- **API tokens with access per resource, and safe retries.** A personal access token now gets
  read and write scopes per resource: `workspaces:read`, `pages:read` / `pages:write`,
  `search:read`, `databases:read`, `rows:read` / `rows:write`, `comments:read` /
  `comments:write` and `agents:read` / `agents:write`. Creating a token in My account →
  *Connected apps* shows a read and a write toggle for each, with the presets *Read everything*
  and *Read and write everything*, and *Change access* changes what an existing token may do
  without a new secret (recorded in the audit log). Every endpoint names the scope it needs in the
  reference and the OpenAPI document; without it the answer is still `403 insufficient_scope`,
  which now names the scope in `details.scope`. Tokens made before keep exactly the access they
  had: their `pages:read` reads everything and their `pages:write` reads and writes everything,
  and they say so in settings and in `GET /me` (`legacy_scopes`), which any token may now call.
  Writes take an `Idempotency-Key` header: the same request sent again with the same key
  within 24 hours gets the first answer back (`Idempotent-Replayed: true`) instead of being done
  twice, another request with the key answers `422 idempotency_key_reused`, one sent while the
  first still runs `409 idempotency_conflict`, and server failures aren't kept so their retry runs
  again; the daily retention run deletes older keys. Every answer to a valid token now also
  carries `X-RateLimit-Reset`, and errors about a field name it in `param` (`title`,
  `properties.Status`, `rows.2.properties.Status`). Migration 0107 adds `api_idempotency_key` and
  `api_token.legacy_scopes`, marking every existing token as legacy.
- **Merge duplicate rows.** Select 2 to 5 rows of a table and choose **Merge**, or pick **Merge
  with…** in a row's menu and search for its duplicates. The dialog sets the rows side by side:
  choose the row to keep (the oldest to start with) and, for the title and each property, the row
  whose value it keeps, or **Combine all** for multi-select, relation, person, files and checklist
  values. Values start as the kept row's, or the first row's that has one; relations combine.
  Other rows' links to the merged rows, both ways and from other databases, point at the kept row
  once each, so rollups and formulas over them count again, and sub-items and dependencies move
  too. The merged rows' comments (on the same text where their content came along), activity
  (marked as coming from them), uploads, email, followers, reminders and page content (each under
  a "Merged from" heading in the language of the person merging, the kept row's body saved to its
  history first) come to the kept row,
  whose activity says who merged which rows. The merged rows go to the trash, which says what they
  were merged into; links and mentions of them open the kept row, and restoring one brings it back
  as a row of its own without undoing what moved. Merging needs edit access to every row and to
  the rows whose links change (the error names them), never takes values from outside the rows,
  and leaves properties the person may not edit as the kept row has them. It runs in one
  transaction with the rows locked and is in the audit log. `merge_rows` over MCP and
  `POST /api/v1/databases/{id}/rows/merge` do the same, with `dry_run`; an agent's scheduled run on
  a database it may edit can merge its duplicates too, as one of its changes. Migration 0108 adds
  `page.merged_into_id` and `row_activity.merged_from_id` / `merged_from_title`.
- **Review what agents change before it is made.** An agent's settings get *Changes to rows*:
  *Write them directly* (as before) or *Propose them for review*. Set to propose, its runs' changes
  to rows (adding a row, changing values or the title) are kept instead of made, each with the
  agent's reason, and the run is told they wait. A newer proposal from the same run for the same
  row takes the place of the one waiting. They wait on the new *For review* page in the sidebar
  (with a count, and in the More menu and the command palette), filtered by agent, database or
  row: each shows the agent, the row and its run, why, and every value as it was, is now and would
  become. Anyone who may edit the row (the database, for a new row) and each value it sets may
  approve it, edit it first (change a value, or leave one out) or dismiss it, one at a time or
  several at once; others who can open the row see it without the buttons. Approving makes the
  change as the approver, and the row's activity says the agent proposed it; a row that changed
  since in a value the proposal sets shows what it has now and is approved only with *Approve
  anyway*. A change that can't be made stays with why, to edit and approve again. A row with
  proposals waiting says so above its properties, with a link to them. The person the run worked
  for (else whoever made the agent, else the workspace's owners) hears about new proposals in their
  inbox, as one item per workspace that newer ones bring back to the top, also by push and Telegram
  as their preferences say (*For review* in Preferences). Proposals no one answers expire after
  30 days with the daily cleanup, and answered ones go 30 days later. Chats with an agent still
  change rows directly: the person is there. The built-in *Request answerer* template proposes its
  answers for review. Approving and dismissing go to the audit log. MCP gets
  `list_pending_changes`, `approve_pending_change` (with an edit and `force`) and
  `dismiss_pending_change`, the REST API `GET /workspaces/{id}/pending-changes` and
  `POST /pending-changes/{id}/approve` and `/dismiss` (409 `change_conflict` and `change_decided`),
  and agents' `row_changes` in both. Migration 0109 adds `pending_change`,
  `row_activity.proposed_by`, `workspace_agent.row_changes` and the `review_…` columns of
  `user_preference`.
- **Agents draft email for you to send.** An agent's run on a row, or a schedule's run on a
  database, that works for someone with a connected mailbox, where email on rows is on and mail is
  matched to that database, gets `draft_email`: it writes a subject and a plain-text message, and
  the draft waits under *For review* for that person alone, from whose mailbox it goes out once
  they approve it (edited or not); dismissing it sends nothing. The draft answers the row's latest
  message (to its other party, keeping its subject), else starts a new one to the row's own
  addresses. Agents never send email themselves and don't read the row's mail. A draft that isn't
  a finished message (gaps to fill like `{{name}}` or `[Your Name]`, bracketed source numbers,
  Markdown, HTML, the app's own ids, links or markup, an empty text or a subject on two lines) goes
  back to the agent with what is wrong; a reviewer's edits aren't checked. The run's steps show the
  drafts.
- **Automations with steps that work together.** An automation can now start on a schedule
  (daily, on weekdays, on days of the month or a cron expression, in its time zone), when another
  service POSTs JSON to its own secret address (answered `202` with the run's id; at most 64 KB
  and 60 requests a minute; *New address* retires the old one), or when any of several properties
  changes. Besides setting properties, notifying people (now with a message), webhooks, agents and
  the trash, its up to 20 steps can send an HTTP request (https, guarded like webhooks; its JSON
  answer is there for the next steps), find rows of any database of the workspace by filters and
  sorts, create a row, update the row that matches a value or create it, wait up to 7 days (in the
  queue, across restarts) and write to the run's history. Setting properties, notifying and
  running an agent can go for each found row. Steps use what started the run and what earlier
  steps gave as `{{trigger.Status}}`, `{{find.rows.0.title}}` or `{{http.body.id}}`; a value that
  is one template keeps its type, and a step that uses one that failed is skipped
  (`dependencyFailed`). Changes can be saved as a draft, tried with a test run (real effects,
  marked as a test, as whoever ran it) and published as the next version; runs under way keep the
  version they started with. The run history shows each step's input, output, duration and, for a
  for each step, how each row went. Over MCP, `create_automation` and `update_automation` take
  the new triggers and steps, `publish: false` and `new_webhook_address`; `publish_automation`,
  `discard_automation_draft` and `test_automation` are new, and `list_notifications` includes a notification's message.
  Migration 0110 adds `automation_version` (existing automations become their
  version 1), a draft, next run and webhook address salt to `database_automation`, what started a
  run, its version, test mark and state to `automation_run` (whose row may now be empty), and a
  message to `notification`.

- **Ask the AI chat from Telegram.** With `TELEGRAM_BOT_TOKEN` set to a bot made with @BotFather,
  people link their Telegram account in My account → *Connected apps* → *Telegram* (a one-time
  link, also as a QR code, that works once for 10 minutes) and then ask the AI chat in a private
  chat with the bot, by text or by voice message (written down by speech to text where the server
  has it). Answers come formatted for Telegram, with the changes they made and their sources as
  links to the pages. In *Ask* mode each change, note to remember or call that changes something
  at a connection is asked about with *Yes* / *No* buttons only the linked person can press.
  `/new` starts a new conversation, `/workspace` and `/mode` pick the workspace and what the chat
  may change, `/stop` stops an answer and `/unlink` unlinks the account; Telegram's menu lists them
  in each of Leafdesk's languages. The bot runs each question as its person, as a connected app,
  so a workspace's *Connected apps and API tokens* switch holds it: off hides the workspace, read
  only answers without changing anything, notes about the person included. The server reads the
  bot's messages by long polling, so it needs no public address (`TELEGRAM_API_URL` points at a
  self-hosted Bot API server). Conversations show in the app's chat history. The person's inbox
  notifications come to the chat too, as soon as they are saved, saying what a push notification
  says, with the workspace, a link and *Mark read* / *Snooze 1 hour* buttons; My account →
  Preferences gets a *Telegram* column to choose them per kind (following the inbox, as push does),
  and the Telegram card's *Send my notifications here* switch or `/notifications` turns them off.
  Notifications of a workspace that turned connected apps off don't go there, and a chat that
  blocked the bot gets them turned off. An agent's call waiting for an owner comes with what it
  would send (hidden until tapped) and *Approve*, *Decline* and *Send back with a note* buttons;
  *Approve* only where all of the call shows, as in the inbox, only for the owners the run is for
  and only for the call they saw. The audit log notes answers given from Telegram, and a workspace
  that lets connected apps only read has its calls answered in the app. Migration 0105 adds `telegram_link` and
  `telegram_link_code`; migration 0106 adds the `…_telegram` columns of `user_preference` and
  `telegram_link.notifications`.
- **Share an agent.** Each agent has a **Share** list in its settings: people, groups and everyone
  in the workspace (never guests), each with *Full access* (everything an owner can do with it,
  sharing and archiving too), *Can edit* (its settings, instructions, pages, skills, schedules,
  memory and versions; asking it for runs and adding it to automations) or *Can view & interact*
  (every tab read-only, only their own runs, chatting with it in its dialog or a page's block, and
  mentioning it in comments). A person's own entry decides, then the highest of their groups', then
  everyone's; workspace owners always have full access. Anyone it isn't shared with doesn't see it
  in the list, can't chat with it and isn't offered it as a mention. A new agent is shared with
  everyone at *Can view & interact* and with its creator at full access, and existing agents are
  set up the same way. Connections' tools, the monthly token limit and run approvals stay with
  owners; a run no owner answers for (a chat, request or schedule of someone who isn't an owner)
  isn't offered connections' tools that change something. Every change to the list goes to the
  audit log, and versions don't keep it. A new workspace setting, **Who can create agents**, keeps
  creating agents (from scratch, a template or a description) to owners or opens it to all members;
  a member who creates one gets full access. Settings → *Agents* now shows members the agents
  shared with them, and the agent dialog's tabs scroll instead of overflowing. MCP adds
  `share_agent`, and `get_agent` and `list_agents` return `your_access` (with the list in
  `get_agent`); the REST API adds `GET` and `POST /agents/{id}/sharing` and `your_access` on
  agents. Migration 0104 adds `agent_share` and fills it for existing agents.
- **Run an agent on the fast model.** Where the server has `AI_FAST_MODEL`, an agent's settings
  offer a choice of model, each shown by name: the main model (the default), for work that needs
  judgment, or the cheaper fast model, for routine, well-defined jobs such as summaries or sorting
  rows. Every turn of the agent's runs, however they start, then goes to that model, with the same
  tools and limits and a little thinking. Each run records the model that answered it, shown in the
  agent's runs, and the workspace's AI usage counts it under that model. The choice is hidden where
  it wouldn't apply: without `AI_FAST_MODEL`, or on a workspace's own AI account, which has one
  model; a fast agent runs on the main model there. MCP's `create_agent` and `update_agent` and the
  REST API's `PATCH /agents/{id}` take `model` (`main` or `fast`), and `list_agents`, `get_agent`
  and the run lists return it. Migration 0099 adds `workspace_agent.model`.
- **Agents can read the web.** Each agent has a **Web access** switch in its settings, off by
  default. With it on, its runs can read public web pages: `read_web_page` returns a page's title
  and main text without markup (at most 20,000 characters, with a note when it is cut, and the
  links on it), and plain text and JSON as they are; images, PDFs and other files are refused.
  Pages are fetched with the same guard as files attached by URL: only public addresses on the
  web's usual ports, checked again on every redirect, within 15 seconds and a size limit. When the
  server sets `WEB_SEARCH_URL` to a self-hosted SearXNG instance, runs can also `search_web` (up to
  8 results with title, address and snippet). What comes back reaches the model framed as outside
  data, and the agent is told that instructions on web pages aren't its owners'. Each page and
  search shows in the run's steps and counts toward what a run may read from outside; a run no
  member stands behind asks an owner before each one. MCP's `create_agent` and `update_agent` take
  `web_access`, and `get_agent`, `list_agents` and the REST API's agents return it. Migration 0100
  adds `workspace_agent.web_access`.
- **Dashboard views of a database.** **Dashboard** in a database's add-view menu gives it an
  overview tab: the dashboard grid, with numbers (a count, or the sum or average of a number
  property), charts, lists and other layouts, each a view of that database with its own filters,
  title, width and color. A new one starts with the row count, the sum of the first number
  property, a chart by the first select or status property and the rows edited last. People who
  may change the database's views set the widgets up in place, as on a dashboard block; everyone
  else sees each widget worked out from the rows and values they may see, archived rows left out.
  Phones show one widget per row. Dashboard views aren't published, printed or offered to linked
  views. MCP's `create_database_view` makes one (with default widgets, or the ones given in
  `widgets`), `update_database_view` replaces its `widgets`, and `get_database` describes them.
- **Describe an agent and let AI draft it.** Beside **New agent**, owners can choose
  **Describe an agent**, say in their own words what it should do ("Every Monday, summarize
  last week's new rows in Tasks and comment the summary on the Weekly page") and press **Draft**.
  The AI drafts the agent: a name, a description, step-by-step instructions in the language the
  description is written in, the pages and databases it needs (only ones the owner has full access
  to, each at the least access that does the job) and when it runs: a schedule, and automations on
  a database (a row added or a form answered, a property changed, a date passed). Nothing is saved:
  the usual form opens filled in, with the pages it would share and the schedules and automations
  it would set up listed under **Will be set up**, each with a way to remove it. Creating the agent
  shares those pages and sets up what is left, and takes it all back when a step fails. It shows
  where AI is on, counts as the agents' AI usage and is held to the workspace's AI limits; an error
  keeps the description. MCP gets `draft_agent`, which returns the draft without saving it.
- **Mention an agent in a comment.** Typing `@` in a page's comments offers, below the people, the
  agents that may comment on the page, with their icons. When a member posts a comment that
  mentions one (a new thread or a reply), the agent reads the comment, the thread before it and the
  page, within that member's access as well as its own, may change that page where both may edit
  it, and answers in the same thread as itself; the reply notifies the thread's people like any
  other. When it can't answer (its monthly tokens used, AI off, paused, out of time) it says so in
  the thread. Mentioning an agent twice runs it once; edits, guests' comments and agents' own
  replies start no run. The agent's runs show who mentioned it and on which page, also in
  `list_agent_runs` and the REST API (source `mention`, code `commentGone`).
- **History of an agent's setup, with restore.** Each saved change to an agent's settings (name,
  icon, description, instructions, active or paused, monthly token limit, and settings added
  later), its skills, its schedules or the pages shared with it keeps a version; one person's
  changes within two minutes of each other make one, and the last 50 are kept. The agent's new
  **History** tab lists who saved each version, when and what changed; opening one shows what
  changed from it to the current setup, the instructions line by line and the rest as before and
  now. Owners can **Restore this version** after confirming: settings, skills (in their order),
  schedules and shared pages go back to how they were, through the same checks as changing them by
  hand, and what can't come back (a page deleted or in the trash since, one the owner can't share,
  a skill others may now edit, a setting no longer valid) is skipped and listed. Runs, memory and
  usage aren't touched. A restore makes a version of its own and is recorded in the audit log.
  Databases automations share with an agent aren't part of its setup. Agents made before start with
  their current setup as version 1. MCP gets `list_agent_versions` and `restore_agent_version`;
  workspace backups include the versions. Migration 0101 adds the `agent_version` table.
- **Agents hand part of a job to other agents.** An agent's settings have **Agents it can ask**:
  other agents of the workspace an owner ticks. During a run it can then hand part of its task to
  one of them with an `ask_agent` tool (the agent, the task and what to send back), wait for it and
  use its answer, which reaches it as data from another agent, never as instructions. The helper
  does the part in a run of its own, with its own access, tools, skills, notes, instructions and
  limits, its tokens counted against it; it changes no pages, proposes no notes and can't ask
  further agents. A run asks at most 3 times; its own time stands still while it waits, for up to 4
  minutes of waiting in all. A helper's run is held to whose access holds the asking run, and when
  no one stands behind what that run read, each of its connection calls waits for an owner too; it
  shows to whoever the asking run shows to. A paused or archived helper, or one over its monthly
  token limit, is explained to the asking run instead of run, and one still waiting for an approval
  goes on without it. Both histories link: the asking run shows "Asked <agent>: <task>" opening the
  helper's run, which shows who asked. The helper runs in the asking run's slot, so even one slot
  (`AI_CONCURRENCY=1`) never waits on itself. Archiving an agent takes it off every list; backups
  carry the lists. MCP's `create_agent` and `update_agent` take `helper_agent_ids`, `get_agent` and
  `list_agents` return it, and `list_agent_runs` shows runs of kind `handoff`; over REST, the agent
  endpoints return it, `PATCH /api/v1/agents/{id}` changes it and runs show the new kind. Migration
  0102 adds the `agent_helper` table.
- **Archive pages that are out of date.** An old price list or a superseded offer can be archived
  instead of trashed: people with full access choose **Archive** in the page's menu. The page keeps
  everything else (it stays readable, editable, reachable by its link, mentions and backlinks, and
  published if it was) but leaves the sidebar, search, the mention and link pickers, recent pages,
  the AI chat's sources and what agents, MCP clients and the REST API search and list. The pages
  under it count as archived too, and database rows with their database; rows can also be archived
  one by one, and a database view can show them again (**Show archived rows** in its layout menu).
  An archived page shows who archived it and when, or which page above it is archived, with
  **Unarchive** for people allowed to; unarchiving brings the pages under it back. Search has an
  **Include archived** switch that marks what it finds. Archived pages aren't in the trash and go
  to the trash and back still archived; duplicating one keeps it archived. MCP gets
  `set_page_archived` and an `include_archived` flag on `search`, `list_pages` and
  `query_database`; REST gets `POST /pages/{id}/archived` and the same flag on its page listings and
  search, and pages say whether they're archived. Migration 0097 adds `page.outdated_at` and
  `page.outdated_by`.
- **Mute the replies in one comment thread.** Each thread in a page's comments panel has a menu
  with **Mute replies**: from then on new comments in that thread don't reach the person, in the
  inbox, by email or by push, and a bell mark on the thread says so. Replying in the thread, or
  being mentioned in a comment there, ends the mute, so nothing addressed to them is missed; the
  comment that mentions them still notifies them. **Unmute replies** ends it by hand. Each person
  mutes for themselves, and deleting the thread or its page forgets the mutes. Typing `@` in a
  comment offers the people who can open the page; the people mentioned are notified and the
  comment keeps their names as text. Migration 0098 adds the `thread_mute` table.
- **Present a page as slides.** **Present** in a page's menu, or ⌘⌥P (Ctrl+Alt+P), shows the page
  over the whole screen, read-only, in the app's light or dark theme. The first slide is the page's
  icon and title on its background; after it, each divider starts a new slide, or on a page without
  dividers each heading of level 1 or 2 does, and blocks nested under one stay with it. Slides draw
  the page's own blocks (tables with merged cells, images, callouts, columns, code, equations and
  embeds) with larger text, and a slide longer than the screen scrolls. →, Space, Page Down or a
  click go on, ← and Page Up go back (mirrored in right-to-left languages), Home and End jump to the
  ends, and Esc ends it. A counter and a progress line show where you are; the controls fade while
  the pointer rests, and slides change without motion when the system asks for less. Edits made
  meanwhile show as they come. The shortcut is listed under **Keyboard shortcuts**.
- **Writing instructions for voice notes, per database.** A database can say how the voice notes
  saved in it are written up, e.g. "Customer visit note: company, person met, what was discussed,
  quote status, next step". People with full access set them from the database's page menu
  (**Voice note instructions**, up to 2,000 characters); they apply to everyone recording into it,
  from the quick note and the REST API. The AI follows them for the note's content and layout, but
  keeps the note's title and property format, adds nothing that wasn't said, and still reads the
  transcript only as what was said. The quick note says when the chosen database has instructions.
  `get_database` (MCP and REST) shows them as `voice_note_instructions`, and duplicating a database
  keeps them. Migration 0096 adds `page.voice_note_instructions`.
- **Jump to the pages beside one from the breadcrumb.** Resting the pointer on a page in the
  breadcrumb at the top of a page, or pressing the down arrow on it, lists the pages beside it:
  the other subpages of its parent in the sidebar's order, the other top-level pages of its
  teamspace or of the private pages, or for a database row the other rows of its database (the
  first 50, in the rows' own order) with an entry that opens the database. The page itself is
  marked; the arrow keys move through the list, Enter opens a page and Escape closes it. Clicking
  the current page's title opens its list too, also on touch screens. Only pages the reader can see
  are listed, loaded the first time the list opens.
- **Dictate a question in the AI chat.** The chat's box, in the panel and on the full page, has a
  microphone button where the workspace can transcribe recordings (as for voice notes): press it to
  record, press again to stop. The time shows while recording, with a button (or Escape) to cancel.
  What was said goes into the box at the caret without being sent, so it can be fixed first. It
  counts as the AI chat's usage, and the recording isn't stored.
- **Merge table cells.** Select cells of a table on a page and merge them into one from the
  formatting toolbar, across columns, rows or both; the cell's menu splits a merged cell again.
  Merged cells show on published pages, Markdown export writes the table as a full grid with the
  places a merged cell covered left empty, and turning the table into a database does the same.
  Saving a page from its Markdown source names merged cells among what Markdown can't keep.
- **The AI chat can use connections' tools.** Owners tick **In chat** next to a connection's tools
  (Settings → Connections → a connection → Tools), and members' chats may call them; guests' chats
  never get them. Reading tools run at once and show as a step under the answer. A tool that
  changes something at the service asks the person before every call, in Auto too, and isn't
  offered in a read-only chat; an answer that sent one can't be asked again. What a service returns
  reaches the model as outside data, cut to fit, with credentials masked in the step and the audit
  log, which records each call as the person's. Migration 0095 adds `connection.chat_tools`; a
  connection moved to a new address starts with none.
- **Google Drive, Docs, Sheets, Slides, Gmail, Calendar, Chat and Contacts connections.** The
  connection catalog lists Google's own MCP servers. They sign in an OAuth client made in a Google
  Cloud project: enter its ID and secret on the connection, or set one for all of them as
  `google=CLIENT_ID:CLIENT_SECRET` in `CONNECTION_OAUTH_CLIENTS`. Each asks only for the scopes its
  tools use (Drive files are read, and written only when made through Leafdesk; Gmail never gets
  the whole mailbox), and Leafdesk asks Google for a refresh token, so a sign-in doesn't end after an
  hour. The README's Connections section has the setup in Google Cloud.
- **What AI costs, per workspace.** Every AI request (chat, writing assistant, AI properties,
  agents, voice notes, semantic search) adds its tokens and cost in US dollars to its workspace's
  month, by feature and model, whichever account paid. Owners see this month and the last twelve in
  the new **Settings → AI usage**. Only counts are stored, never what was asked or answered.
- **Monthly AI cost limits.** Owners can set the most their workspace's AI may cost in a month, and
  `AI_MONTHLY_LIMIT_USD` caps what the server's own AI key pays for each workspace (a workspace on
  its own AI account isn't held by it). Past a limit, AI requests are refused with a clear message
  until the next month, before anything is sent. Migration 0094 adds the `ai_usage` table. With
  Docker, the new `docker-compose.yml` passes `AI_MONTHLY_LIMIT_USD` on to the app.
- **A fast model for simple jobs: `AI_FAST_MODEL`.** A second, cheaper model at the same provider,
  with the same key, for AI property values and writing up voice notes, e.g. `AI_MODEL=claude-opus-5-5`
  with `AI_FAST_MODEL=claude-haiku-5-5`. Chat, agents and the writing assistant stay on `AI_MODEL`.
  Unset, `AI_MODEL` answers everything as before. A workspace on its own AI account runs every
  feature on the account's model. The startup log names the fast model, and each request's log
  line its model. See the README's AI section.
- **A long paste shows as a chip in the AI chat's box.** Pasting 3 lines or more, or more than
  150 characters, puts a chip ("Pasted 40 lines") at the caret instead of the text, so the box
  stays readable; the question is sent with the pasted text in the chip's place. The chip is one
  piece: the caret steps over it, and Backspace after it (or Delete before it) takes it and its
  paste. Two pastes of the same size are numbered apart.
- **Chat with an agent, and put that chat on a page.** An agent's settings get a **Chat** tab where
  owners write to it and it answers with its instructions, skills, notes, connections and the
  owner's access, and may create and change pages and rows both can edit. The **Agent chat** block
  (slash menu, or paste a link to an agent) puts a chat with an agent on a page, for anyone in the
  workspace who isn't a guest: owners chat as in the tab, everyone else read-only, the agent reading
  only pages both it and they can open, changing nothing and calling only connection tools that
  read. Each person's conversations are their own, per block, with the 20 most recent kept and
  **New conversation** for another. Every answer is one of the agent's runs, shown in its history
  as a chat message and counted in its usage and monthly limit. Guests, published pages and
  exports show the block without the chat. MCP's `list_agent_runs` describes chat runs. Migration
  0103 adds the `agent_conversation` table.

- **Google documents can be imported through the workspace's Google Drive connection.** Import
  has a Google Docs tab: paste links to documents or search the connection's Drive by title, tick
  up to 20, and each becomes a page the way a Word document does (Drive exports it as one), titled
  by its top heading or its name, pictures included, all or nothing. Owners may import through any
  signed-in Google Drive connection; members only through one whose `download_file_content` tool
  an owner allowed in the AI chat (searching needs `search_files` allowed too); guests never. Each
  call is recorded in the audit log like the chat's, and the import as from Google Docs.

### Changed

- **Enter in a code block keeps the line's indentation.** The new line starts with the spaces or
  tabs the line before it started with. On a last line holding only indentation, Enter drops it,
  so leaving the block works as before.
- **Pages open with less to download.** The workspace's routes no longer load the page editor
  until a row is opened beside them, so Home, Settings, the graph, reviews, people and AI download
  about 300 kB less (gzipped) when they open. Board, calendar, timeline, chart and form views, the
  automations dialog, the importer and the QR codes of two-step setup load when first used (views
  in the background once their database has loaded), so a page or database opens with about 75 kB
  less. The client JavaScript budget now checks what opening a page downloads (the largest route,
  and all routes' first loads together) and the largest chunk loaded on demand, instead of the sum
  of every chunk the build holds.
- **The editor downloads only the dictionary of the language in use.** Its menus' texts in every
  language used to come with the editor, about 34 kB (gzipped) on each page opened; now English
  needs nothing more, Turkish, Indonesian and Thai about 3 kB, and BlockNote's other languages
  about 30 kB. The editor keeps its loading state until the dictionary is there, so it never
  shows English menus first.
- **"Export as PDF" downloads a PDF file.** The page menu's *Export as PDF* now makes the file on
  the server, in a letterhead picked in its dialog (for a row, with its values if asked). The
  browser's print dialog moved to *Print*, which still keeps the page exactly as it looks, diagrams
  and equations included.
- **The AI chat's text follows the app's own type scale.** Tables, code blocks and headings in an
  answer and the question box are 14px like the rest of the interface, in the app's own font, instead
  of standing out with 12, 15 and 16px.
- **The desktop app signs in to a connection's service in your browser.** Signing in to a
  connection or to Google Drive or Dropbox storage opens the service's page in the system's
  browser, where you are likely signed in to it already, instead of inside the app. Once you allow
  Leafdesk there, the browser hands the answer back to the app with a `leafdesk://` link and the
  app finishes the sign-in. A sign-in that returns to a browser without a Leafdesk session now
  leads to the sign-in page instead of a missing page.
- **The AI chat fits a conversation to the model, not to a fixed size.** A chat request was
  refused past 48,000 characters, so a workspace whose connections offer many tools (their
  descriptions take room in every request) could fill it before the conversation did, and the chat
  answered "this conversation is full". The chat and agents now size what they send by the model's
  context window. When the model still finds it too long, older tool results are left out first
  (the model can call the tool again), then the earlier turns, and the question is asked again. A
  conversation no longer stops at 40 questions, and a question has no fixed length: it can be as
  long as the model's context window takes, and a long paste is no longer cut in the chat's box.
  `AI_MAX_INPUT_CHARS` is unset by default; set, it still caps every request. The writing
  assistant, AI properties, voice notes and agents' skills keep reading at most 48,000 characters.

- **A clearer Connections page.** Settings → Connections puts **Add another server** next to the
  tabs, on both of them. The catalog's cards are roomier, with a + to connect and a tick on the
  services already added, so long names no longer get cut. Connected services show as cards with
  their logo and a status badge (a green, amber or red dot for ready, needs sign-in or not working),
  and the note on approvals sits in a box of its own. In a connection's Tools tab the tools line up
  in columns, with a switch for **In chat** (and one for all of them above) and a green or amber dot
  for whether each only reads or changes things; a description that only repeats the tool's title
  is left out.
- **Larger small print in settings.** On the workspace's, the account's and the server's settings,
  notes, hints, counts and small buttons are 13px instead of 12px, dialogs opened from there
  included. Their secondary and faint text share one darker gray, so a hint reads as well as a
  description (5:1 or more on the page and its cards, in either theme). The settings navigation's
  items are in the main text color with their icons a step lighter, no longer gray. High contrast
  keeps its own colors, and the rest of the app keeps its sizes and colors.
- **A tidier Connected apps page.** Each app you gave access to shows a badge for whether it only
  reads or also edits, with the full list of what it may do folded under "N permissions". An app's
  tile is tinted from its name, so two apps that start with the same letter look apart, on this
  page and in Settings → Security alike. Connecting an AI assistant shows the server URL on top and
  one assistant's steps at a time, picked from tabs (Claude, Claude Code, Codex, other clients).
- **The AI chat takes the next question while it answers.** A question sent while an answer is being
  written waits in a strip above the question box (how many, the first of them, and Clear) and is
  asked in the same conversation once the answer is done; before, Enter did nothing then. Stop gives
  the waiting questions back: the first into the box when nothing is typed there, the rest still
  waiting, to follow it. Leaving the conversation mid-answer (opening another, closing the panel)
  keeps its waiting questions for when it is opened again in the tab. While the model thinks, the
  line saying so shows the newest line of its thinking, and the whole of it opens from there (it
  isn't kept). Text the model writes before looking something up moves into the steps at once, and
  the "Thinking…" line stays while the lookup runs.
- **The sidebar has three tabs: Home, Journal and Chat.** Home lists your pages as before. Journal
  holds your daily notes: a month calendar, the notes themselves and how new ones start, so the
  journal page no longer sits among your private pages. Chat lists your conversations under a new
  chat. Each tab follows the page you have open, and going back to a tab takes you to where you
  last were in it; clicking the tab you are on goes to its start (the home page, today's note, a
  new chat). The open tab shows its name; the others show only their icons and widen to show their
  names when you point at them. Conversations are listed like pages, and the one an answer is being
  written for has a dot that fades in and out meanwhile. The page header's button that opens the
  chat panel has the same two-bubble icon as the Chat tab.
- **The sidebar's new button asks what to make.** It opens a menu with a new page, a new chat, a
  new database and a page from a template, instead of always making a page.
- **Your mailbox and calendar addresses have their own page under your account.** The new
  **Settings → Email and calendar** (under My account) is where you connect, change or disconnect
  your mailbox for each workspace with email on rows, and where every calendar address you made,
  from a calendar view or from the rows assigned to you, is listed with a way to turn it off.
  The workspace's own email settings moved into **Settings → General → Email**, so there is one
  Email page rather than two: owners choose whether email on rows is on, where mail lands and see
  whose mailbox is connected; members see whether it is on. The workspace's settings are grouped
  under Workspace, Features and Administration.
- **Your snippets and the workspace's share one page.** Settings → Snippets has a tab for each:
  **Mine** (only you see them, in every workspace you're in) and **Workspace** (everyone in it uses
  them, owners change them), each with its count. Snippets is no longer under My account. The
  examples are offered for your own list only, and an empty workspace list says it has no shared
  snippets. Guests get the page with their own list alone.
- **A source in the full-page AI chat opens beside it.** Clicking an answer's citation (or a page it
  read) opens the page in the panel at the right instead of leaving the conversation, scrolled to the
  cited passage; the panel's up and down buttons (K and J) go through the conversation's other sources,
  and Esc closes it. A database still opens as its page, as does every source on a phone.
- **Claude Haiku 5.5 and Sonnet 5.5 are known models.** The AI library (pi-ai 1.3.0) now has them,
  so they run with their real 1,000,000-token context window, output limit, prices in the server
  log and thinking settings, where they used to be sent as an unknown model. The examples in the
  README and `.env.example` use `claude-haiku-5-5`.
- **`AI_MAX_OUTPUT_TOKENS` defaults to 8192** (was 2048). Claude 5.5 models think before they
  answer, and their thinking comes out of the same tokens as the answer, which could cut answers
  off. A model that thinks now always gets the whole limit, also for AI property values, which
  other models still keep to 800 tokens, and no request asks for more than the model's own output
  limit. A server that sets `AI_MAX_OUTPUT_TOKENS` itself keeps its value; raise it if answers end
  early.
- **Each AI feature asks for the thinking it needs.** Claude 5.5 models think at high effort by
  default, which costs tokens and time on every request. AI property values and the AI account
  test ask for as little thinking as the model can do (none on Claude Haiku 5.5, low effort on
  Sonnet and Opus 5.5, which always think); writing up voice notes and the writing assistant's
  fixed actions ask for low effort; the chat and the writing assistant's own instructions for
  medium. Agents keep the model's default. The README's AI section has the table.
- **The MCP tool list is smaller and has a budget.** The descriptions a client sends to its model
  were tightened, filter rules inside groups and automation steps no longer repeat what the
  top-level fields already say (290 KB to 265 KB), and `src/server/mcp/tools-context.test.ts` now fails when the
  whole list passes 275 KB or one tool passes 25 KB, so a new tool has to fit or raise the budget on
  purpose. The list stays the same for every grant: a read-only token still sees the write tools,
  because a step-up challenge is how it asks for them.

### Fixed

- **Access request emails reach the people who can answer them when the requester is in several
  workspaces.** The email's check of the requester's role read their memberships everywhere and
  failed, so no email went out; the inbox and the Share menu were not affected.

- **Find opens collapsed toggles.** Cmd/Ctrl+F found text inside a collapsed toggle (or toggle
  heading) but stepping to it showed nothing; the toggle now opens when its match becomes the
  current one. Opening a link to a block inside a collapsed toggle opens it too.

- **Files open in a desktop window with a title bar on macOS.** A PDF, image or other file opened
  in a window of its own (from the AI chat, a file block) kept the window's buttons over the
  viewer's toolbar, could not be moved by its top edge and was hard to make full screen; such
  windows now have the system's title bar, while Leafdesk pages keep theirs inset.

- **Text filters match the Turkish dotted and dotless i.** A "contains ist" filter now finds
  "İstanbul", and "ışık" finds "IŞIK": database view filters, form question conditions and option
  names given by name (MCP, the REST API, a new tag typed into a cell) fold case with İ, I, i and ı
  treated alike, as search and pickers already did. Other letters keep their accents.

- **The AI chat knows today's date.** Each question now carries the date, weekday and time in the
  asker's time zone (the browser's), so "today", "this week" and dates written into quotes come out
  right instead of the chat saying it can't tell the date.

- **Dragging a table row works where rows share a position.** Rows copied or imported can sit
  on one position, which left no room between them: a row dropped there stayed put. The server now
  places the dragged row itself and, when its neighbours tie, numbers the database's rows again in
  the order they show, without marking them edited. Rows sharing a position and created time now
  always show in the same order. The handle also drags in browsers that don't drag buttons, and
  says so when the view is sorted, which keeps rows from moving.
- **A copied database keeps its AI translations.** Duplicating a database (or a page holding one)
  pointed an AI property's translation source at the original database's property, so the copy's
  translations came out empty; the source, and the properties an AI value waits for, now point at
  the copies.
- **A connection event's agent run stays with the workspace's owners.** Since agents can be shared,
  a member who may edit an agent lists all its runs; for a run a connection's event started, they
  also saw the call it waited on (its tool and input, credentials masked) and what it read and
  answered. Such a run is the owners', as its approvals are: others now see only how it stands.
- **The Windows desktop app installs in minutes, not an hour.** The installer unpacked the app into
  a temporary folder and then copied its thousands of files one by one into place, and antivirus
  software scanned each file on both writes, so the progress bar could sit for up to an hour. It
  now unpacks them straight into the app's folder. The app is also smaller: the local server no
  longer carries the build's file traces or the migrations' schema snapshots, which nothing reads
  when it runs.
- **A line break in a table cell no longer scrambles the table in Markdown.** It is written `<br>`,
  so the row stays on one line. It used to end the row, so reading the Markdown back (the Markdown
  source view, imports of an export, AI tools editing the page) made an extra row and moved the
  text after the break into the wrong cells.
- **A service that turns down Leafdesk's sign-in says why.** When a connection's server took
  registrations but refused Leafdesk's, the settings said the service doesn't let Leafdesk register
  itself. Now a server that won't send sign-ins back to Leafdesk names the address its admin has to
  allow, and any other refusal shows the server's own reason.
- **Workspace backups leave out people's AI chats and what the AI remembers about them.** Both are
  private to each person, but a backup held everyone's, so an owner who opened the file could read
  them. Agents' memory is still backed up. Restoring an older backup passes over the chats and
  people's notes it holds.
- OpenCode Go requests for models the catalog doesn't know go to its current endpoint
  (`opencode.ai/inference/go`), and its Gemini model works.
- **Search treats the Turkish dotted and dotless i alike.** A page saying "IŞIK", "SICAKLIK" or
  "ISITMA" wasn't found by "ışık", "sıcaklık" or "ısıtma", nor "ışık" by "IŞIK", because the
  database lowered "I" to "i" and kept "ı". Pages, the documents they show, the AI chat's searches
  and unlinked mentions now match I, ı, İ and i with each other in both directions, a title that
  has the word written either way still comes first, and the snippet shows where. Migration 0093
  rewrites the `page` and `file_text` tables once to rebuild their search vectors; it runs
  automatically when the container starts (from source, run `pnpm db:migrate`).

## 0.6.2 — 2026-10-20

### Upgrading from 0.6.1

- **Download the new `docker-compose.yml`.** The bundled database now starts without
  `COMPOSE_PROFILES`, and a short-lived `secrets` service runs before the app (see *Install with one
  command*). An existing `.env` keeps working unchanged; `COMPOSE_PROFILES=bundled-db` no longer
  does anything and can go. With an external database, add `BUNDLED_DB=0` to `.env`, or an unused
  bundled database starts next to it. The new file also passes the settings for your own AI keys and
  storage, and those listed under *Fixed*.
- **Migrations 0086 to 0092** run automatically when the container starts (from source, run
  `pnpm db:migrate`). They add tables for email on rows, workspace storage and its moves, people's
  AI accounts and snippets, and columns to `file`, `notification`, `user_preference` and
  `workspace`; nothing large is rewritten.
- After the upgrade the server reads Excel workbooks uploaded earlier in the background, and indexes
  pages for the AI chat's semantic search again so their workbooks go in.
- Your own AI keys and your own storage stay off until `OWN_AI_KEYS_ENABLED` and
  `OWN_STORAGE_ENABLED` are set; email on rows stays off until an owner turns it on in
  Settings → Email.

### Added

- **Footnotes.** `/footnote` puts a number in the text and opens its note; hovering the number
  shows the note. Notes are plain text, and footnotes count in the order the page has them. The
  page lists its notes under the body (a number there goes to its place in the text), and
  published pages and the PDF list them at the end, linked both ways. Markdown, MCP and the API
  read and write them as `[^1]` with `[^1]: The note.` lines at the end, and so does the AI
  assistant: rewriting, translating or continuing text keeps its footnotes, its inline
  equations and its page mentions (which it reads with the pages' titles) instead of running them
  into the sentence. Word footnotes and endnotes import as
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
- **Snippets.** Reusable content put in while typing: `;` and a trigger at the start of a line or
  after a space (`;meeting`, `;log-2`), or the slash menu's *Snippets* group, inserts a snippet's
  blocks. A one-paragraph snippet joins the line's text. `{{date}}`, `{{time}}`, `{{datetime}}`,
  `{{me}}` and `{{page}}` are filled in for the person's language and time zone, and the caret
  stops at `{{cursor}}`. Everyone keeps their own snippets in Settings → My account → Snippets,
  and owners keep the workspace's in Settings → Snippets for all its members; *Save as snippet* in
  a block's menu starts one from the page. The form previews the blocks, and lists import and export
  JSON (also plain `[{"id", "label"}]` lists, with what was skipped and why). Up to 300 per person
  and per workspace. MCP gets `list_snippets`. Workspace snippets are in the workspace's backup.
- **Edit as Markdown.** *Edit as Markdown* in the page menu opens a page's text as Markdown beside
  a live preview of the page it makes, which follows the part being edited (tabs on a narrow
  screen). Shortcuts and a toolbar format text, headings and lists, equation commands are offered
  inside `$…$` and `$$`, and pasted or dropped files are uploaded. Saving keeps the ids of blocks
  whose text didn't change and puts the page as it was into its history; first it names what
  Markdown can't hold, such as colors, alignment and image sizes, and when someone else changed the
  page meanwhile it asks whether to load their version or save over it.
- **Callout styles.** Owners name up to 30 box looks in Settings → General → Callout styles: an
  icon or none, one of the editor's colors, no border, a bar at the side or a full frame, and an
  optional default title. Everyone inserts them from the `/` menu's *Callouts* group, switches a
  callout's style in its block menu, or turns a block of text into a callout of a style. Changing a
  style changes every callout using it, in the editor, on published pages and in PDFs; a callout
  whose style is deleted shows as a plain callout with its own icon and color. Every workspace also
  has a framed box, and any callout can now have a title. Markdown writes a styled callout as
  `> [!key] Title` and a plain one's title after its alert, with `> [!NOTE|blue]` for colors the
  alerts don't have; MCP's `list_workspaces` and the API list the style keys. Markdown imports read
  `:::info`, `:::tip`, `:::warning`, `:::danger`, `:::details`, `:::card` and other `:::`
  containers as callouts, toggles and framed boxes, nested ones too.
- **Install with one command.** Download `docker-compose.yml`, run `docker compose up -d`, open
  http://localhost:3000 and create the first account: no `.env` to write first. On its first
  start a short-lived `secrets` service makes a random auth secret and bundled-database password
  into the `secrets` volume (readable only by the app and the database, never replaced), and the
  app and database read them from there. `BETTER_AUTH_SECRET`, `POSTGRES_PASSWORD` and
  `EXTERNAL_DATABASE_URL` in `.env` take precedence as before, and production still refuses a short
  or example auth secret.
- **The first account administers a new server.** It gets Server administration without
  `ADMIN_EMAILS` (which works as before) and a note, after signing up, on where to close sign-up.
  Only an account no other account predates gets it, so servers that already have accounts are
  unchanged, and of accounts signing up at the same moment exactly one does. Server
  administration now shows whether sign-up is open and how to close it.

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
  used to redraw every card at each step; now only the card being dragged changes. Once a change
  is saved, only the rows it touched redraw, where a board of 400 cards redrew all of them.
- **Docker installs start sooner.** The bundled database is checked every second while it starts
  instead of every five, so the app no longer waits out a whole interval before migrating, and the
  app's health check runs every two seconds during its start.
- **The bundled database runs without `COMPOSE_PROFILES`** (see *Upgrading from 0.6.1*), and an
  external one is chosen with `EXTERNAL_DATABASE_URL` and `BUNDLED_DB=0`. `.env.example` now lists
  the settings most often changed first.

### Fixed

- `docker-compose.yml` passes `ADMIN_EMAILS`, `WORKSPACE_CREATION`, single sign-on for the whole
  server (`OIDC_*`, `SSO_TRUSTED_ORIGINS`), `AI_EMBEDDINGS_MIN_SIMILARITY` and `RETENTION_JOB` to
  the app. Set in `.env`, they used to have no effect under Compose.

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
