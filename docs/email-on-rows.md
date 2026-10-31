# Email on rows

[← README](../README.md) · [All documentation](README.md)

Mail with the people in your databases can land on their rows. An owner turns it on in Settings →
General → Email and picks the databases mail lands on, in order, with the email properties that hold
addresses (a customers database, say). Then each member connects their own mailbox under their
account, in Settings → Email and calendar, for that workspace only: the address, the provider (Google Workspace and Gmail, Yandex, Zoho, or any
IMAP and SMTP server) and an app password made for Leafdesk. The mailbox is tried before it is
kept, and its password is sealed like a connection's secrets (`LEAFDESK_ENCRYPTION_KEY`).

A member may connect up to five mailboxes in a workspace, a shared sales or support address beside
their own, say; connecting an address again changes its mailbox. One of them is their default: the
first one connected, or whichever they make it with *Make default*. When the default is
disconnected, the oldest one left takes its place. Follow-ups, agents' email and email drafts always
go out from the default, and its daily limit and time zone are the ones settings show. Workspace
owners see each member's mailboxes, and how each is doing, in Settings → General → Email.

A Gmail or Google Workspace mailbox can be connected by signing in with Google instead, once the
server has a Google OAuth client for it (below): *Google account* in the form sends the browser to
Google, where the member allows Leafdesk to read and send their mail, and back to the settings,
with the mailbox tried and kept. No app password is needed, so this works where a Workspace
organization turned app passwords off. IMAP and SMTP then sign in with XOAUTH2. The sign-in's
tokens are sealed like a password; the access token is renewed as it runs out. When the member
takes the access back in their Google account (or the client changes), the mailbox says so and
mail to send from it fails at once; signing in with Google again connects it again, and reading
carries on from where it stopped. A mailbox changes between Google and an app password the same
way, on the same account without missing mail.

To offer it, the server's administrator creates an OAuth client of type *Web application* in the
Google Cloud console with `<APP_URL>/api/mail/oauth/callback` as a redirect URI, adds the scope
`https://mail.google.com/` (with `openid` and `email`) to the consent screen, and sets
`MAIL_GOOGLE_CLIENT_ID` and `MAIL_GOOGLE_CLIENT_SECRET`. The client the server signs people in
with Google through can serve, with that redirect URI added. Gmail's IMAP and SMTP take only this
full mail scope, which Google counts as restricted: a consent screen of type *Internal* (people of
one Google Workspace organization) needs nothing more, while an *External* one signs in only its
test users until Google has verified the app. In the desktop app the sign-in happens in the
system's browser, as for connections and storage.

Every minute the server reads the inbox and the sent folder of each mailbox, from where it last
stopped, headers first. A message goes on a row when an earlier message of its thread is on one,
or else when the other party's address is in a matched email property of exactly one row of a
database, trying the databases in order; it is fetched whole only then, so mail that has nothing
to do with the workspace never leaves the mail server. Only rows the mailbox's owner can see
count. A message that reached two members' mailboxes shows once. The sent folder is the one the
server marks as sent or, when it marks none, one named like it in any of Leafdesk's languages (Sent,
Sent Items, Gönderilenler…) at the top or right under the inbox. Settings show which folders are
read, and say so when no sent folder was found: then mail sent from the member's own mail program
doesn't reach rows, and mail written on rows isn't saved in the mailbox.

Under a row's properties, the Email section lists its messages for everyone who can see the row
and its address. Whoever may edit the row and has a mailbox writes a new message or a reply there,
in plain text; it goes out from their default mailbox, or another of theirs picked under *From* (a
reply from the one the message came through), at most 100 an hour from each, is tried again after 1, 5
and 30 minutes when the server can't be reached, and is put in the mailbox's sent folder. It starts
with the mailbox's signature under a `-- ` line, which picking another mailbox swaps. Mail that
comes in tells the mailbox's owner and the row's followers who may read it (the inbox's Email tab,
and push); it never comes as a notification email.

An agent's run on a row (or a schedule's run on a database) that works for someone with a
mailbox may draft a message there (`draft_email`): a reply to the row's latest message, else a new
one to the row's addresses. The draft waits under *For review* for that person alone and goes out
from their mailbox only once they approve it, edited or not. Agents never send email themselves
and don't read the row's mail; a draft that isn't a finished message (gaps like `{{name}}` or
`[Your Name]`, Markdown, HTML, the app's links) goes back to the agent with what is wrong.

Mail servers are reached only on public addresses over TLS (implicit or STARTTLS), checked as
connections are. List a server on your own network in `MAIL_ALLOWED_HOSTS` (comma-separated, a
host name or `host:port`) to let mailboxes reach it, also without TLS. Backups keep the messages on
rows and which databases mail lands on, not the mailboxes: members connect them again after a
restore.

### The Mail tab

A member with a mailbox in the workspace gets a Mail tab in the sidebar's tab strip, while email
is on there. It is their own mail, all of it, not only what landed on rows: the sidebar lists each
of their mailboxes with its folders and unread counts, and the page shows a folder's threads
beside the open one. Only the mailbox's owner reads it; guests, other members, owners, agents,
MCP clients, the REST API and automations don't.

Leafdesk keeps each folder's headers and first lines, read 90 days back once the owner first
opens Mail (every mailbox of theirs at once, in the background, so the others show their unread
counts too) and kept up to date by the minute's read; the messages themselves, their HTML and their
files are read from the mail server when a thread is opened, and aren't stored: a message read is
held in the server's memory for up to 10 minutes, never written, and the first threads of the list
and those beside the open one are read ahead, so they open at once (reading ahead leaves them
unread). HTML mail is shown
cleaned, in a frame of its own, and images from other sites stay out until *Show images* (they tell
the sender the mail was opened, and from where); a message whose images were shown shows them
again the next time it opens. *Always show from this sender* loads them at once in that sender's
mail to the mailbox, and mail from the mailbox's own domain shows them too (not for public mail
services such as gmail.com), as long as the provider's check doesn't say the mail came from
someone else (DMARC failed). The senders on that list are under Account › Email and calendar,
where one is removed; *Stop* on a message does the same. The earlier mail an answer quotes at its
end folds under *•••*, which opens it in place. Messages are grouped into threads by the server's
thread ids, their references and, within 30 days, a reply's subject.

From the open thread: reply, reply all and forward (with its files), archive, junk, trash, star and
mark unread; moves can be undone for 5 seconds before they reach the server, and deleting from the
trash is for good. A right click on a thread in the list opens the same answers and moves without
opening it, plus *Move to* any of the mailbox's folders (not Sent or Drafts), the sender's other
mail (a `from:` search), *Open in new tab* and *Copy link*. Several threads are selected with
their boxes (shown on hover), ⌘/Ctrl-click, Shift-click for a range, `x` for the open one or
⌘/Ctrl+A for all the list has loaded; a bar in place of the list's title then archives, trashes,
marks, stars or moves all of them at once (the keys and a right click on one of them do too), and
Esc leaves the selection. *New message* opens beside the list, where the open thread would be, and Back
closes it; a reply is written under the thread. Text can be bold, italic, underlined or struck
through, with bulleted and numbered lists, quotes and links (⌘/Ctrl+K), and goes out as HTML with
a plain-text part beside it; other formatting pasted in falls away. A picture pasted in, or dropped
on the text, goes where it is put and is sent as part of the message (PNG, JPEG, GIF or WebP, within
the files' limit); other files dropped on the composer are attached. A reply or forward carries the earlier
message under what is written, as it looked (tables, colors, the images it carries), folded under
*•••* in the composer and taken off with *Remove the quoted message*; the plain-text part quotes
its text with `>`. *From* picks any of the
member's mailboxes; recipients are suggested as they are typed, from the people that mailbox wrote
to (first) and heard from, and ⌘/Ctrl+Enter sends. A message being written is kept as a draft in
the mailbox's Drafts folder on the mail server (made if it has none) a few seconds after each
change, and when it is closed or the page is left, so other mail programs see it too and it
survives a closed tab; each save replaces the one before. Drafts open from the Drafts folder
beside the list, and a thread with an answer in a draft is marked *Draft* in the list and shows it
under its messages, to edit or discard; a draft sent goes out as a new message and leaves the
folder. A message sent waits 5 seconds on the server before it goes, so *Undo* can take it back:
it goes back to the drafts, and opens again where it was written. It still goes when the page is
closed meanwhile; if the server restarts in those seconds it doesn't, and the draft last saved stays.
A message that can't be sent then is kept as a draft and says why. Files of up to 20 MB in all, dropped on the message or
attached, at most 100 recipients and 100 messages an hour from each mailbox; the sent folder keeps
a copy. The search
box looks through every folder but the trash and junk, in senders, recipients, subjects and first
lines, and takes `from:`, `to:`, `subject:`, `is:unread`, `is:read`, `is:starred`,
`has:attachment`, `after:2026-01-31` and `before:`. Keys: `c` new message, `/`
search, `j` and `k` next and previous thread, `o` or Enter open the first; in a thread `e` archive,
`#` trash, `!` junk, `s` star, `u` unread, `r` reply, `a` reply all, `f` forward, Escape back to
the list. Backups leave the Mail tab's index out: it is read again once the mailbox is connected.

Each mailbox can have a signature, written under Account › Email and calendar with the same
formatting a message has, or pasted there from another mail program. A pasted signature with
images or a table layout is kept as it came (images from web addresses or carried in it, sizes,
colors; no style sheets or scripts) and goes out as it is; it can't be edited in place, so paste
the changed one again, or write one instead. New messages, replies and forwards start with it under the
line to write on, above the quoted message; it can be changed or taken out for one message, and
picking another mailbox under *From* swaps it for that mailbox's (or adds it, unless it was taken
out). The plain-text part, and messages written on rows, put it under a `-- ` line. Follow-ups,
email drafts and agents' reports go out as written, without it.

### Follow-ups

A follow-up sequence sends a row's contact a few emails one after another until they answer.
Owners add sequences to a database mail lands on, in Settings → General → Email: each step says how
many days after the one before it goes out, its text, and whether it is sent on its own or first put
in the sender's For review queue (approving sends it and the sequence goes on, dismissing stops it).
The first step has a subject; later ones answer in its thread. Texts use the row's values by
property name, plus `Name`, `Title` and `Sender`, always with a fallback: `{{Company | there}}`. A
sequence whose template lacks one isn't saved, and an empty value takes it when the email is
written.

Whoever may edit a row and has a mailbox starts a sequence on it from the row's Email section, on
selected rows from a table's bulk actions, with an automation's *Start a follow-up* step (as the
person the automation runs as), over MCP or with the REST API. A row is in a sequence once at a
time. Emails go out from the sender's default mailbox within the sequence's send window (weekdays
09:00–17:00 by default) in the time zone of that mailbox, at most its daily limit (50 by default;
both under My account → Email and calendar), a few minutes apart. Each email is checked as agents'
drafts are (no placeholders, Markdown, HTML or internal links): one that doesn't pass isn't sent,
and the follow-up pauses and tells its sender, who can fix the row and resume it. A follow-up stops
when the contact's answer lands on the row, the row goes to the trash, the sender's last mailbox is disconnected
or someone stops it; an out-of-office reply pauses it until the day it names (a week when it names
none), while other automated mail leaves it be. Every step is recorded as sent in the same
transaction that queues its email, so a crash or a second server never sends it twice. Ended
follow-ups are kept 90 days. Backups keep the sequences, not the follow-ups under way.
