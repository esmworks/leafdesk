# Export

[← README](../README.md) · [All documentation](README.md)

The page menu exports a page as Markdown or a database as CSV, and a skill as `SKILL.md` (see
[Skills](ai.md#skills)). "Export with subpages" (for a
database, "Export with row pages") downloads a ZIP of the page and everything under it; owners
can download the whole workspace from Settings → General → Export, as Markdown and CSV or as PDFs
(to move a workspace to another server, back it up instead, see [Backups](#backups)). Owners can turn exporting off
in Settings → Security (see [Workspace security switches](account-and-security.md#workspace-security-switches)). The
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

"Include comments", above the exports in the page menu, adds the comment threads to the Markdown
file, to every page and row file of the ZIP and (a switch in its dialog) to the PDF. They follow
the page under a rule and a `## Comments` heading, oldest thread first: each under a `###` heading
saying what it is about (the text it quotes, "About this page", a property's value such as
`On “Status”`, or text since removed), marked *Resolved* when it is, then its comments as quotes
under their author and the time they were written in UTC (`**Ada Demir** · 2026-10-24 09:12 UTC`).
Deleted comments and reactions stay out, and so do threads the exporter can't see: those on a
property value they may not see. The CSV and Excel exports of a database don't carry comments.

A page in the trash can be read but not changed: its content, title, icon, cover and properties
stay as they are until it is restored, and nothing can be moved or added under it.

Pages stay in the trash for the time owners choose in Settings > Security > Data retention (30
days by default, or forever); once a day the server deletes the pages whose time is up, with their
files, and prunes old page history (versions older than 90 days or past the newest 200 of a page;
saved versions and those from before a restore stay a year) and the audit log's events older than
a year. Pages a legal hold keeps (see Settings > Security > Legal holds) stay in the trash, with all
their history, until the hold is released. Production servers run this cleanup; set `RETENTION_JOB=on` or `off` to decide otherwise
(a dev server doesn't run it unless it is `on`).

The ZIP is streamed while it is built, one download at a time per person. Larger exports are
refused up front with a message:

| Variable | Meaning |
| --- | --- |
| `EXPORT_MAX_PAGES` | Most pages (rows and templates included) one export may hold. Default `10000`. |
| `EXPORT_MAX_FILES_MB` | Most MB of uploaded files one export may hold. Default `2048` (at most about 3.5 GB). |

The PDF choice makes a ZIP (`<workspace> PDF.zip`) with the same folders: a PDF per page (as
"Export as PDF" makes it, in the workspace's default letterhead), a database as a table of its rows,
and a row as a PDF of its own only when it has text of its own, with its values. Templates and
uploaded files stay out; at most 1,000 PDFs, made one after another while the ZIP streams. A page
that fails to render is left out rather than stopping the download. It counts as one export in the
audit log.

### Backups

An export is for reading; a backup is for bringing a workspace back. Owners download one from
Settings → General → Back up workspace: a single ZIP (`<name> <date>.leafdesk.zip`) holding every
row of the workspace as the database has it, and its uploaded files. Pages keep their history,
comments, ids and links; databases their properties, views and rows; and so do teamspaces, groups,
permissions, favorites, published pages and forms, the site, agents with their memory, skills and versions,
automations and schedules, daily notes and semantic search's index. Open pages are saved first,
so a change made a moment ago is in. Backups are turned off together with export in Settings →
Security.

Anyone who may create workspaces restores one from **New workspace → Restore from backup…**, on
the same server or another (also with another storage or database), and becomes one of its
owners. A backup comes back with the ids it had, so it restores only where that workspace isn't:
on another server, or here after the workspace was deleted. A backup made by a newer Leafdesk is
refused: update the server first.

People are matched by email. Whoever restores the backup stands for the person with their
address, and someone with a verified account on the server keeps what they had under that
account. Everyone else keeps what they wrote and were assigned, under their name, as a person
without an account (nobody can sign in as them or email them); the restore lists them so you can
invite them, and their own sign-up is unaffected. Some things belong to the server and don't
travel: pending invitations and join requests, the invite link, SSO and SCIM setup, API tokens,
connected apps, notifications, the audit log, agent and automation runs, and connections'
sign-ins (connections ask to be signed in to again). People's AI chats and what the AI remembers
about them are theirs alone, so a backup leaves them out too, and restoring an older backup that
held them doesn't bring them back; agents' memory travels with them. Allowed email domains must be verified again,
a site whose address is taken on the new server is left out, and semantic search builds its index
again when the server uses another embeddings model. *Single sign-on only* comes back as *Any
method*, to choose again once single sign-on is set up, unless the server has its own provider
(`OIDC_ISSUER`), which members are then sent to.

A backup file can be edited, so a restore trusts nothing in it: every row must belong to the
backed-up workspace and point only at rows of the backup, and anything else refuses the whole
file. One backup or restore runs at a time per person, and two per server.

| Variable | Meaning |
| --- | --- |
| `BACKUP_MAX_ROWS_MB` | Most MB of rows (before compression) one restore reads into memory. Default `2048`. |

A backup holds at most about 3.5 GB of files and 60,000 of them (a ZIP without ZIP64), and a
restore checks them against the server's per-workspace storage limit.

### PDF

"Export as PDF" in the page menu makes the page's PDF file on the server and downloads it, in one
of the workspace's letterheads (below) or none; for a row, with its values if asked. It reads the
page as the person exporting can see it (database blocks, synced blocks, mentions, footnotes;
images if they are PNG or JPEG uploads), is an export (off while export is off, in the audit log)
and lays tables out with amounts on the right. Diagrams and equations print as their text. The
server's font (Roboto) covers Latin, Greek and Cyrillic letters, not Arabic, Hebrew or CJK text.

"Print" in the same menu opens the page's print view (`/print/<page id>`) in a new tab and, once
its images and diagrams have loaded, the browser's print dialog, where "Save as PDF" keeps the page
exactly as it looks. The print view draws the page the way published pages do (headings, tables,
code, images, callouts, equations, Mermaid diagrams, database blocks, footnotes with their notes at
the end) and is always light, also in dark mode. Callouts set to *Hide when printing* in their block
menu are left out, with the blocks nested in them. Code and tables wrap to the page width, headings stay with the text after them, and
each page starts with its title. Links to other pages print as their titles. "Include subpages"
in the view's bar adds the pages under it (up to 100), each starting on a new sheet; database
rows print in their database's table. It shows what the person printing can see, like the page
itself, and follows the workspace's two-step policy. The browser's own header and footer (date,
address, page numbers) can be turned off under "More settings" in the print dialog.

**Letterheads.** Owners set up the workspace's letterheads in Settings → PDF templates (up to 20):
a name, a logo (PNG or JPEG up to 512 KB, kept in the database, never a link) on the left, in the
middle or on the right, up to six lines at the top of every page beside it (the first in bold:
the company, then its address, phone, tax number), up to four lines at the foot (bank details),
an accent color for the rule under the top and the table headers, and page numbers. One of them is
the default, which "Export as PDF" picks first and the AI chat uses unless asked for another or
none; the first one added becomes the default. Members print in them; guests make PDFs without
one.

The AI chat (and an agent in its owner's chat) can also make a page's or row's PDF (`create_pdf`),
for a quote, a letter or a report it has just written into a page, in a letterhead it names or the
default. The file is attached where the page's people find it: at the end of the page's text, or
in a row's files property the chat names, and the answer links to it. It is a change too (asked
for in *Ask* mode, refused without edit access or on a locked page). A row's values are left out
unless asked for, since a document made for a customer rarely means to show them.

### Edit as Markdown

"Edit as Markdown" in the page menu (for people who may edit the page; not for databases, locked
pages or pages in the trash) opens the page's text as Markdown, in the same form Markdown export,
MCP and the API use: callouts as `> [!NOTE]`, toggles as `<details>`, equations as `$…$` and
`$$`, footnotes as `[^1]`, Mermaid code blocks, and `<!-- leafdesk:… -->` comments for database
blocks, synced blocks and columns. It is read from the live page, so it holds what everyone editing
it has typed. The Markdown sits on the left and a preview of the page it makes on the right,
drawn by the editor itself and updated as you type, so it shows what saving will write; the
preview follows the part of the Markdown you are editing. On a narrow screen the two are tabs.

Ctrl or ⌘ with B, I, E and K make bold, italic, inline code and a link, with 1 to 6 (or with Alt
and 1 to 6, where the browser keeps the plain ones for its tabs) a heading, and with Shift and 7,
8 or 9 a numbered, bulleted or to-do list; Ctrl or ⌘ Enter checks a to-do. Inside `$…$` and `$$`
equations, `\` offers equation commands. Pasting or dropping files uploads them and writes their
Markdown. Ctrl or ⌘ S saves and Esc closes, asking first when there are unsaved changes.

Saving rewrites the page's text from the Markdown: blocks whose text didn't change keep their
ids, so links to them and comments on them stay, and a version of the page as it was goes into
its history first. Before saving, the view names what Markdown can't hold and saving would drop
(text and background colors, alignment, image sizes, some callout settings, underline, table
column widths and cell colors), and says so when the Markdown changed lines inside a synced block,
whose content is edited on the page and kept as it was. When someone else changed the page after
the Markdown was opened, saving stops and offers to load the page as it is now or to save the
Markdown over it. Opening and saving need a connection: when it drops, the Markdown stays open
and can be edited, but Save is off until the connection is back.
