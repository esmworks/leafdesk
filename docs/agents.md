# Agents

[← README](../README.md) · [All documentation](README.md)

An agent is an AI helper of a workspace with a name, an emoji, a description and instructions of
its own. An automation's *Run an agent* action starts it: when the automation runs on a row, the
agent gets its instructions, the action's task, what happened to the row and the row itself, and
works on it. An event a connection receives can start it too (see [Connections](connections.md#connections)),
people who can edit it can ask one for a task of their own over the REST API or MCP, and anyone
it is shared with can chat with it or mention it in a page's comments to have it answer there.

**Its own user.** Each agent acts as a user of its own: a bot user that can't sign in (its address,
`agent-<id>@agents.leafdesk.invalid`, can't receive mail), added to the workspace as a guest. Like
any guest it sees only the pages shared with it, never through teamspaces, groups or "everyone",
and its changes, comments and page history show its name. It never gets full access, so it can't
share pages or manage databases.

**Sharing pages with it.** Share a page with an agent at view, comment or edit, as with a person:
from the agent's settings, or from the page's Share menu, where agents are found by name (added at
view) and marked as agents. The pages and rows under it follow. Sharing needs full access to the
page. An agent reads and changes a database's rows only with access to the database; saving an
automation that runs an agent shares that database with it at edit access, unless it already has
that much. That access is taken back once no automation of the database runs the agent (a level
you set yourself, in the agent's settings or the Share menu, stays).

**What a run may do.** Search and read what is shared with the agent, query its databases, and
change or comment on the row that started the run (its values, or its text block by block with
`edit_page`), or propose those changes for review and draft an email there (below), nothing
else. When a member's change started
the run, the agent is also held to what that member may: it opens, reads and changes only the pages
and property values both of them can, so a run never hands someone what they couldn't open
themselves. When an answer to a public form started it and no member stands behind the answer
(it was anonymous, or came from someone outside the workspace), the agent is held the same way to
what the member who published the form may; if they have left the workspace, the run ends as
`noAccess`. Bear in mind that whoever answers may be able to read the row afterwards: the publisher's
access is the bound, not the answerer's. A run takes at most 8 model turns,
makes at most 5 changes and comments, and lasts at most 2 minutes. Runs are queued and done a few at
a time (`AI_CONCURRENCY`), each turn within the workspace's AI allowance
(`AI_WORKSPACE_RATE_LIMIT`): a run waits for its turn rather than failing. Each run is kept for
30 days after it finishes, with what the agent did step by step, its final answer, the tokens it
used, and why it failed (`aiOff`, `agentDisabled`, `noAccess`, `rowGone`, `commentGone`, `provider`, `timeout`,
`tooManyAttempts`, `limitReached` or `error`).

**Changes for review.** An agent's *Changes to rows* is *Write them directly* (the default) or
*Propose them for review*: then the rows its runs would add and the values or titles they would
change are kept, each with the agent's reason, on the *For review* page in the sidebar (filtered by
agent, database or row), with every value as it was, is now and would become. Anyone who may edit
the row and the values it sets approves a change (as themselves, after editing it if they like) or
dismisses it, one at a time or several; a row changed since in a value the proposal sets needs
*Approve anyway*. The person the run worked for hears of new proposals in their inbox, and
unanswered ones expire after 30 days. Chats with an agent still write directly; the *Request
answerer* template proposes. An agent's email drafts wait there too (see
[Email on rows](email-on-rows.md#email-on-rows)). Over MCP: `list_pending_changes` and
`answer_pending_change`; over the REST API, `/pending-changes`.

**Runs people ask for.** An owner, or anyone who can edit the agent, can ask it to do a task now, over the REST API
(`POST /api/v1/agents/{id}/runs`) or MCP (`start_agent_run`), with a task of up to 2000
characters, on a database row or on none. The run is queued like any other and held to the asking
owner's access as well as the agent's, as a run a member's change started is held to that
member's: it reads only what both can open. On a row it may change and comment on that row; on
none it only reads (and uses its connections' tools) and its answer is what it found or did. The
run shows who asked, from where and the task; read how it went with
`GET /api/v1/agents/{id}/runs/{run_id}` or `list_agent_runs`. Asking is refused, not queued, while
the agent is paused or archived, AI is off for the workspace, the agent used its monthly token
limit, or 5 runs asked of it still wait. Each request is recorded in the audit log.

**Its model.** Where the server has a fast model (`AI_FAST_MODEL`, see [AI features](ai.md#ai-features)),
the agent's settings let an owner choose which model its runs use, both named: the main model
(`AI_MODEL`, the default), for work that needs judgment, or the fast one, cheaper, for routine,
well-defined jobs such as summaries or sorting rows. Every turn of every run of the agent's, however
it started, goes to that model, with the same tools and limits; on the fast model it thinks a
little (low effort). The choice isn't shown, and a fast agent runs on the main model, where the
server has no fast model or the workspace's AI is an own AI account (which has one model). Each
run records the model that answered it, shown in the *Runs* tab, and the workspace's AI usage
counts its turns under that model. MCP's `create_agent` and `update_agent` and the REST API's
`PATCH /api/v1/agents/{id}` take `model` (`main` or `fast`).

**Web access.** An agent reads nothing outside the workspace unless an owner turns on *Web access*
in its settings (over MCP and the REST API, `web_access`). Its runs then get `read_web_page`: the
server fetches a public http(s) page and the agent reads its title and main text (markup, scripts
and navigation left out, at most 20,000 characters, followed by the links on it), or plain text and
JSON as they are; images, PDFs and other files are refused. Pages are fetched as files attached by
URL are: only on the web's usual ports (80, 443, 8080, 8443), never from a host with an address that
isn't public (loopback, private networks, link-local and cloud metadata addresses), checked when
connecting and again on each of up to 5 redirects, within 15 seconds and 20 MB (of which 2 MB are
read). Where the server has a search service (`WEB_SEARCH_URL`, see [AI features](ai.md#ai-features)),
runs also get `search_web`, with up to 8 results (title, address and snippet); without one, the
agent reads the pages whose links it is given or finds in the workspace. What comes back reaches
the model framed as data from outside Leafdesk, and the agent is told that instructions on a web
page are never its owners'. Each page read and search shows in the run's steps with its address or
query. It changes nothing, so it isn't one of the run's changes, but it counts with connections'
tools toward the 40,000 characters a run may read from outside. A run no member stands behind (an
anonymous or outside form answer, an event from a trigger no owner marked trusted) asks an owner
before each call, as it does before each connection tool: otherwise what it read could be sent to
an address a stranger chose. A run someone asked for in words (a chat message, a mention, a
request) reads what that person may open, some of it written by others, so it asks an owner before
each page read whose address isn't in the message (as written, or without its `?query` and
`#fragment`) and each search whose words aren't, as they stand, in the message; a helper's run for
such a run asks before every call. Where no owner can answer (the chat or request of someone who
isn't an owner of the workspace), such a call is refused at once and nothing is sent. A schedule's
run, which no one watches, asks no one: it searches freely (the words reach only the server's search
service) and reads pages whose address is in the schedule's task or among the results of its own
searches; any other page read is refused at once, nothing is sent, and the run's steps show the
address it didn't read. A helper's run for a schedule's run reads only its searches' results. Over a
database with rows no member stands behind, each call still waits for an owner. Leave web access
off for agents that only work with the workspace.

**Mentioning an agent in a comment.** Typing `@` in a page's comments offers, below the people,
the agents that may comment on the page (shared with them at comment or edit), marked with their
icon; agents that may only view it, paused and archived agents aren't offered. When a member posts
a comment that mentions one, in a new thread or as a reply, the agent runs: it reads the comment
(its task), the thread before it (its last 20 comments, oldest first) and the page, and answers
with a reply in the same thread, as itself, which notifies the thread's people like any reply. The
run is held to that member's access as well as the agent's, as a run a member's change started is;
it may change the page the comment is on (and its values, on a database row) only when both may
edit it, and nothing else, with the connections' tools under the usual approval rules. It proposes
no notes. When it can't answer (the agent used its monthly tokens, the workspace's AI is off or
reached its cost limit, the agent was paused, the run took too long or failed) it says so in the
thread instead. An agent mentioned twice in one comment runs once; editing a comment to add a
mention starts no run, nor does a guest's comment (guests aren't offered agents, and a mention
they paste stays as the agent's name) or an agent's own reply, so agents can't set each other off.
Its runs show who mentioned it and on which page (`mention` in `list_agent_runs` and the REST API),
and end as `commentGone` when the comment or its page is gone by then; what they did shows to the
owners who can open the page.

**Chatting with an agent.** Anyone the agent is shared with chats with it in its *Chat* tab, or
in a page's **Agent chat** block (the slash menu's
*Agent chat*, or paste a link to the agent's settings, as the *Chat* tab copies it, alone on an
empty line). Each message the agent answers is one of its runs (shown in its *Runs* tab as a chat
message, counted in its usage and held to its monthly limit), with the agent's instructions, skills
and kept notes, and the conversation's 20 earlier messages. The agent doesn't read the page the
block is on unless asked to. What it may do depends on who writes:

- **Someone who can edit it** (owners included) gets what a run they ask for gets, held to their
  access as well as the agent's: it searches and reads what both can open, proposes notes, and
  creates and changes pages and rows both can edit, at most 5 changes a message, made at once. It
  uses its connections' tools; those that change something wait for an owner's approval, which the
  chat asks an owner for in place, so they are offered only in an owner's chat.
- **Someone who can view and interact** chats read-only: *answers come only from pages you can both
  see*. The agent reads only the pages both it and that person can open, changes nothing, proposes
  no notes and calls only its connections' tools that read.

Guests, people the agent isn't shared with, and readers of a published page, see that the chat
isn't available to them. Each person's
conversations are their own, per block (a copy of the block, on a duplicated page or one made from a
template, shows the same ones) or in the *Chat* tab: nobody else sees them, owners included, and the agent's run history
shows another person's chat messages without what was said. The 20 most recent conversations are
kept per person and place; **New conversation** starts another and each can be deleted. A message
has at most 4000 characters; the agent answers one at a time per conversation, within the
workspace's AI allowance. A paused or archived agent, AI turned off, or an agent past its monthly
limit leaves the chat saying so. Exported Markdown and HTML show the block as a line naming the
agent, never what was said.

**Usage and a monthly limit.** Every turn a run takes with the model is added to the agent's usage
for the calendar month (UTC): its runs, input and output tokens and cost (the cost stays 0 where the
AI provider names no price). The agent's *Runs* tab shows this month against its limit, and the
months before; MCP's `get_agent` and the REST API's `GET /api/v1/agents/{id}/usage` show them too.
Twelve months are kept. In the agent's settings an owner can set a monthly token limit (input and
output together): once the month's tokens reach it, a run under way stops at its next turn
(`limitReached`, counting what it used) and no run starts until the next month or until the limit
is raised. Several runs of one agent under way at once can each take one more turn past it. The
limit counts tokens rather than money because not every provider reports a price.

**Skills.** In the agent's *Skills* tab, owners give it up to 10 [skills](ai.md#skills) of the
workspace that they can open; each run sends their instructions to the model after the agent's
own, in the order they were given, as part of its orders. Because a skill's body becomes the
agent's orders, an agent may only have skills that no one besides the workspace's owners can
edit: not a member, a teamspace, a group, a guest or an agent (the agent itself included). Giving
one that others can edit is refused, and every run checks again: a skill someone else can edit by
then, or that is no longer a skill (unmarked, in the trash), is left out, and the run says so in
its steps, as the tab does next to the skill. A skill that doesn't fit in what a run may read
(12,000 characters for all of them together, at most a quarter of `AI_MAX_INPUT_CHARS` when set) is left
out whole, never cut. A run held to someone's access (the member whose change started it, or a
public form's publisher) also leaves out the skills that person can't open, as it does pages;
sharing a skill with members at *Can view* lets their runs follow it and keeps it a skill only
owners can edit. A run that goes on after an approval checks its skills again and says which ones
it now leaves out or were taken away. Owners who can't open a skill another owner gave see it only
counted, and unnamed in runs. Giving and taking skills is recorded in the audit log as a change to the agent.
Like anything shared with the agent, what a skill says can end up in the rows it writes.

**Memory.** An agent keeps short notes that go with each of its runs, so it needn't learn the same
things again (where things go in the workspace, which database holds what, how a recurring case is
handled). Nobody talks to an agent during a run: everything it reads was written by someone else (the
row, pages, an event, what a connected service returns), so a note it kept on its own could carry
anyone's orders into every later run. A run therefore only *proposes* notes, with a `remember` tool:
each proposal is a step of the run, with credentials masked, and goes with no run until an owner
keeps it. In the agent's *Memory* tab (and a "notes to review" link next to the agent in the list),
owners see the proposals with the run's row and time, keep one as it is or changed, or dismiss it;
they also write, change and delete notes, and make it forget everything. An owner who can't open a
proposal's row doesn't see its text (it may quote the row) and can only dismiss it, nor does one
whose proposal came from a run another owner asked for or scheduled without a database. A run may drop a
note at once with `forget`, which loses at most that note. Runs no member stands behind (an
anonymous or outside form answer, an event from a trigger no owner marked trusted) get neither
tool, but the kept notes go with them too. Kept notes reach the model as data, never as
instructions, and never widen what the agent may change; like its instructions, what they say may
end up in the rows it writes, whoever started the run. An agent keeps up to 30 notes of 300
characters; up to 10 proposals wait at once, and one no owner answered goes when its run is
removed after 30 days. Archived agents keep their notes: owners can still delete them, or dismiss
proposals, but not add, change or keep notes until the agent is restored. With the workspace's *AI memory* switch off
(Settings → General → AI), no run carries notes or proposes any; the notes stay. Keeping, dismissing, writing, changing and deleting notes is recorded in the audit log as
a change to the agent, counted, without the notes' text. MCP's `get_agent` lists the kept notes and
the proposals.

When a run proposes a note, each owner of the workspace gets one inbox item for that run (and a
push notification, without the note's text), whatever their notification choices, and no email.
It shows the first proposal's text, unless the run was on a row that owner can't open, and how
many more the run proposed; opening it opens the agent's *Memory* tab. It can be snoozed, and goes
away once every proposal of the run has been kept or dismissed (or dropped by a later run). Over
MCP, owners keep and dismiss proposals, and write, change and delete notes, with
`change_agent_memory`; `list_notifications` shows the inbox item with the agent's and run's ids.

**Handing off.** In an agent's settings, owners tick up to 10 other agents of the workspace under
*Agents it can ask*. Its runs then get an `ask_agent` tool: the run names one of them, the task (with
everything the other agent needs, since it sees nothing else of the run) and what to send back,
waits, and reads the answer as data from another agent, never as instructions. The helper does its
part in a run of its own, with its own access, tools, skills, notes, instructions and limits, and
its tokens count against it, not the agent that asked. A helper's run changes no pages (it reads,
uses its connections' tools and answers), proposes no notes, and never asks further agents. It is
held to whose access holds the asking run (the member whose change started it, the owner who asked
for it), and when no one stands behind what the asking run read (an anonymous form answer, an
untrusted trigger's event), each of its connection calls waits for an owner as well. Who sees what
it did is who sees the asking run. A run asks at most 3 times; its own time stands still while it
waits, for up to 4 minutes of waiting in all (so a 2-minute run lasts at most 6). A helper that is
paused, archived or over its monthly token limit isn't run: the asking run hears why and goes on
without it, as it does when a helper waits for an owner's approval or isn't done in time (its run
finishes on its own). The asking run's history shows "Asked *agent*: *task*", opening the helper's
run, and the helper's shows who asked it, opening the asking run. The helper runs in the asking
run's slot of the worker, so even `AI_CONCURRENCY=1` never waits on itself. Archiving an agent takes
it off every list. Each helper uses its own run settings, its model included: where agents can
choose between the main and the fast model, give the agent that plans the job and weighs the
answers the main one, and helpers that do narrow, well-described parts (look something up, sum up
a database) the fast one. Over MCP, `create_agent` and `update_agent` take `helper_agent_ids`, and
`get_agent` and `list_agents` return it; the REST API's agent endpoints do too.

**AI must be on.** Agents use the chat model: the server needs an AI provider (see
[AI features](ai.md#ai-features)) and the workspace must have AI on. Otherwise runs end as `aiOff`.

**No chains.** Changes and comments an agent makes don't start automations, so agents and
automations can't set each other off.

**Sharing an agent.** Each agent has its own list of who may use it, under **Share** in its
settings: people, groups, and everyone in the workspace (owners and members; never guests), each
at one of three levels. *Full access* can do everything an owner can with the agent, sharing and
archiving it too. *Can edit* changes its settings, instructions, pages, skills, schedules, memory
and versions, asks it for runs and adds it to automations, but doesn't share or archive it. *Can
view & interact* sees the agent and all its tabs read-only, sees only the runs they started
themselves, chats with it and mentions it in comments. A person's own entry decides for them;
without one, the highest of their groups'; without those, everyone's; with none of them, the agent
isn't theirs to see, chat with or mention. Owners of the workspace always have full access. A new
agent is shared with everyone at *Can view & interact* and with whoever created it at full access,
and agents made before sharing existed were set up the same way. Its connections' tools and its
monthly token limit stay with owners (others see them read-only), and so do the approvals its
runs wait for. Each change to the list is recorded in the audit log; the agent's versions don't
keep it. Over MCP, `share_agent` changes the list and `get_agent` shows it, with the user's own
access (`your_access`, also in `list_agents`).

**Who creates agents.** Settings → *Agents* → *Who can create agents* lets owners keep creating
agents to themselves (the default) or let every member create them, from scratch, from a template
or from a description. A member who creates one gets full access to it.

**Managing agents.** In Settings → *Agents*, everyone who isn't a guest sees the agents shared
with them and opens each at their level: owners, and those with access enough, change, pause,
archive and restore agents, choose what is shared with them and look through their runs. A run's steps, answer and error, and a call it waits
on, show only to owners who can open its row (for a schedule on a database, the database), and
only they answer that call. A run an owner asked for, or one a schedule without a database
started, read with that owner's access: only they see what it did, its task and the notes it
proposed, and only they answer its calls; the others see that it ran and how it ended. Where an agent acted, it shows as an agent: its icon in *Created by* and
*Last edited by*, "(agent)" after its name on comments and in page history. A comment an agent
writes about the whole row rather than about some of its text says *About this page* in the
comments panel, at the top of the list. A
workspace has at most 50 agents. A paused agent doesn't run: its queued runs end as
`agentDisabled`. Archiving one also unshares every page shared with it (each recorded in the audit
log as a removed permission) and takes it off the lists;
its user stays, so what it did keeps its name. A restored agent comes back paused, with nothing
shared; its skills and memory stay. Creating, changing and archiving agents is recorded in the audit log. Over MCP:
`list_agents`, `get_agent`, `draft_agent`, `create_agent`, `update_agent`, `set_agent_archived`,
`set_agent_access`, `set_agent_skill`, `change_agent_memory`, `set_agent_schedule`, `list_agent_runs`,
`list_agent_versions`, `restore_agent_version` and `start_agent_run`. Over the REST API: listing, reading and changing agents (pausing, resuming, web access, the
monthly limit, `row_changes`), asking for a run, and reading runs and usage (see [REST API](rest-api.md#rest-api)).

**History.** Each saved change to an agent's setup keeps a version: its settings (name, icon,
description, instructions, active or paused, monthly limit, and any setting added later), its
skills in their order, its schedules and the pages shared with it (from its settings or a page's
Share menu; not the databases automations share with it). Changes one person saves within two
minutes of each other make one version, and the last 50 versions are kept. The agent's *History*
tab lists them, with who saved each, when and what changed; opening one shows what changed from it
to the current setup, the instructions line by line. Owners can **Restore this version**: settings,
skills, schedules and shared pages go back to how they were, through the same checks as changing
them by hand, and what can't come back is skipped and listed (a page deleted or in the trash since,
one you lack full access to, a skill others may edit by now, a setting no longer valid). Runs,
memory and usage aren't part of a version. A restore makes a version of its own, so it can be undone
the same way, and is recorded in the audit log; an archived agent is restored first. Agents made
before history began start with their setup at that time as version 1. Versions go with workspace
backups. Over MCP: `list_agent_versions` and `restore_agent_version`.

> [!WARNING]
> Anything shared with an agent can end up in the rows it writes: a value it copies, a summary in
> a comment. Everyone who can open those rows sees it, even when they can't open the page it came
> from. Share with an agent only what everyone who sees its database may see.

**Describing an agent.** Where AI is on, Settings → *Agents* → *Describe an agent* takes what the
agent should do in your own words ("Every Monday, summarize last week's new rows in Tasks and
comment the summary on the Weekly page") and has the AI draft it: a name, a description, step-by-step
instructions in the language you wrote in, the pages and databases it needs (only ones you have full
access to, each at the least access that does the job) and when it runs: a schedule, and
automations on a database (a row added, a form answer included; a property changed; a date passed).
Nothing is saved: the draft opens the usual form filled in, with the pages it would share and the
schedules and automations it would set up listed apart, each with a way to remove it. Creating the
agent shares those pages and sets up what is left; when one step fails, nothing of it stays (the
agent is archived). Only those who may create agents can draft, the request counts as the agents' AI usage, and MCP's
`draft_agent` returns the same draft without saving it.

**Built-in agents.** Settings → *Agents* → *Start from a template* sets one up on a database in one
step: it creates the agent with instructions in your language that name the properties you pick
(creating a property or option when you ask), shares the pages it reads at view, and adds the
automation that runs it on every new row (the wins logger, a trigger on a connection instead).

- **Ticket router** sets the select, status or person properties you pick by rules you write, and
  says why in a comment.
- **Request answerer** looks for the answer in the pages you pick, writes it as a comment with its
  sources, and sets a select or status to "answered" or "needs a person".
- **Duplicate finder** looks for similar rows in the same database and, when it finds some, names
  them in a comment and ticks a checkbox.
- **Company researcher** looks each new company up on the web (it gets web access) and fills the
  properties you pick that are still empty (website, sector, address, phone…), following their
  descriptions, never overwriting a value, and comments its sources on the row.
- **Wins logger** reads each event a connection you pick receives (a Slack message, a GitHub pull
  request, a CRM deal or an email sent through a signed webhook) and, when it is a win or praise,
  adds a row to a wins log (the *Wins log* template makes one), filling the log's own properties as
  far as the event tells. Its setup picks the log, the connection and the event type, and lists
  which of the log's properties it fills; each row waits for an owner's approval. A workspace
  without a connection has to add one first.
