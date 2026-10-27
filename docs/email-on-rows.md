# Email on rows

[← README](../README.md) · [All documentation](README.md)

Mail with the people in your databases can land on their rows. An owner turns it on in Settings →
General → Email and picks the databases mail lands on, in order, with the email properties that hold
addresses (a customers database, say). Then each member connects their own mailbox under their
account, in Settings → Email and calendar, for that workspace only: the address, the provider (Google Workspace and Gmail, Yandex, Zoho, or any
IMAP and SMTP server) and an app password made for Leafdesk. The mailbox is tried before it is
kept, and its password is sealed like a connection's secrets (`LEAFDESK_ENCRYPTION_KEY`).

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
in plain text; it goes out from their own mailbox (at most 100 an hour), is tried again after 1, 5
and 30 minutes when the server can't be reached, and is put in the mailbox's sent folder. Mail that
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
time. Emails go out from the sender's own mailbox within the sequence's send window (weekdays
09:00–17:00 by default) in the time zone of their mailbox, at most its daily limit (50 by default;
both under My account → Email and calendar), a few minutes apart. Each email is checked as agents'
drafts are (no placeholders, Markdown, HTML or internal links): one that doesn't pass isn't sent,
and the follow-up pauses and tells its sender, who can fix the row and resume it. A follow-up stops
when the contact's answer lands on the row, the row goes to the trash, the mailbox is disconnected
or someone stops it; an out-of-office reply pauses it until the day it names (a week when it names
none), while other automated mail leaves it be. Every step is recorded as sent in the same
transaction that queues its email, so a crash or a second server never sends it twice. Ended
follow-ups are kept 90 days. Backups keep the sequences, not the follow-ups under way.
