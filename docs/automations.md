# Automations and webhooks

[← README](../README.md) · [All documentation](README.md)

Contents: [Automations and webhooks](#automations-and-webhooks), [Page webhooks](#page-webhooks).

## Automations and webhooks

A database automation does a list of steps when rows of its database are added or changed, when
someone clicks a button on a row, when a meeting on a row is written up, when a date of a row comes, when a total over a view's rows crosses a line, on a schedule, or when
another service sends it a request. People with
full access to the database see and manage its automations, in the app or over MCP
(`list_automations`, `create_automation`, `update_automation`, `publish_automation`,
`discard_automation_draft`, `test_automation`, `delete_automation`, `list_automation_runs`). Creating, changing, publishing
and deleting one is recorded in the audit log.

**Triggers**

- *A row is added*, however it is added: in the app, through a form, an import, MCP or the REST API.
- *A property changes*: one property, several (any of them), or any property of an existing row.
  For a single select, status, checkbox, person or multi-select property it can wait for a value:
  "Status changes to Done" runs only when the value becomes Done, not when the row is saved again
  with Done (for person and multi-select, when that person or option gets added). A new row that
  starts out with the value counts too.
- *A date passes*: a row's date is at least a number of days past (0 for the day itself). The date
  is one of the database's date properties (its start, for a range), when the row was added, or
  when it was last edited. Optionally only for rows whose status (one status property, chosen when
  there are several) is in some of its groups: to do, in progress, done; a row without a status
  counts as to do. "Rows not edited for 30 days that aren't done", "rows whose Completed on is 14
  days past" and "the day a Due date comes, for rows not done" are each one such trigger.
- *A total crosses a line*: a calculation over the rows a shared view of the database shows goes
  above or below a number. The view's filters pick the rows ("Category is Cash and bank",
  "Due date is before today and Status isn't done"); the calculation is the number of rows, or the
  sum, average, median, smallest or largest value of a number property (or a formula or rollup
  that gives a number). "When the sum of Amount in Cash and bank goes below 50,000" and "when the
  number of rows in Overdue goes above 0" are each one such trigger. See
  [When a total crosses a line](#when-a-total-crosses-a-line).
- *On a schedule*: every day, on some weekdays or some days of the month at a time of day, or on a
  five-field cron expression (`*/30 8-18 * * MON-FRI`), in the automation's time zone. A day of the
  month the month doesn't have (the 31st, the 29th of February) runs on its last day; a time the
  clocks skip runs as much later as they moved (02:30 becomes 03:30), and one that happens twice
  runs the first time only. The server looks
  for due schedules every 30 seconds; one that was down runs once for the times it missed, not
  once each. The settings show when it runs next.
- *An incoming webhook*: a JSON `POST` to the automation's own secret address starts it, with the
  body as what the steps work with (see [Incoming webhooks](#incoming-webhooks)).
- *A button is clicked*: someone clicks a button property's button on a row. It runs on that row
  as the other row triggers do, with whoever clicked as the person who made the change. Clicking
  takes edit access to the row (and to the button, where the property has access rules); a person
  may click one row's button 10 times a minute. A button property's menu opens the automation
  made for it (*Edit what it does*), or starts a new one; several automations may share a button
  and all start on a click.
- *A meeting is written up*: AI has written the summary, decisions and action items of a
  [meeting](ai.md#meeting-notes) recorded on a row's page (a Visits or Calls database whose rows
  each hold their meeting). It runs on that row, with whoever ended the recording as the person
  who made the change, and again when someone asks for the write-up again (*Regenerate summary*;
  then they are that person). A meeting where nothing was heard, or whose write-up failed or
  had no AI to write it, starts nothing; neither does a meeting on a page that isn't a row, or on a
  row in the trash. Its texts are in `{{trigger.meeting.…}}` (below); a *Run an agent* step hands
  the row, its meeting included, to an agent, to turn the action items into tasks or update the
  customer. A test run uses the row's last written-up meeting.

Schedules, totals crossing a line and incoming webhooks have no row. Their steps that act on a row (setting properties,
running an agent, notifying the people a person property names) go *for each* row an earlier
*Find rows* step found; *Send a webhook* and *Move to trash* aren't offered, and a date can be set
to the day it runs but a person can't be set to whoever made the change.

**Steps**, done in order, each one on its own (one failing doesn't stop the others, unless they
use what it gave):

- *Set properties* on the row, or for each found row. A date can be set to the day the automation
  runs (in its time zone), a person to whoever made the change (a row added or a property changed
  only; left as it is when an anonymous form answer started it). Formulas, rollups and the
  created/edited properties can't be set.
- *Notify* chosen people and the people the row's person properties name, with an optional
  message: an inbox notification, and an email as each of them chooses in My account →
  Preferences. Only people who can open the row (the database, for a run without one) are
  notified.
- *Send a webhook*: a signed JSON POST of the row to an http(s) address (below).
- *Run an agent* on the row, or for each found row, with a task of up to 2000 characters (see
  [Agents](agents.md#agents)). Only owners of the workspace and those who can edit the agent add or change
  this step, since the agent may open pages others can't; anyone who manages the automation may
  keep or remove it. Saving the automation shares the databases it runs the agent on with the
  agent at edit access. The run is queued and done apart, so the step counts as done once the
  agent's run is queued.
- *Move to trash*: the row goes to the trash, where anyone who may edit it can restore it, until
  the workspace's trash retention deletes it for good. It is always the last step and can't be
  combined with *Run an agent*, which runs later, apart. The audit log records each row an
  automation moves to the trash, with the automation and its person as the one who did it.
- *HTTP request*: a `GET`, `POST`, `PUT`, `PATCH` or `DELETE` to an https address, with headers and
  a JSON body (see [HTTP requests](#http-requests)). Its answer is there for the steps after it.
- *Send to Slack*: posts a message, written with the same `{{templates}}` and Slack's own
  formatting, to a Slack incoming webhook (`https://hooks.slack.com/services/…`, or an address on
  a host in `AUTOMATION_WEBHOOK_ALLOWED_HOSTS`), with a link to the row (or the database) on a line
  of its own. Values from rows are escaped, so a title can't become a mention or a link. The
  address is a secret: it is stored sealed, shown again only as a hint
  (`hooks.slack.com/services/…x9Ab`) in the app, MCP and the run history, and kept when the
  automation is saved without it. Like webhooks, it needs export to be on. *Slack notifications*
  in a database's ••• menu sets one up for a row added or a property changing (to a value).
- *Find rows* of this database or another one of the workspace the automation's person can open,
  with filters and sorts as a view has them, up to 100 rows (20 unless set otherwise).
- *Create a row* in this database or another one the automation's person can edit, with a title
  and values.
- *Update or create a row*: changes the first row of a database whose property (or title) equals
  a value, usually one from the trigger ("the customer whose Email is `{{trigger.email}}`"), or
  adds one with it when there is none.
- *Wait* from 1 minute to 7 days before the next step. The run waits in the queue, not in the
  server's memory, so a restart doesn't lose it.
- *Ask for approval*: the run waits until one of the people asked approves or rejects it under
  *For review* (and on the row), at most 30 days (30 unless set otherwise). It asks chosen people
  and the people the row's person properties name (up to 20), with a message that can use
  templates; only those who can open the row are asked, and a run with nobody to ask fails
  (`noApprovers`). Each of them is notified (inbox, push and Telegram as they chose) and sees the
  message, the automation, a link to the run (with full access to the database) and what the next
  steps of the version the run started with will do. Approving goes on with the next step;
  rejecting stops the run (`rejected`), the steps after it skipped. Without an answer in time the
  run stops (`timedOut`) or, when set to, goes on. Only the people asked can answer, once; nobody
  can edit it, and the audit log records each answer. It can't go *for each* found row, and a test
  run asks nobody: it says whom it would have asked and goes on.
- *Celebrate with confetti*: confetti in every window of whoever made the change that started the
  run (a still "🎉" note where they asked for reduced motion). Runs nobody started (schedules,
  dates passing, incoming webhooks, anonymous form answers) skip it, as do runs that reach it more
  than two minutes after the change. *Start from a template* has *Celebrate finished rows*, which
  does it when a row is marked done; over MCP the step is `celebrate`.
- *Log*: writes a message into the run's history.

**Templates.** Text in a step, values to set, a request's address, headers and body, and filter
values can use what started the run and what earlier steps gave, as `{{…}}`:

- `{{trigger.…}}` is what started the run. For a row trigger, the row's values by property name
  (`{{trigger.Status}}`, `{{trigger.Due date}}`) and its `id`, `title`, `url`, `event`, `database`,
  `actor` and, for a changed property, `changes.<Property>.before` and `.after`; a date passed run
  has `date` too, and a meeting's `meeting`: its `title`, `summary`, `decisions`, `actions`,
  `attendees` (names), `seconds`, `startedAt`, `endedAt`, `id` and `regenerated` (written up
  again), as AI wrote them when the run started (the transcript isn't in it). For an incoming webhook, the JSON body (`{{trigger.customer.email}}`). For a
  schedule, `event`, `scheduledFor` and `database`. For a total crossing a line, `value` (the
  total that crossed it), `previous` (the total at the check before), `threshold`, `comparison`
  (`above` or `below`), `calculation`, `property`, `view` (`name`, `url`) and `database`:
  "Cash is down to {{trigger.value}}, under {{trigger.threshold}}".
- `{{item.…}}` is the found row a *for each* step is on.
- `{{<step id>.…}}` is what an earlier step gave. Every step has an id (`find`, `http`, `create_2`
  …, or one of your own: lowercase letters, digits and `_`): *Find rows* gives `rows`, `count` and
  `first`; *HTTP request* `status`, `headers` and `body`; *Create a row* and *Update or create a
  row* `id`, `title`, `url` and `created`; *Log* `message`; *Wait* `until`; *Set properties* `id`
  and `values`; *Notify* `notified`; *Run an agent* `agentRunId`; *Ask for approval* `approved`,
  `approved_by` (the person), `answered_at`, and `rejected_by` or `timed_out`; a *for each* step
  `count` and `items`.

Paths use dots, list positions and quotes: `{{find.rows.0.title}}`, `{{http.body.items[0].id}}`,
`{{http.body.customer["e-mail"]}}`. A name is looked up exactly, then without regard to case. In
text a value is written as text (a row or person by its title or name, a list joined with
", "), and a path that leads nowhere is empty text. A value that is a single template and nothing
else keeps its type: a number stays a number in a JSON body, found rows and people give their
ids to relation and person properties, and a path that leads nowhere clears the property it sets.
An empty request address, value to match, or filter value fails the step, so a missing field
doesn't turn into a request to the wrong place or a filter that matches everything. A step that
uses a step that failed or was skipped is skipped (`dependencyFailed`), and a *for each* step
that failed on some rows fails (`rowsFailed`) after doing the others. The app's editor offers the
fields of the trigger (an incoming webhook's example body included) and of earlier steps to pick
from.

**Drafts, test runs and versions.** Changes to an automation's trigger, steps or time zone can
be saved as a draft, which doesn't run, and published when they are ready; a new automation saved
as a draft runs only once published. Each publish makes the next version, and a run does the
steps of the version it started with, so publishing doesn't change runs under way. *Test* runs the
draft (or the published steps, without one) once, now, whether or not the automation is on: on a
row you pick for a row trigger, with an example body for an incoming webhook, as if it came round
for a schedule, and as if the total had just crossed the line, with its value now, for a total. A test run is real: rows change, people are notified, requests are sent. It runs
as whoever started it, shows in the history marked as a test (of the draft, when it was), and
doesn't count as the automation's last run. Turning an automation on or off, or renaming it,
takes effect at once, draft or not.

A database has at most 50 automations, an automation at most 20 steps, a notify step at most 50
chosen people, an approval at most 20, an HTTP request at most 20 headers and a 32,000-character body, and a message,
title or value at most 2000 characters.

**Who it runs as.** An automation acts as the person who last published it (or turned it on or
off, or renamed it), with their access at the time it runs. If they no longer have full access to
the database, its runs fail (`noAccess`) until someone with full access saves it again; a
schedule that can't run says so in the settings. A turned-off automation doesn't run, and runs
for rows that were trashed in the meantime are skipped.

**No chains.** Changes an automation makes, rows it creates included, don't start automations, so
two automations can't set each other off. That holds for "a date passes" and scheduled
automations too: a status they set doesn't start the database's "Status changes" automations.

**When a date passes.** The server looks for rows whose date has come every 10 minutes (set
`AUTOMATION_DATE_CHECK_SECONDS` for another interval, at least 10; one server of several looks at
a time) and queues a run for each, like a row write does. Dates without a time count by the
calendar of the automation's time zone (that of whoever saved it last: the browser's zone when
saved in the app, `time_zone` over MCP, UTC when none was given): a row due on the 11th has
reached its day at midnight there, not at the server's midnight. The automation's summary names
that zone when it isn't yours. Times, and when a row was added or edited, count by the clock. Each
row runs once for each value of its date: it runs again only when that date changes and is past
again, for instance when someone edits a stale row and it goes stale once more. A row restored
from the trash doesn't run again for the same date, and an automation's own edit doesn't count as
an edit. Rows in the trash, row templates, and the rows of a database in the trash are left out.
Rows that already match when the automation is published or turned on run at the next check (the
dialog says how many), at most 100 per automation per check; the rest follow at the checks after.
If its date or status property is deleted, or the person it runs as no longer has full access,
the automation looks for no rows and says why in its settings until the property is restored or
someone saves it again. Changing the date it counts from makes every row new to it; changing the
days or the status condition doesn't.

**When a total crosses a line.** The total is worked out as the person the automation runs as
sees the view's rows: only rows and values they may see count, and filters on today's date count
days in the automation's time zone. It runs once when the total crosses the line, and again only
after the total has come back and crosses it once more: a balance that stays under 50,000 through
ten more entries runs once, not ten times. The total exactly on the line counts as not past it,
and an average of no numbers as no total at all. When the automation is published with another
view, calculation or line, or turned on, it notes where the total stands without running: a total
already past the line then isn't a crossing (the editor shows the total now and says so). The
server looks again a moment after rows of the database are added, changed, moved to the trash or
restored, and every 10 minutes for all of them (`AUTOMATION_DATE_CHECK_SECONDS`, as for dates), for
totals that move with the day or with other databases (a rollup). Changes automations make don't
start a look of their own (see *No chains*); the next round sees them. Only shared views can be
used, since the automation runs as whoever publishes it next. If its view is deleted or made
personal, its number property is deleted, or its person lost full access, it looks at nothing and
says why in its settings.

**Queue.** Runs are queued and done one database at a time in turn, so a bulk edit that starts
thousands of runs in one database doesn't hold back the automations of others. A database's
automations have at most 20,000 runs waiting; a write that would start more starts only the first
ones (the write itself is saved), and the server log says how many were left out.

**Run history.** Each run is kept for 30 days after it finishes, with the version it ran, what
started it (an incoming webhook's body, a schedule's time, a total and the line it crossed) and how each step went: done, failed or
skipped, attempts, an error code and message, a request's HTTP status, how many people were
notified, when it started and how long it took, when a wait goes on, what it was given and what it
gave (with passwords, tokens and keys masked, each cut to 16 KB, an HTTP request's answer to
64 KB) and, for a *for each* step, how it went for each row. Runs on rows you can't open are left
out.

**Not (yet) covered.** A copy of a database, or a template made from one, starts without
automations. The REST API has no automation endpoints; use the app or MCP. Changes that aren't
row writes don't start automations: a relation's other side updated by a two-way relation, and a
property or option being deleted. Values AI autofill writes do, unless an automation's change set
them off: those count as the automation's own changes.

### Webhooks

Each delivery is a `POST` with these headers:

| Header | Value |
| --- | --- |
| `Content-Type` | `application/json` |
| `User-Agent` | `Leafdesk-Webhook/1.0` |
| `X-Leafdesk-Event` | `row.created`, `row.updated`, `row.date_passed` (a date passed), `row.button_clicked`, `row.meeting_summarized` (a meeting on the row was written up), or `ping` for a test delivery |
| `X-Leafdesk-Delivery` | The run id, the same on every retry; use it to ignore duplicates |
| `X-Leafdesk-Signature` | `t=<Unix seconds>,v1=<hex HMAC-SHA256>` (below) |

The body describes the row as the automation's person sees it after the run's earlier actions,
with property values by name in the same form `query_database` returns them. `changed` lists the
names of the properties that changed (all the properties set on a new row), and `actor` is
`null` when an anonymous form answer started the run. A `row.date_passed` run has `changed: []`,
`actor: null`, and `date`: the row's date it ran for (a day, or a UTC time; when the row was added
or last edited, to the microsecond):

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
(`AUTOMATION_WEBHOOK_ALLOWED_HOSTS=n8n:5678,localhost:5678`). Listed hosts skip the address check; a
bare host name is still reached on ports 80, 443, 8080 and 8443 only, so a service on another
port is listed with it (`n8n:5678`).

### HTTP requests

An *HTTP request* step sends one request and waits for its answer:

- **Address.** `https` only, without credentials in it (send them in a header), on the usual web
  ports, every address of its host public, and the connection made to the address that was
  checked. Plain `http`, private networks and local names are allowed only for hosts in
  `AUTOMATION_WEBHOOK_ALLOWED_HOSTS` (above). An address with templates is checked when the step
  runs; to be saved, it must start with `https://` (or `http://`) before the first template.
- **Headers and body.** Up to 20 headers; `Host`, `Content-Length` and the other headers that frame
  the request are the server's. The body is JSON, sent with `POST`, `PUT` and `PATCH` (with
  `Content-Type: application/json` unless you set one); its strings may be templates. The request
  goes out with `User-Agent: Leafdesk-Automation/1.0`.
- **Answer.** It must answer `2xx` within 15 seconds; redirects aren't followed. Up to 64 KB of the
  answer is read: a JSON answer is parsed (`{{http.body.id}}`), anything else is text, and a longer
  answer is cut and marked `truncated`. A failed request keeps the answer in the run history.
- **Retries.** Network errors, timeouts and `502`, `503` and `504` answers are tried again, on the
  same schedule as webhooks and 5 attempts in all; other answers fail at once, since a request may
  not be safe to send twice. The steps after it wait.
- Like webhooks, requests send data out of the workspace: they aren't sent while the workspace's
  owners have export turned off.

### Incoming webhooks

An automation with the *incoming webhook* trigger has a secret address,
`https://<your server>/api/automations/<id>/webhook/<token>`, shown only to people who manage it
(and over MCP to connections that may edit). Anyone with the address can start the automation, so
treat it like a password: *New address* (`new_webhook_address` over MCP) replaces it and the old
one stops working at once. The token is derived from the server's `BETTER_AUTH_SECRET`, so
changing that changes every address.

A `POST` with a JSON body (up to 64 KB; an empty body counts as `{}`) queues a run whose
`{{trigger}}` is that body, and is answered at once:

| Status | When |
| --- | --- |
| `202` | Taken: `{"ok": true, "run_id": "…"}`; `list_automation_runs` or the run history shows how it went |
| `400` | The body isn't JSON |
| `404` | No automation has this address (a wrong or replaced token looks the same) |
| `409` | The automation is off, not yet published, or its database is in the trash |
| `413` | The body is larger than 64 KB |
| `429` | More than 60 requests in a minute (with `Retry-After`), or too many runs waiting |

The automation can keep an example body, which its test runs use and its editor offers fields
from. Bodies are kept in the run history for 30 days with credentials masked.

## Page webhooks

Workspace owners add page webhooks under Settings > Webhooks, or with the REST API
(`/workspaces/{workspace_id}/webhooks` and `/webhooks/{webhook_id}`, scopes `webhooks:read` and
`webhooks:write`; owners only). Each has an `https` address, the events it hears about and the
pages it covers: the whole workspace, one teamspace, or a page and every page under it. A
workspace has up to 25. Database rows and templates are never sent: rows have
[automations](#automations-and-webhooks) for that.

| Event | When |
| --- | --- |
| `page.created` | A page or database is made; sent 5 seconds later, with the body written by then |
| `page.updated` | Its title or body changed; once the page is left alone for 2 minutes (at most 15 after the first change), one delivery for a session of edits, saying what changed |
| `page.moved` | It moved to another page or teamspace; a page webhook hears about it if the page is in its scope before or after, with where it was (`from`) |
| `page.trashed`, `page.restored` | It went to the trash with the pages under it (one event, for that page), or came back |
| `page.deleted` | It was deleted for good; the body has only its `id`, `title` and `kind` |
| `comment.created` | Someone started a comment thread on it or replied in one |

Deliveries are sent like [automation webhooks](#webhooks): the same `User-Agent`,
`X-Leafdesk-Delivery`, `X-Leafdesk-Signature` (each page webhook has its own `whsec_…` secret,
shown in Settings and when it is added over the API, and replaced with *New secret*) and the same
retries, 5 attempts in all, with the event's name in `X-Leafdesk-Event` (`ping` for *Send test*).
Plain `http` is refused unless the host is in `AUTOMATION_WEBHOOK_ALLOWED_HOSTS`; private
addresses are refused as for automations. The body:

```json
{
  "id": "4a1e…",
  "event": "page.updated",
  "created_at": "2026-10-24T09:14:03.512Z",
  "webhook": { "id": "9c3b…", "name": "Docs to search index" },
  "workspace_id": "8a41…",
  "actor": { "id": "u_12…", "name": "Ada Lovelace" },
  "page": {
    "id": "e7f2…",
    "title": "Onboarding",
    "kind": "page",
    "icon": "📘",
    "url": "https://notes.example.com/w/8a41…/p/e7f2…",
    "parent_id": "c3d9…",
    "teamspace_id": "b07a…",
    "in_trash": false,
    "created_at": "2026-09-01T08:00:00.000Z",
    "updated_at": "2026-10-24T09:12:01.000Z",
    "markdown": "# Onboarding\n…"
  },
  "changes": { "title": false, "body": true }
}
```

`page.moved` adds `from: {parent_id, teamspace_id}`, `comment.created` adds `comment: {thread_id,
id, reply, text}`, and the Markdown is cut at 100,000 characters (`markdown_truncated: true`).
`actor` is `null` when nobody did it (the trash emptying itself). A parent the webhook's person
can't open reads `null`.

**Whose eyes.** A page webhook sends as the owner who saved it last (*Sends as* in Settings), and
everything is checked again for each delivery: a page they can't open is skipped (*Not sent* in
the delivery log), and if they are no longer an owner, nothing is sent and the webhook pauses
until another owner saves it, which makes it send as them. While the workspace's export switch is
off (Settings > Security), nothing is sent either. Each webhook keeps a log of its deliveries for
30 days. Deleting the page a webhook covers removes the webhook with it.
