# AI features

[← README](../README.md) · [All documentation](README.md)

Contents: [AI features](#ai-features), [Skills](#skills), [Snippets](#snippets).

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
AI_MODEL=claude-haiku-5-5
AI_API_KEY=sk-ant-...

# or a local model
AI_PROVIDER=ollama
AI_MODEL=llama3.2
```

For Anthropic, OpenAI and Google, Leafdesk knows the current models (`claude-haiku-5-5`,
`claude-sonnet-5-5`, `claude-opus-5-5`…) and uses their context window, prices and thinking
settings. A model id it doesn't know yet still works: it is sent as written, with a 128,000-token
context window, no thinking settings, and a cost of 0 in the server log.

**OpenCode Go** serves its models over four APIs; Leafdesk picks the right one for each model in
its catalog (`kimi-k3`, `glm-5.3`, `deepseek-v4-pro`, `qwen3.8-flash`, `minimax-m3`, `grok-4.7`…;
the ids as in OpenCode's model list, without `opencode-go/`), with its real context window. A model
id the catalog doesn't know yet is sent to the chat completions API with `AI_CONTEXT_WINDOW`. As Go
asks of its clients, requests name Leafdesk in their user agent and carry an `x-opencode-session`
header: the conversation's id in the chat, a new id for every other request. Go's plans have
monthly, weekly and five-hour spending limits, which AI properties updating many rows can use up.

In Docker, a model running on the host is at `AI_BASE_URL=http://host.docker.internal:11434/v1`
(Ollama) or `http://host.docker.internal:1234/v1` (LM Studio). The server log says which provider
and model it uses at startup (never the key), and Settings → General → AI shows them.

**A fast model for simple jobs.** `AI_FAST_MODEL` names a second, cheaper model at the same
provider, with the same key and endpoint. It takes the short jobs that run often and need no
careful reasoning; everything else stays on `AI_MODEL`. Unset (or the same as `AI_MODEL`),
`AI_MODEL` answers everything. For example, a strong model for chat and agents and a small one
for property values:

```bash
AI_PROVIDER=anthropic
AI_MODEL=claude-opus-5-5
AI_FAST_MODEL=claude-haiku-5-5
```

Each feature also tells a model that thinks before answering (Claude 5.5, OpenAI's and Gemini's
reasoning models) how much to think; a model that can't think as little as asked thinks as little
as it can (Claude Sonnet and Opus 5.5 can't stop thinking, so "off" is low effort for them).

| Feature | Model | Thinking |
| --- | --- | --- |
| AI property values | `AI_FAST_MODEL` | off |
| Voice notes: writing up the transcript | `AI_FAST_MODEL` | low |
| Meeting notes: summary, decisions and action items | `AI_MODEL` | low |
| Writing assistant: improve, fix, shorten, translate, continue, summarize | `AI_MODEL` | low |
| Writing assistant: your own instruction | `AI_MODEL` | medium |
| Chat | `AI_MODEL` (or the model picked, see `AI_CHAT_MODELS`) | medium |
| Chat in research mode | `AI_MODEL` (or the model picked) | the model's default |
| Writing a formula from a description (*Describe it*) | `AI_MODEL` | low |
| Drafting an agent from a description | `AI_MODEL` | medium |
| Building databases from a description | `AI_MODEL` | medium |
| Agents | `AI_MODEL` | the model's default (Claude 5.5: high) |
| Agents set to the fast model | `AI_FAST_MODEL` | low |

The writing assistant stays on `AI_MODEL`: it makes one request per click and its text goes straight
into a page. Agents run on `AI_MODEL` unless an owner puts one on the fast model, for routine,
well-defined jobs (see [Agents](agents.md#agents)); without `AI_FAST_MODEL` such an agent runs on `AI_MODEL`
like any other. Semantic search and the speech-to-text step of voice notes use their own models
(`AI_EMBEDDINGS_MODEL`, `STT_MODEL`). The server log names the model of every request.

**Writing assistant.** Select text and choose *Ask AI* in the formatting toolbar, or type `/` and
pick *Ask AI*, *Continue writing* or *Summarize page*. On a selection: improve writing, fix
spelling and grammar, make shorter, translate (choose the language), or type your own
instruction. An instruction you use often can be saved with the bookmark next to *Send*: your saved
prompts (up to 50 per workspace, yours alone; instructions for the whole team are skills) are listed
under the actions to run, rename or delete. The answer streams into a panel; *Replace selection* or *Insert below* adds it to the
page, *Try again* asks again and *Discard* (or Escape) drops it. *Stop* cancels the request. Before
a suggestion is added, the page's current version is saved in its history ("Before AI assistant
edit"), and the change is an ordinary edit everyone sees live, which Undo takes back. Only people
who may edit a page can use it there.

**Building databases with AI.** *Build with AI* in the sidebar's *+* menus, on the home page, in
Cmd+K (`>`) and as `/` *Build databases with AI* in a page opens a box to describe what you want
to keep track of ("a hiring pipeline: candidates, their interviews and who interviews whom"). The
AI drafts a plan of up to four databases: their properties with types, select options with
colors, statuses with their groups, relations between the databases (one or both ways), up to six
views each (tables, boards by a select or status, calendars and timelines by a date, galleries,
lists, with filters and sorts), a few example rows and, from the menus, a page about them that
holds them. The plan is checked against the property and view types Leafdesk has; one that doesn't
pass goes back to the AI once with what is wrong. You then see it and rename or remove databases,
properties and views, and leave out the example rows or the page, before *Create* makes it as you,
where you opened the box (in a page: under it, with a database block for each). Everything is made
or nothing is: a step that fails takes back what came before it. The AI chat's `create_database`
(one database with its properties) goes through the same check and creation. It counts as *Other*
in Settings > AI usage and is held to the workspace's AI limits.

**AI properties.** In a database, *+* → *AI autofill* adds a text property that AI fills in; any
text property's menu has *AI autofill…* too. It can write a summary of each row's page, a
translation of the row's name, page content or another property, or follow your own prompt, where
`{Property name}` stands for that property's value of the row and `{title}` for its name
(optionally with the row's page content). Values are ordinary text: filters, sorting, CSV export,
the REST API and MCP see them like any other text, and people can still edit them. They are worked
out in the background, when the property is added, when you hover a cell and click *Update with
AI* (or on a row's page), with *Update all rows in this view* in the property's menu, and, if you
tick *Update when the row changes*, a few seconds after a row's values or page change (only when
what the value depends on changed). A new value counts as a change of the row: it shows in the
row's activity, semantic search finds it, and automations waiting for the property to change run.
Other AI properties (and formulas over them) go into a prompt only when you name them, as a
`{Property name}` or the property to translate; the AI properties that do then update after it.
A property can't read itself through other AI properties. Cells show when a value is being worked
out or failed, and why. Turning AI autofill off leaves the values as plain text.

Select, multi-select, status, number and checkbox properties have *AI autofill…* in their menu
too, filled in from your own prompt (summaries and translations are text). The prompt tells the
model what the value must be: one of the property's options, written as listed, or none; a JSON
list of options (never new ones); a number (for a percent number, a percentage, stored as the
fraction it shows); yes or no. The answer is read the way people write such values, so a full
stop, quotes or another case don't matter, and "none" leaves the value empty. An answer that
doesn't fit (an option the property doesn't have, words where a number was asked for) fails
like any other, and the cell keeps the value it had. The values are ordinary ones: filters,
grouping, boards and automations ("Status changes to Done") work with them as they do with
values people set.

*Only rows where these have a value* limits any AI property to rows where the chosen properties
(up to 10) aren't empty, or, for a checkbox, are ticked: "find the sector only for customers with
a website". Other rows are skipped without asking a model, also by *Update all rows in this
view*, and keep the value they have. A property chosen there is read like a `{Property}` in the
prompt, so an AI property can wait for another one and updates after it; related rows, people,
restricted properties and properties the person can't see can't be chosen and count as empty.

**AI chat.** The sidebar's *Chat* tab opens the chat across the page and lists your
conversations (today, yesterday, the last 7 and 30 days, older) under a new chat. The chat button
(the tab's two bubbles) in a page's header opens the chat in a panel beside the page, which stays
open as you move between pages and can be expanded to the full page. A source clicked in the full
page (a citation or a page it read) opens in a panel at its right, scrolled to the passage; K and J
go through the conversation's other sources and Esc closes it (a database, or any source on a phone,
opens as its page). Where the workspace can transcribe recordings (as for voice notes), a microphone
in the box dictates a question into it, unsent, to fix first; the recording isn't kept. A question
sent while an answer is being written waits in a strip above the box and is asked once the answer
is done (*Stop* gives the waiting questions back), and while the model thinks the line saying so
shows the newest line of its thinking. Questions are answered from the pages
you can read. Nothing is searched for the model: each question goes to it with a map of what you
can open (the databases with their properties, types and options, statuses by group, and the
pages, up to 8,000 characters), and the model decides what to look at. It can search
(`search_pages`, full-text and, with embeddings, by meaning), read a whole page (`read_page`; a
database reads as its properties and its first 200 rows with their values) and list the rows of a
database that match filters on its properties (`query_database`, the same filters and sorts as
the MCP tool, each row a source to cite), up to six turns per question; greetings are answered
without tools. A database row found by a search comes with its database and its values (those the
person may see). The chat's full-text search finds pages with any of the search's words (as
prefixes, so "ekstreleri" finds "ekstresi"; question words such as "what" or "nedir" left out;
Japanese and Chinese questions by their words without particles and function words, Korean
ones without a particle at the end of a word), titles first, where the search box wants all of them. Each page found comes with its passage
that has the most of the search's words (from the semantic index, else cut from the page's text
the same way), not just a line around the first of them. While an answer is written, the steps it
takes are listed above it (searches with how many pages they found, pages read, databases
queried, what the model says before them) with a running clock, then folded into how long it took; they are kept with the
conversation. Answers cite their sources as numbered
links to the page, and to the block the passage starts at when it is known. *Answer from* → *This
page and its subpages* keeps questions to the page you are on, and picking one of your teamspaces
(in the panel and the full-page chat) keeps them to that teamspace's pages: search, semantic
search, reading pages and comments, querying databases and the workspace map the model gets all
keep to it on the server, with your access checked as always. Each question shows what it was
asked of, by the page's or teamspace's name as you may see it now. *Stop* ends an answer; what was written so far
is kept. Under an answer are *Copy*, *Answer again* (the latest) and its time; hovering a question
shows its time, *Edit* (the latest: answered again in its place) and *Copy*. An answer that
changed things can't be answered again or edited. Conversations are private to you and listed in the sidebar's *Chat* tab and under
the panel's *Conversations*, where you can delete one, several (tick them, shift-click for a range,
or *Select all*) or all; up to 50 per workspace are kept (the oldest go first), with
no limit on questions, each as long as the model's context window takes (a paste of 3 lines or more, or more than 150 characters, shows in the box as a chip like *Pasted 40 lines*, one piece that Backspace takes whole, and is sent in full). The chat sends the model as much of the
conversation as its context window takes (see `AI_MAX_INPUT_CHARS`); when the model still finds it
too long, older tool results and then the earlier turns are left out and the question is asked
again. They are deleted when you leave the workspace or delete your account. The
chat is off while offline and when AI is off for the workspace. Every question counts against
`AI_RATE_LIMIT`; the model's extra turns count against `AI_WORKSPACE_RATE_LIMIT`.

**Changes from the chat.** The chat can add a database row (`create_row`, with its values and
text), change a row's values or title (`update_row`), add a page under a page, or a private one
at the top of the workspace (`create_page`), and change a page's or row's text block by block
(`edit_page`: replace a block, insert after one, append or delete one, by the block ids it reads
first), make a PDF file of a page or row (`create_pdf`, see [PDF](export.md#pdf)), and add a form view
with its questions to a database (`create_form`, its public link when asked and allowed), as you
and only where you may edit (and, with *Answer from* a page or teamspace, only in it). It reads a
page's comment threads (`list_comments`) and saved versions (`page_history`, `page_version`), and
comments or replies as you where you may comment (`add_comment`). What it may do is picked under the
question box and remembered in the browser: *Ask* (the default) shows each change in the box's place
before it is made (what, where, a new row's values and the start of a new page's text; for a change
to a page's text the blocks it changes, adds and removes; for a changed row each property's old
value next to the new one, and the old title when it is renamed) with *Yes*, *Yes, and don't ask
again* (the mode becomes *Auto*) and *No*, also as 1, 2, 3 on the keyboard (Escape says no); *Auto*
makes changes without asking; *Read only* doesn't offer the model changes at all. A change is
checked (the target, your edit access, the values) before you are asked; nothing is written while it
waits, and stopping the answer, leaving the page or 15 minutes without an answer leave it unmade.
Changes made, declined or failed show among the answer's steps with links, are kept with the
conversation (also when the answer itself didn't come), and later questions know them.

**Connections' tools.** Tools of a [connection](connections.md#connections) an owner ticked *In chat* are
offered to members' chats (never guests'). Reading tools run at once and show as a step; a tool
that changes something at the service asks before every call, in *Auto* too, and isn't offered in
*Read only*. What the service returns reaches the model as outside data, and the audit log
records each call as the person's.

**Files in the chat.** The paperclip under the question box attaches files to a question, and so
does dropping them on the box or pasting them: images (PNG, JPEG, GIF, WebP), PDF, Word and Excel
documents, CSV, Markdown and text files, up to 5 per question, 20 MB each (images 5 MB). Each is
uploaded as it is attached and shows as a chip with its name and size (a CSV file's rows and
columns), in the box and then on the question, where it opens the file. A question may be only
files. Documents are read to text the way search reads them (the first 50 pages or 200,000
characters), CSV files as tables (up to 1,000 rows and 100 columns, refused with a message
beyond), and the files stay with the conversation: every later question sends them again, newest
first and cut to fit, and the model reads on in one with `read_attachment` and can make a
database of a CSV file (`create_database_from_csv`, its columns' types guessed from the values).
Images go to the model as images, with their own question only, where the model takes them (the
catalog says so for the models it knows; `AI_IMAGE_INPUT=true` says it for others); otherwise the
box says so and nothing is sent. What a file says is data for the model, never instructions.
Attached files count against the workspace's storage, are stored apart from its pages (only the
person who attached them can open them, and backups and exports leave them out), and are deleted
with their conversation; one attached but never sent goes after a day.

**Picking the model.** `AI_CHAT_MODELS` lists more models at the same provider (same key and
endpoint), comma-separated, that the chat's box offers next to `AI_MODEL` and `AI_FAST_MODEL`.
Where there is more than one, a model picker sits under the box: a conversation keeps the model it
was last asked with, and a new one starts with the model of your latest. Usage and cost are counted
per model (see *Usage and cost limits*). A workspace on its own AI account answers with that
account's model, without a picker.

```bash
AI_MODEL=claude-sonnet-5-5
AI_FAST_MODEL=claude-haiku-5-5
AI_CHAT_MODELS=claude-opus-5-5
```

**Research.** The telescope button under the box turns on research mode for the questions that
follow. The model first plans the sub-questions that together answer the question (shown as a
step), then searches the workspace (full text and by meaning, as you), reads the best pages and
databases, reads attached files and, where web search is on, searches the web and reads the best
results, and finally writes a long report in Markdown with a summary, a section per sub-question
and what remains open, citing every source by number (web sources as links). It only reads:
nothing is changed, no note is kept and no other service is called, whatever the mode under the
box. It takes up to 14 turns and 400,000 tokens (each turn also counts against the rate and cost
limits like any other); past them it writes the report with what it has. *Save as page* under a
report makes it a private page at the top of the workspace, its citations links to the sources
with a list of them at the end.

**Reviewing AI changes.** After an AI app, the chat or an agent writes to a page's body, the page
shows a bar above the body with how many blocks changed and who changed them. *Review* opens the
changes block by block, with *Keep* and *Undo* for each, next to *Keep all* and *Undo all*. Undoing
goes through the page's shared document, so editors open on the page follow at once, and *Undo all*
saves a version first. Writes in a row are reviewed together; the bar goes away once every change
is decided or someone edits the page. Only people who may edit the page see it.

**Memory.** The chat remembers short notes about you in each workspace: who you are, what you work
on, how you want answers. When you tell it about yourself or ask it to remember something, it keeps
a note (`remember`, also in place of an older note it corrects) and drops one when you ask it to
forget (`forget`). Since a note goes with every later question, the chat asks you first, as it
does before a change (*Yes* or *No*), also in *Read only*, where notes are the one thing it may
keep; only *Auto* keeps and drops notes without asking. Each note kept, dropped or declined shows
among the answer's steps, a *Memory updated* line under the answer opens *Memory*, and asking an
answer again keeps its notes with the new answer. It keeps only what you say in your questions,
never what pages or tool results say, and a note you already have (case aside) is kept once. Your notes go with each of your later questions in that workspace, as notes rather
than instructions: they never widen what the chat may read or change. The brain button in the chat's
header opens *Memory*, where you see, add, change and delete notes, or forget everything. Up to 30
notes per workspace, 300 characters each. Notes are private to you, never sent with anyone else's
questions or in another workspace, and are deleted when you leave the workspace or delete your
account.

The *Use memory* switch at the top of *Memory* turns it off for you in that workspace: your
questions then go without your notes and the chat isn't offered `remember` or `forget` (it says
the memory is off when asked to remember something). Workspace owners can turn the memory off for
everyone under Settings → General → AI → *AI memory*, which also hides the *Memory* button. Neither
switch deletes a note: they come back when the memory is turned on again.

The same notes reach the AI apps you connect over MCP, so each of them knows you as the chat does:
`list_memory` reads them (an app is told to at the start of a conversation), and `change_memory`
keeps a note, changes one or deletes some or all of them, with the chat's
limits. Apps are told to keep only what you say about yourself, never what pages or tool results
say, and to tell you what they kept; your app asks you before it calls a tool that changes
anything, as it does for pages. *Memory* shows which app kept or last changed each note (*Kept by
…*), until you change it yourself. With either switch off, an app sees no notes (only how many
there are) and keeps none, but can still delete them for you; a workspace that lets apps only read
refuses their changes to your notes too.

**Privacy.** Requests run as the person who asked, with their access at the time: the assistant
works only on pages they may edit, an AI property sends only the row values they can see, and the
chat and semantic search only find and read pages they can open, checked again on every search and
every `read_page` call (a page whose access was taken back mid-conversation can't be read any
more, and its old citations no longer show its title). Nothing is sent without someone asking
(automatic updates follow an edit and run as its author; indexing for semantic search sends page
text to the embeddings endpoint in the background). Owners can turn AI off for a workspace in
Settings → General → AI, which stops all AI features there and deletes its semantic search index. The server logs each request's feature, model, token counts and cost, and counts them for
the workspace's usage (see *Usage and cost limits*), never its content.
With a hosted provider, what is sent is subject to that provider's terms; a local model keeps
everything on your machines.

**Web search.** Agents an owner gave web access (see [Agents](agents.md#agents)) can also search the web
when the server has a search service, and so can the AI chat where a workspace's owners turn on
Settings → General → AI → *Web search in the AI chat* (off by default; research mode searches the
web there too). The service is set with `WEB_SEARCH_PROVIDER`:

| `WEB_SEARCH_PROVIDER` | Needs |
| --- | --- |
| `searxng` (the default when only `WEB_SEARCH_URL` is set) | `WEB_SEARCH_URL`: a self-hosted [SearXNG](https://docs.searxng.org) instance with its JSON output turned on (`json` listed under `search.formats` in its `settings.yml`), e.g. `http://searxng:8080`, asked at `<WEB_SEARCH_URL>/search?q=…&format=json` (an address with a path of its own is used as it is) |
| `brave` | `WEB_SEARCH_API_KEY` from the Brave Search API |
| `tavily` | `WEB_SEARCH_API_KEY` from Tavily |

For `brave` and `tavily`, `WEB_SEARCH_URL` overrides their address. A search waits 10 seconds at
most. The service is the server's own, so it may be on a private network; the pages read from the
web may not (the same checks as for links to files, with size and time limits). Unset, agents with
web access read only the pages whose links they are given or find in the workspace, and the chat
has no web tools. In the chat, web search only reads (`search_web`, `read_web_page`): web pages
are written by anyone, so what they say reaches the model framed as outside data, and once an
answer read from the web every change and note it wants is asked about, also in *Auto*. The words
it searches with leave the workspace for the search service.

**Limits.**

| Variable | Default | |
| --- | --- | --- |
| `AI_MAX_INPUT_CHARS` | none | Unset, the chat and agents send what the model's context window takes (its size less the answer's tokens, at 3 characters a token), and the writing assistant, AI properties, voice notes and agents' skills read at most 48,000 characters (a longer selection is refused, a longer page is cut). Set, it caps every request at this many characters |
| `AI_MAX_OUTPUT_TOKENS` | 8192 | Tokens one answer may have. A model that thinks before answering (Claude 5.5, OpenAI's and Gemini's reasoning models…) spends its thinking from the same tokens, so it always gets all of them, also where a feature caps the answer lower (AI property values: 800) |
| `AI_TIMEOUT_SECONDS` | 60 | |
| `AI_RATE_LIMIT` | 20 | Requests per person per minute |
| `AI_WORKSPACE_RATE_LIMIT` | 120 | Requests per workspace per minute, AI property values included (they wait for their turn) |
| `AI_CONCURRENCY` | 2 | AI property values worked out at the same time |
| `AI_CONTEXT_WINDOW` | 32768 | Context size, in tokens, assumed for OpenAI-compatible and local models (the chat and agents fit their prompt in it) |
| `AI_CHAT_MODELS` | none | More models the chat's box offers to pick from, comma-separated (see *Picking the model*) |
| `AI_IMAGE_INPUT` | false | Models the catalog doesn't know (OpenAI-compatible and local ones) take images attached to a chat question |
| `AI_MONTHLY_LIMIT_USD` | none | The most each workspace's AI may cost the server's `AI_*` key in a calendar month, in US dollars (see below) |

### Usage and cost limits

Every AI request adds what it used to its workspace's month: the AI chat, the writing assistant, AI
properties, agents, voice notes and semantic search, with the input, prompt cache and output tokens
and the cost in US dollars, by feature and model. Only these counts are stored (table `ai_usage`),
never what was asked or answered. The cost comes from the provider's prices as the AI library knows
them (current Claude, OpenAI and Gemini models), so it can differ slightly from the provider's
invoice; a model without known prices counts at no cost, and speech to text and embeddings are
counted but not priced. A request the provider failed after it started answering still counts what
it used. Months follow UTC and are kept for twelve.

Owners see it in **Settings → AI usage**: this month's cost and how much of the limit is left, the
last twelve months, and the month they pick by feature and model, and by person: each person and
agent with their requests, tokens, cost, share and features used most, costliest first (requests
nobody asked for show as background work; table `ai_usage_person`, where requests from before it
was added show as one line of their own). There are two monthly limits,
and a request that would go past either is refused before anything is sent, with a message saying
the workspace reached its limit (agents' runs stop with that reason; AI property values show it in
the cell):

- **The workspace's own**, which owners set in Settings → AI usage (empty: none). It counts all of
  the workspace's AI, whoever pays for it, so owners can hold their own AI account to a budget too.
  Changing it is in the audit log.
- **The server's**, `AI_MONTHLY_LIMIT_USD`, for whoever runs the server and pays for its `AI_*` key:
  it counts only what that key paid for the workspace this month, and never holds back a workspace
  running on its own AI account (*Your own AI keys*), which spends its owner's money. A higher limit
  of the owners' own doesn't lift it.

The limit is checked before each request, so requests already under way finish and a month can end
slightly over it (by at most `AI_CONCURRENCY` requests at once, a chat answer's worth). Agents keep
their own monthly token limit besides (*Agents*).

### Your own AI keys

A server open to people it doesn't pay AI for can let them bring their own provider key. It is
**off** unless `OWN_AI_KEYS_ENABLED=true`; while it is off there is nothing to see and every
workspace runs on the server's `AI_*` settings, as above.

With it on, everyone gets **Settings → Apps → AI** in their account, where they add an AI account
once: a provider (Anthropic, OpenAI, Google Gemini, OpenCode Go or an OpenAI-compatible server at
an address), a model, the key, and optionally an embeddings model (OpenAI, Google, OpenAI-compatible)
for semantic search and a speech-to-text model (OpenAI, OpenAI-compatible) for voice notes. Before
it is saved, Leafdesk sends it a tiny request (and one embedding, when it names a model for them);
an account it can't reach isn't kept. The key is stored encrypted (`LEAFDESK_ENCRYPTION_KEY`) and
never shown again, only its last four characters. Accounts can be tested again, changed (leaving the
key empty keeps it, as long as provider and address stay the same), made the default and removed.
Local providers (`ollama`, `lmstudio`) can't be chosen: their default address is the server's own
machine.

A workspace runs **all** of its AI on one account, so one person pays for it: an owner picks one of
their own accounts in **Settings → General → AI** (or none), and a workspace someone creates runs
on their default account from the start. One account can serve as many of its owner's workspaces as
they like. Everyone in the workspace sees whose account it is; only its owner can attach it, and any
owner can take it off. Each request uses, in order:

1. the workspace's account, while its owner is still a member (not a guest);
2. the server's `AI_*` settings, unless `AI_ONLY_OWN_KEYS=true` keeps them from workspaces;
3. nothing: AI is off in that workspace.

So `AI_ONLY_OWN_KEYS=true` lets the server keep an `AI_*` key for itself without any workspace
spending it. When the account's owner leaves the workspace, removes the account or deletes their
Leafdesk account, the workspace falls back down that list and its other owners get a notification.
A request the provider refuses for its key marks the account as not working, with the provider's
answer, in its owner's settings until a request works again or **Test** succeeds.

An account has one model, and it answers every feature, the ones that would run on
`AI_FAST_MODEL` too (agents set to the fast model included, which run there as any other agent): the server's fast model is a model at the server's provider, which the account
may not offer, and the account's owner chose what their key pays for. The thinking each feature asks
for (see the table above) applies to the account's model as well.

Semantic search indexes each workspace with the embeddings model its AI runs on, and changing the
account (or the account's embeddings model) indexes that workspace again in the background; search
across workspaces compares each one's pages with its own model. Without an embeddings model,
search is full-text search, as without AI.

An OpenAI-compatible server's address is one a person typed, so it is held to the rules
connections follow: https only, a public address only (checked when the request is made, and the
connection pinned to it), and no redirects. List servers on your own network in `AI_ALLOWED_HOSTS`
(comma-separated, a host name or host:port; plain http allowed for those), e.g.
`AI_ALLOWED_HOSTS=vllm:8000`. The limits above (`AI_MAX_INPUT_CHARS`, `AI_RATE_LIMIT`…) hold for
own accounts too. What an own account pays counts in the workspace's usage, and the owners' monthly
limit holds it; the server's `AI_MONTHLY_LIMIT_USD` doesn't (*Usage and cost limits*).

```bash
OWN_AI_KEYS_ENABLED=true
AI_ONLY_OWN_KEYS=true   # optional: the server's AI_* key serves no workspace
```

### Voice notes

People record a note, it is written down (speech to text), and the chat model writes it up as a
clean note. Speech to text is set up on its own, since many chat providers can't transcribe: any
server with an OpenAI-compatible `POST /audio/transcriptions` endpoint works, OpenAI's own or one
you run (a Whisper server such as faster-whisper or whisper.cpp behind a compatible API). Voice
notes stay hidden until `STT_PROVIDER` and `STT_MODEL` are set, and in workspaces whose owners
turned AI off.

| Speech to text | `STT_PROVIDER` | Needs |
| --- | --- | --- |
| OpenAI | `openai` | `STT_API_KEY` (or `OPENAI_API_KEY`, or the chat's key when `AI_PROVIDER=openai`) |
| Any OpenAI-compatible transcription server | `openai-compatible` | `STT_BASE_URL` (the `/v1` root), a key if it wants one |

```bash
STT_PROVIDER=openai
STT_MODEL=whisper-1

# or a server of your own
STT_PROVIDER=openai-compatible
STT_MODEL=base  # a model your server serves
STT_BASE_URL=http://whisper:8000/v1
```

The chat's key is reused only for the chat's own endpoint, never sent to another host.

**Recording.** In the quick note (the app's *Voice note* shortcut opens it recording), choose
*Record a voice note*, speak, and *Stop and write up*; or choose an audio file (WebM, Ogg, M4A/MP4,
MP3, WAV, FLAC), where the browser can't record or you have one already. The note fills the title
and text fields to check and change before *Save note*; *Save to* puts it on a private page or in
a database row, whose select and multi-select properties AI fills in from the options they have
(never new ones). A database can say how its notes are written up (*Voice note instructions* in
its page menu, full access, up to 2,000 characters: "company, person met, quote status, next
step"); the AI follows them for the content and layout of every note saved there, from the quick
note or the REST API, adding nothing that wasn't said. In a page, `/` *Voice note* records in a
dialog and puts the note where the slash menu was opened, its title as a heading; like the writing
assistant, the page is saved to its history first and Undo takes the note back. Recording needs a
secure (https) connection and the browser's permission to use the microphone; when either is
missing, or the browser can't record, the app says so and offers the file instead. A recording stops
by itself at the length or size limit.

**From other apps.** A script or app with a personal access token can send a recording to
`POST /api/v1/voice-notes` as multipart form data and get the note saved in one call (see
[REST API](rest-api.md#rest-api)); there is no MCP tool for it, since MCP tools take text, not audio.

**What is kept.** The note, and the transcript in a *Transcript* toggle under it to check what the
AI made of it. The audio is not stored: it is held in memory for the transcription request and
dropped with it. Without a chat model, or when the AI fails or its answer reaches
`AI_MAX_OUTPUT_TOKENS`, the note is the transcript as it was heard, titled with its first words.
The transcription and the write-up count toward `AI_RATE_LIMIT` and `AI_WORKSPACE_RATE_LIMIT`, and
the server logs them like other AI requests (size and time, never the audio or the text).

| Variable | Default | |
| --- | --- | --- |
| `STT_MAX_SECONDS` | 600 | Longest recording, in seconds |
| `STT_MAX_MB` | 25 | Largest audio file (OpenAI's own limit is 25 MB) |
| `STT_TIMEOUT_SECONDS` | 120 | |

### Meeting notes

A meeting notes block records a meeting and keeps its transcript and AI summary on the page. It
uses the speech to text set up for [voice notes](#voice-notes); without it the block's *Start
recording* is off and says why. Add one with `/` *Meeting notes*, *Add meeting notes below* in a
block's menu, or *New meeting note* on the *Meetings* page (a private page holding one). The block
has a title, a date and time, and attendees chosen from the workspace's people.

**Recording.** *Start recording* asks for the microphone; the recording goes on while you switch
tabs or move to other pages of the workspace (a bar at the bottom shows the time and stops it),
and can be paused and resumed. Every 30 seconds the piece just recorded is sent to the server and
transcribed, and its text appears in the block's *Transcript* with its time from the start
(`[mm:ss]`, pauses not counted). A piece that fails is sent again three times, then left in the
transcript as a gap. One person records a meeting at a time; if their browser closes without
stopping, after five minutes anyone who can edit the page can continue the recording or end it.
A meeting stops by itself at three hours.

**Summary.** *Stop and summarize* has AI write a summary, the decisions and the action items, the
latter assigned (`@Name:`) when they name an attendee. Each point ends with the moment it comes from;
clicking it opens the transcript there. The points can be edited, action items ticked, and
*Regenerate summary* writes them again from the transcript. A long transcript is summarized in
parts and the parts merged; each part is one AI request, and the transcription of each piece is one
too, all counted toward `AI_RATE_LIMIT`, `AI_WORKSPACE_RATE_LIMIT` and the cost limit like other
AI requests.

**What is kept.** The transcript and the summary, in the block; the audio is never stored. The AI
chat, MCP and the REST API read the block as Markdown (title, date, attendees, summary, decisions,
action items and the transcript with its times), search finds words in the transcript, and the
*Meetings* page (`/w/<workspace>/meetings`, hidden like other sidebar sections) lists the meeting
notes on pages you can see, upcoming and past, with their length and attendees, searchable by title, attendee or the summary's
first point.

Not included: a calendar connection (meetings are not created from or added to calendars) and
telling speakers apart in the transcript.

### Semantic search

With an embeddings model, search also finds pages by meaning ("car" finds a page about
automobiles): in the search dialog (such results are marked *Similar meaning*), the chat, MCP
`search` and REST `GET /search` (each result says `match: "text"` or `"semantic"`). The two
rankings are merged by reciprocal rank fusion. Without an embeddings model, or with AI off for the
workspace, search is exactly the full-text search. A search with text in double quotes needs that
phrase on the page: meaning alone then finds nothing more, though passages still come from it.

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

**Related pages.** Under a page's backlinks, the pages closest in meaning to it that it doesn't
link to and isn't linked from are listed (the mean of the page's chunk embeddings, ranked against
the chunks of the pages the reader can open, above `AI_EMBEDDINGS_MIN_SIMILARITY`). Nothing is
embedded for it: a page not indexed yet shows none until the index catches up.

**Indexing.** Each page's title and text (a database row's values too) is cut into chunks of
about 900 characters along its blocks, a heading starting a new one, and each chunk's embedding
is stored in `page_chunk` with its model, dimensions and a hash of its text. Each chunk starts with
where it is: the titles of the pages above its page, the page's own title and the heading it lies
under (at most 200 characters; a database row's path includes its database), so a passage under
*Sales › 2026 plan › Risks* is found for questions about sales risks even when it never says
"sales". Results and the chat show the passage without that path, since it can name pages the
reader can't open. Pages are indexed in the background a few seconds
after they are edited, created, renamed or restored, or a row's values change, and renaming or
moving a page indexes the pages under it again; only chunks whose text changed are embedded
again. The index records how pages were cut into chunks, so after a release that cuts them
differently the sweep and `pnpm search:index` count them as stale. A workspace's first search after a restart starts a sweep that
indexes pages the index missed (at most every ten minutes); `pnpm search:index [workspace-id…]`
indexes everything at once, e.g. after setting `AI_EMBEDDINGS_MODEL` or changing the model. Jobs
respect `AI_CONCURRENCY` and `AI_WORKSPACE_RATE_LIMIT`. Trashed pages drop out of results at once
(their chunks stay for a restore); deleted pages take their chunks with them.

**Attached documents.** The text of PDFs, Word documents (.docx) and Excel workbooks (.xlsx) in a
page's file blocks is indexed with the page, in chunks headed "Page › file name" that point at the
file block, so the chat can answer from a document and cite it. A document is read once and its text kept in
`file_text`; the first 50 pages or 200,000 characters of each are read (of a workbook, each sheet's
name and then its rows, at most 5,000 rows and 100 columns a sheet, and none whose contents unpack
to more than 64 MB), up to 20 documents per page, files over 25 MB are skipped, and a scan without
a text layer adds nothing. Full-text search reads the same text for any PDF, Word document or workbook a page shows, also one it only links to.
Documents are read whether or not the server has an embeddings model, since full-text search finds
pages by their words too: in the background after they are uploaded, and those uploaded before
search read them (or while the server was down) a couple of hundred at a time by a sweep that a
workspace's searches start, at most every 10 minutes. A page indexes only the files its readers
may open through it. Their text is sent to the embeddings endpoint like the page's own.

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

### AI chat from Telegram

People can ask the [AI chat](#ai-features) from Telegram: in a private chat with the server's bot,
by text or by voice message, answered as they are in the app, from the pages they can open, with
their sources as links to those pages.

**Setting it up.** Make a bot with [@BotFather](https://t.me/BotFather) (`/newbot`), and set its
token on the server, then restart:

```bash
TELEGRAM_BOT_TOKEN=123456789:AA...
# A self-hosted Bot API server instead of Telegram's (optional):
# TELEGRAM_API_URL=https://telegram-bot-api.example.com
```

The server asks Telegram for new messages itself (long polling), so it needs no public address
and works behind a firewall; any webhook set for the bot is removed. Give
each server its own bot: two servers reading one bot's messages each get some of them (the log
says so). The server log says `telegram: on as @<bot>` at startup, or why not. AI must be on (see
[AI features](#ai-features)); voice messages need speech to text (see
[Voice notes](#voice-notes)), otherwise the bot asks for text. Telegram's menu lists the bot's
commands in each of Leafdesk's languages.

**Linking an account.** In My account → *Connected apps* → *Telegram*, *Link Telegram* makes a
one-time link that opens the bot (also as a QR code for a phone); pressing *Start* there links
that Telegram account to the person. The link works once, for 10 minutes, and only a hash of it is
kept. A Telegram account links to one Leafdesk account at a time, and the other way round:
linking again moves it. The settings show the linked account and when it was last used, and
*Unlink* ends it (the bot says so in the chat); so do `/unlink` in Telegram and deleting the
account.

**Asking.** Each question goes to the person's current workspace and conversation, kept on the
link: the first workspace they are in until they pick another. A question in progress shows
"typing…"; a second one waits until it is answered. The bot only answers in a private chat with
the linked account; in a group it answers commands only, to say so. Commands:

| Command | What it does |
| --- | --- |
| `/new` | Starts a new conversation (the earlier ones stay in the app's chat history) |
| `/workspace` | Picks the workspace questions go to, from buttons, in a new conversation |
| `/mode` | Picks what the chat may change: *Ask* before each change (the default), change without asking (*Auto*), or *Read only* |
| `/stop` | Stops the answer being written; what it did so far is kept |
| `/notifications` | Turns notifications in the chat on or off |
| `/unlink` | Unlinks the Telegram account |
| `/help` | Lists the commands |

A voice message is written down by speech to text (counting as the chat's AI usage), shown back
as *You said: …*, and answered. Answers come in Telegram's formatting (bold, italics, code,
quotes; tables as preformatted text), split into messages where long, followed by the changes the
answer made and its sources as links to their pages (`APP_URL` must be an address the person's
phone can open). Conversations are the person's AI chat conversations: they show in the app's
chat history and follow its limits.

**Changes.** In *Ask* mode, each change (a row, a page, a page's text, a note to remember, a call
to a connection's tool that changes something) comes as a message saying what and where, with
*Yes* and *No* buttons (and *Yes, don't ask again* for changes in the workspace). Only the linked
person can press them; the answer waits up to 15 minutes, then goes on without the change, and
the message's buttons go once the answer ends.

**Notifications.** Each new item of the person's inbox also comes to the chat, as soon as it is
saved: what the inbox shows for it (the page, or what it is about, then who did what), the
workspace, and a link to where the inbox leads, with *Mark read* and *Snooze 1 hour* buttons that do
what the inbox's do (no snooze on agents' requests to go ahead). Like a push notification, it never
says what a comment, a changed value or an email says, since a phone's lock screen shows it to
whoever holds the phone. My account → Preferences has a *Telegram* column next to *Inbox*,
*Email* and *Push* for choosing, per kind, what comes there; it follows the inbox as push does (a
kind kept out of the inbox doesn't come). The *Send my notifications here* switch on the Telegram
card, or `/notifications` in the chat, turns them all off or on. Notifications of a workspace that
turned connected apps off don't come. A chat that blocked the bot gets its notifications turned
off, until the person turns them on again.

**Agents' calls.** An agent's call that waits for an owner (see [Connections](connections.md#connections)) comes
with what it would send, as the inbox shows it (credentials masked, cut to 3,000 characters here),
hidden until tapped so a lock screen doesn't show it, and with *Approve*, *Decline* and *Send back
with a note*. As in the inbox, *Approve* is offered only when that is all of what would be sent;
otherwise the message says so and links to the run, where it is approved. *Send back with a note*
asks for the note: the answer to that question goes back to the agent. Only the owners the run is
for can answer it, only the call the message shows (an agent that asked again since needs an answer
to its new call), and only once; the answer counts as the owner's, and the audit log notes it was
given from Telegram. A workspace that lets connected apps only read has its calls answered in the
app.

**Who may reach what.** The bot acts as the person, as a connected app does: each question is
checked like an MCP request against the person's access and against the workspace's *Connected
apps and API tokens* switch (see [Workspace security switches](account-and-security.md#workspace-security-switches)): a
workspace that turned apps off isn't offered, and in one that lets them only read, the chat
changes nothing, its notes about the person included. Like other connected apps, the bot doesn't
meet a workspace's sign-in policies (two-step, single sign-on) itself: owners who require them for
everything can turn connected apps off. Every question counts against `AI_RATE_LIMIT`. The bot
never answers someone whose Telegram account isn't linked, and what people send it reaches the
model as their question, nothing more.

## Skills

A skill is a page or database row whose body is instructions to reuse: a review checklist, how to
write release notes, how to triage a bug. Every row of a skills database is one, however it was
added (the table, MCP, the REST API, an import or a move), and its *Description* property says
what it is for; any database becomes a skills database, or stops being one, from its ⋯ menu
(*Skills database*, full access), which adds a *Description* property when it has none. Any other
page or row becomes one with *Use as skill* in its `⋯` menu (whoever may edit it); a bar under the
title then holds what the skill is for and when to use it (up to 1024 characters). The lists below
show that description, or else the start of the body. Databases, templates and the pages in them
can't be skills, and a copy of a skill isn't one. Skills have no
access of their own: everyone sees the skills they can open, and a skill in the trash leaves every
list until it is restored.

- **Skills library**: the sidebar's skills button (next to the people button) opens
  `/w/<workspace>/skills`, the workspace's skills with their descriptions, searchable, and links to
  your skills database. *New skill* adds a row to it: your own, made private at the top of the
  workspace the first time, with *Description*, *Files*, *Tags* and *Created by* properties.
- **Ready-made skills**: six skills to start from (*Wrap up meeting notes*, *Weekly status summary*,
  *Reply to a customer*, *Proofread a text*, *Triage a request*, *Executive summary*), shown in the
  library while it is empty and under *Ready-made skills* after. Picking one adds it, in the user's
  language and with its description, as a row of their skills database, theirs to change from then
  on. They need no setup: each works on whatever page, row or text it is pointed at. The texts are
  in `src/i18n/messages/<locale>/skillTemplates.json`.
- **AI chat**: `/` at the start of the empty question box (or the skills button under it) lists
  the skills; the one picked shows above the box and the next question goes to the model with its
  instructions, which the model is told to follow for that question only. They don't widen what the
  chat may change: the mode under the box still decides. The question keeps the skill it used
  (shown above it), *Answer again* and *Edit* use it again, and later questions go without it.
  A skill longer than 20,000 characters can't be used in the chat.
- **MCP**: `list_skills`, `get_skill` (by name, title, page id or link; a title several skills
  share is refused with their names) and `set_skill` (mark, unmark, describe), and every skill the user can open is a prompt of its name, which hands its instructions
  (and an optional `input`) to the client. Names come from titles and are unique across the user's
  workspaces (`review-checklist`, `review-checklist-2`). The server's instructions tell the model
  to follow a skill only when the user asked for it or picked its prompt.
- **Agents**: owners give an agent skills to follow on every run (see [Agents](agents.md#agents)).
- **Export**: *Export as SKILL.md* in the page menu (and the download button in the library)
  downloads `<name>.zip` holding `<name>/SKILL.md`: front matter with the name and description,
  then the body as Markdown with links to the app in full: the folder layout AI assistants install
  skills from.

## Snippets

A snippet is a piece of content you put in while typing: a meeting's headings, a dated log line, a
sign-off. Type `;` at the start of a line or after a space, then the snippet's trigger or part of
its title (`;meet`, `;log-2`): the menu lists the matches, your own first and then the workspace's,
and Enter puts the snippet in. The slash menu has them too, under *Snippets*. A semicolon right
after a word stays a semicolon.

- **Where it goes**: a snippet of one paragraph joins the line's text; anything bigger takes the
  place of an empty line or goes after the line. Its body is Leafdesk Markdown, so it can hold
  headings, lists, to-dos, tables, callouts, links and mentions.
- **Placeholders**, filled in when the snippet goes in: `{{date}}`, `{{time}}` and `{{datetime}}`
  (in your language and time zone), `{{me}}` (your name), `{{page}}` (the page's title) and
  `{{cursor}}`, where the caret stops (the first one; any others are removed).
- **Your snippets**: Settings → *Snippets* → *Mine*, only for you, in every workspace. Until the
  list holds snippets other than these, it offers three examples (meeting notes, a dated log line,
  a decision record) to add with one click.
- **The workspace's snippets**: Settings → *Snippets* → *Workspace*. Everyone in the workspace
  inserts them, next to their own; owners add, change and delete them. Guests see only their own.
  They are part of the workspace's backup; personal snippets are not.
- **Making one**: *New snippet* in either list, or *Save as snippet* in a block's menu (the
  handle beside it), which opens the form with that block, or the selected blocks, as Markdown.
  The form has the title, the trigger (made from the title until you type one), the Markdown with
  buttons for the placeholders, and a preview of the blocks it makes. *Duplicate* copies a snippet
  under the next free trigger (`standup-2`).
- **Rules**: a trigger is up to 32 lowercase letters, digits, `-` and `_`, unique among your own
  snippets or the workspace's; a title is up to 120 characters and a body up to 20,000. There can
  be 300 personal snippets per person and 300 per workspace.
- **Import and export**: *Export* downloads `{"version": 1, "snippets": [{"trigger", "title",
  "body"}]}`. *Import* takes such a file, or a plain list of `{"id", "label"}` objects (the
  trigger and the text), up to 8 MB; entries whose trigger is taken, invalid or repeated, that are
  empty or too long, or past the limit are skipped and listed with the reason.
- **MCP**: `list_snippets` lists the snippets the user may insert, personal and the workspace's,
  with their Markdown, so an assistant can write in the same shape.
