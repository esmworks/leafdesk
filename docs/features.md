# Features

[← README](../README.md) · [All documentation](README.md)

- **Pages**: nested pages, a block editor (BlockNote) with slash menu (block text and background
  colors included) and markdown shortcuts, icons (beside the title: an emoji, found by name in the interface language and
  in the skin tone you last picked, or one of a few hundred built-in line icons in one of nine colors
  that read well in light, dark and high contrast; *Random* picks one), backgrounds (a color that suits the light and dark theme, or black, with an optional faint
  pattern, and a cover: a band across the top in one of eight gradients, on the page and its published copy;
  none of them loads an image), favorites, duplicate (copies numbered "Plan (1)", "Plan (2)"…, a copy of a
  copy counting on from the original), move, trash with restore (emptied after a time owners choose; moving a page, or
  trashing pages or rows, shows a note with *Undo*, and a move links to where the page went), archive (an outdated page, such
  as an old price list, leaves the sidebar, search, pickers and database views with the pages and rows under it, yet stays
  readable, editable and linked; a banner on it says who archived it and when, and search finds it with *Include archived*), export as Markdown or PDF (or, with
  subpages, as a ZIP; owners can export the whole workspace, see [Export](export.md#export)), and search
  over titles and content: full-text (every word of the search, each also as the start of a
  longer word, so pages show up while you type: "kond plan" finds "Kondenser planı", while the
  middle of a word doesn't match; Japanese and Chinese words also inside a sentence, which has no
  spaces between words: "会議" finds "明日の会議について", a word's characters only side by side;
  Korean words by their start, so with a particle joined on: "회의" finds "회의를"; pages whose
  title has the words come first; past the first 80,000 characters of a huge page's text, words
  aren't found; text in double quotes, `"launch plan"`, only with its words whole, side by side and
  in that order, and then a page found by meaning alone isn't listed), and also by meaning when the
  server has an embeddings model
  (see [Semantic search](ai.md#semantic-search)). Full-text search also looks inside the PDFs and
  Word documents a page shows, with or without an embeddings model: a page is found when one of
  its documents has every word, after the pages that have them in their own text, and the result
  names the document, with the text around the words. Only documents the page's readers may open
  through it count, as for semantic search; a document's first 80,000 characters are searched,
  and a scan without a text layer has no words to find. The sidebar's new button asks what to make
  (a page, a chat, a database or a page from a template). A page's `⋯` menu counts its words and
  characters, and *Present* (⌘⌥P, Ctrl+Alt+P) shows it full screen as read-only slides: a new
  slide at each divider, or else at each heading of level 1 or 2. *Read aloud* reads the page with
  the browser's own speech, nothing sent anywhere: block by block from the title, marking and
  scrolling to the block being read, with pause, the previous and next block, the speed and the
  voice (both remembered in the browser); code blocks are skipped. Resting on a page in the
  breadcrumb (or ↓ on it) lists the pages beside it, its parent's other subpages or a row's
  database's other rows, to jump to; clicking the page's own crumb while it is scrolled down goes
  back to its top. Quotes typed in a page become typographic ones (“ ” ‘ ’, ’ in "don’t"), except in
  code, code blocks, equations and diagram sources; Backspace right after one gives back the
  straight quote.
- **Home page**: quick buttons for a new page, database or template; today's daily note (or a
  button that starts it) and the few before it; the database rows assigned to you that aren't done
  and that you can open, with the unticked to-dos in pages that mention you (see *My tasks*),
  grouped as overdue, today, the next 7 days, later and no date; *Jump back
  in*, the pages you opened last (while the workspace and you record page views, see *People directory and analytics*;
  only pages you can still open); and the pages edited last. My account → Preferences → *Start page*
  opens Leafdesk on the home page or on the page you opened last on any device (while your page
  views are recorded), when you start it or sign in; with the latter, switching to another
  workspace from the sidebar's menu opens the page you opened last there.
- **My tasks** (in the sidebar; hide or move it like its other sections): every database row
  assigned to you across the workspace, in any person property, that isn't done and that you can
  open, by due date or by database, with its status and first date; the first 200, the ones due
  soonest. A row opens beside the list. Tick a row with a status to set it to the first option of
  its *Done* group, and untick it to put the status back; the home page's list works the same way.
  To-dos written in pages are listed too: an unticked to-do that mentions you (`@` and your name)
  shows its text without the mentions, "on" its page with the page's icon, and the first date
  mentioned in it as its due date; it goes under its page when grouped by database. Only pages you
  can open count, not those in the trash or templates. Clicking one opens its page at the to-do;
  ticking it ticks the to-do in the page (with edit access to the page), and it leaves the list
  once the page is saved. Mentioning a group or an agent in a to-do doesn't put it in anyone's
  list; mention the people themselves.
- **Search box** (Cmd/Ctrl+K or Cmd/Ctrl+P; with text selected in a page, Cmd/Ctrl+K links it instead): before you type, the pages you opened last (the pages last edited
  while your page views aren't recorded or you haven't opened any yet). The menus under the query
  narrow it by teamspace, by who created a page or edited it last, and by when it was last edited
  or created (today, the last 7 or 30 days, or days you pick, in your time zone); they list pages
  without words too. *Sort* orders the results by best match (the default) or by when pages were
  last edited or created, newest or oldest first, over every page that matches. Narrow a search with
  `in:Projects` or `in:"Launch plan"` (that page and everything under it; several pages of that
  title, or several `in:`, search under any of them; a title nobody can see finds nothing) and
  `type:page`, `type:database`, `type:row` (database rows) or `type:journal` (your daily notes),
  and `is:verified` (pages verified right now, see *Verified pages*), and `#home` or `tag:home`
  (pages carrying that tag or one under it, see *Tags*; with several tags, pages carrying each);
  filters work without words too, listing the pages they match, last edited first. While you type
  `#` and a letter, the tags of pages you can open that start so come first, most used first with
  how many pages carry each; `/` narrows to a branch and picking one completes it. Type `>` for commands: new page or database,
  from a template, import, trash, inbox, settings and keyboard shortcuts, and, once you type
  after `>`, each setting you can see (*Settings: Security → Legal holds*). The line under the
  results puts each of these into the box. The words you typed show in bold in the text under each
  result.
- **Tags**: write `#tag` anywhere in a page's text, at its start or after a space or an opening
  bracket or quote, and find everything carrying it with `#tag` in the search box. A tag is
  letters, digits, `_` and `-` with at least one letter (`#1` isn't one, nor a color like
  `#ff0000`), in any script, and `/` makes a hierarchy: `#home/renovation` is found by `#home` too.
  Case and accents don't count (`#Café` is `#cafe`); the spelling met first is the one shown. Tags
  stay plain text, so Markdown, copies, history, exports, imports (an Obsidian vault's tags among
  them) and MCP read them as written; text in code, equations, diagram sources, links and
  mentions isn't a tag, nor `# ` at the start of a line, which still makes a heading. In a page
  tags show in the accent color; clicking one (with Ctrl or Cmd where you can edit) opens the
  search box with it. Typing `#` and a letter offers the tags of pages you can open, most used
  first: Enter or Tab completes one (Enter on a tag typed out in full starts a new line), Escape
  or a space leaves the text as typed. MCP's `search` and the REST API's `GET /search` take a
  `tag`. Published pages show tags as plain text.
- **Settings search**: the box at the top of Settings' navigation finds a setting on any tab you
  have, by its name, its tab or other words ("dark mode", "2fa", "ip"), opens the tab, scrolls to
  the setting and highlights it.
- **Page style**: at the top of a page's `⋯` menu, a typeface for the page (default, serif or
  mono), small text, and full width. It is set per page and everyone sees it, changing live for
  whoever has the page open; anyone who can edit the page can change it. Copies and templates keep
  it, published pages show it, and the print view uses the typeface and text size (paper has no
  full width). Small text applies on screens with a mouse or trackpad: on touch screens the body
  stays at 16px, so the phone doesn't zoom in when you start typing. Restoring an older version
  keeps the current style. Databases always use the full width. With the comments panel open, a
  page moves left of it (and narrows when the window is too small) instead of running under it.
- **Rich blocks**: toggles (an empty one shows a fainter arrow, so it reads as empty without
  opening it), callouts (one can be hidden when printing: it stays on screen and is left out
  of PDFs), LaTeX equations (block and inline, KaTeX, with `\ce{…}` and `\pu{…}` for chemical equations and units), footnotes (`/footnote` puts a number in the
  text and the note in a popup; the page lists its notes at the end, on published pages and in PDFs
  too, and hovering a number shows its note), Mermaid diagrams with a live preview, a table of contents, a breadcrumb, a list of the page's subpages (live, each reader
  seeing those they may open; a page with one doesn't list them again at its end when published or
  printed), and columns (2 to 5, resizable, blocks
  dragged in and out with the side menu, stacked on phones, and on pages of standard width able to
  reach into the margins; `/col2` and `/col3` make them, a block dropped at another's left or right
  side goes beside it, and *Turn into* in a block's menu puts the selected blocks one to a column),
  also on published pages and in Markdown. Numbered lists nested in numbered lists count in
  letters, then roman numerals, then numbers again (1, a, i), in the editor, on published pages and
  in PDFs; inline code isn't marked by the browser's spelling check. A code block's menu adds a
  *Caption* under the code (published pages and PDFs show it; Markdown writes the line
  `<!-- leafdesk:caption … -->` before the fence). Resting on a web link shows its address at the
  start of its toolbar. `>`, `|` or `"` and a space at
  the start of an empty line start a quote. A quote's block menu sets its
  *Quote size*: the size of the text around it, or large for a pull quote (in Markdown, the line
  `<!-- leafdesk:large-quote -->` before it); the size last picked is what new quotes start with in
  that browser. Text in Chinese, Japanese and Korean is set in faces chosen for each language, sans
  and serif (the page's *Serif* typeface too). Resting on a date mention shows its day written out
  with the weekday. *Turn into* also changes the kind of the selected text
  blocks (heading, list, quote, code …), and a space typed right after `/` closes the slash menu.
  Table cells merge across columns and rows from the formatting toolbar (Markdown writes
  the full grid, the covered places empty), and a table's row and column handles color their
  cells' text or background and make the first row or column a header (published pages and PDFs
  show both). Code blocks take their language from a menu (plain text
  and 52 languages; Cmd/Ctrl+Alt+L in a code block opens it from the keyboard) and color their code in it, published pages and the print view included; Enter
  in a code block starts the new line with the indentation of the one before it. *Copy* in a code
  block's corner, in the editor and on published pages, copies its code. *Format code* in
  the block's menu formats JavaScript, TypeScript, JSX, TSX, JSON, CSS, SCSS, HTML, Vue, Markdown,
  YAML and GraphQL with Prettier (loaded only then) as one change of the block; code with a syntax
  error stays as it was.
- **Floating outline**: a page with two headings or more shows a short line per heading at its
  edge, the one being read darker. Hovering the lines (or tabbing to them) lists the headings, and a
  click scrolls there, opening collapsed toggles on the way. It stays out of the way on narrow
  screens, beside the comments panel, on full-width pages and in print.
- **Dashboards**: the `/dashboard` block puts numbers, charts and lists from any of the
  workspace's databases on a page, up to 12 widgets in a grid of four columns (two on narrow pages,
  one on phones). Each widget is a database seen through its own view (a *Number* chart for one
  value, a chart, a list, or any other layout), set up in place, kept up to date as rows change,
  and worked out for each reader from the rows and values they may see; a number, bar or slice
  opens the rows behind it. A widget can take one of the option colors, as board columns do, and
  editors move widgets by dragging their title bar. A page with a dashboard uses the full width.
  Published pages show numbers and lists, and charts as a table of their figures. Over MCP,
  `add_dashboard` and `update_dashboard_widget` build one. A database also has dashboard views:
  the same grid as a tab of the database, its widgets all views of that database, starting with
  the row count, the sum of the first number property, a chart by the first select or status
  property and the rows edited last. Dashboard views aren't published, printed or shown by linked
  views. The `/tabs` block is a dashboard laid out as tabs: one view at a time, each named on its
  tab, for several databases (or views of one) in little room; readers get only the tabs whose
  database they can open, and published pages switch tabs in place.
- **Buttons**: the `/button` block, with a label, an emoji or built-in icon and a color from the option palette
  (light, dark and high contrast alike, on published pages and in print too), does a few things in order when
  someone clicks it: insert blocks written in Markdown below it or at the top or end of the page,
  add a row to a database (optionally from one of its row templates, or its default one; values the
  step sets go over the template's), change the rows of a database that filters match (up to 100), notify
  people, send the page to a webhook (signed like automations' webhooks, when the workspace lets
  content leave it) and open a web address or a page. Texts take `{{today}}`, `{{now}}` and
  `{{me}}`, and values can be today or whoever clicked; a button can ask before it runs. It runs as
  whoever clicks, each step with their access: viewing the page is enough to click, inserting
  blocks needs edit access to it and rows need edit access to their database. The first step they
  can't do stops the button and says which and why. Its changes are theirs: they start the
  database's automations, and the row's activity marks them as made through a button. People who
  can edit the page set it up from the button's settings; published pages and the print view show
  it disabled, and Markdown over MCP and the API holds only its id and label
  (`<!-- leafdesk:button <id> "Label" -->`), so it can't be made or changed there.
- **Web bookmarks and embeds**: link cards with the page's title, description and image (fetched
  once on the server behind an SSRF guard), and YouTube, Vimeo, Loom, Figma, Google Docs, CodePen,
  Replit, Excalidraw, Framer, Sketch, Miro, Whimsical, Spotify and Google Maps embeds in sandboxed iframes (a pasted
  link of one of them offers *Embed*, and `/replit`, `/excalidraw`, `/framer`, `/sketch`, `/miro` and `/whimsical` find the
  block). The Embed block also shows any other https
  site as it is (Hex apps, Deepnote blocks, Pitch presentations…) in the same sandbox, in the
  site's own origin and without a referrer; sites that refuse to be framed (many do, with
  `X-Frame-Options` or `frame-ancestors`) show an empty frame with their link under it, and this
  app's own pages are never framed. A bookmark card can be made narrower by
  dragging its edge; published pages and print keep the width. A bookmark's or embed's block menu
  has *Copy link to original*, beside *Copy link to block*. A pasted link can also become a link
  mention: the site's icon, the page's title and the site's name inline in the text, fetched the
  same way and stored with it (*Show as mention* in a link's toolbar does the same for a link
  already there). Markdown, MCP and exports write it as `[Title](url)`, and writing a page's
  Markdown back keeps its mentions; published pages, print and PDFs show it as a link. Resting
  the pointer on a link mention shows a card with its title, site and address, *Copy link* and,
  for editors, *Refresh* (fetch its details again) and *Turn into bookmark*; a link's toolbar has
  *Copy link* and *Turn into bookmark* too. A bookmark goes under the line, or takes the line's
  place when the link was all it held.
- **Realtime collaboration**: several people can edit the same page at once (Yjs over WebSocket
  via Hocuspocus), with live cursors. The page header shows who else has the page open, including
  people who can only view it; clicking one of them scrolls to where they are typing. When one
  audio or video block on a page starts playing, the others pause.
- **Offline editing**: pages you opened before stay readable and editable without a connection;
  the edits sync when it is back, merged with what others wrote meanwhile. The sidebar and
  recently opened databases stay readable. The page header shows offline, syncing and synced (see
  [Install and offline use](desktop-and-offline.md#install-and-offline-use)), and *Not saved* when the server couldn't
  save the latest changes, until a later save goes through.
- **Installable app**: install Leafdesk from the browser on desktop (Chrome, Edge) or add it to
  the home screen on phones; it opens in its own window. The app's icon offers a quick note, and on
  phones that support it Leafdesk shows up in the share sheet: text and links shared to it open the
  quick note filled in, saved as a private page in the workspace you pick or as a row of one of its
  databases; a shared link can be saved as the whole page instead (see *Save a web page* under
  Import). Where the server can transcribe, the quick note takes voice notes too (see
  [Voice notes](ai.md#voice-notes)).
- **New page from the address bar**: `/new` on your Leafdesk address (`https://…/new`) makes a
  private page and opens it, in the workspace you were in last (`/new?workspace=<id>` for another).
  A page's emoji or built-in icon is its browser tab's icon too.
- **Desktop app** for macOS, Windows and Linux: a window on your server, or Leafdesk running on
  the computer itself with its own database and daily backups (see [Desktop app](desktop-and-offline.md#desktop-app)),
  with tabs, opening on the page you left and taking Leafdesk links from the browser. A
  system-wide shortcut (Cmd/Ctrl+Shift+J) brings it forward on AI chat.
- **Find and replace** in a page (Cmd/Ctrl+F): highlights every match, steps through them, and
  replaces one or all in a single undo step, opening a collapsed toggle when the match it steps to
  is inside it. Accents don't matter ("cafe" finds "café", "isik" finds "ışık") unless *Match
  accents* is on. Anyone who can open the page can search it.
- **Databases**: every row is also a page.
  - Properties: text, number, select, multi-select, status, date, checkbox, checklist, URL,
    email, phone, files & media (uploads with image thumbnails), place (an address looked up on the
    server, or coordinates; see Maps and places), person, one- or two-way relations to other databases, formulas, rollups over
    relations, and the read-only "created by", "created time", "last edited time" and
    "last edited by".
  - Each property can have a description (up to 1,000 characters, in its menu): a hint on its
    header and on row pages, a form question's help text when it has none, and guidance for AI
    autofill, the AI chat, agents and MCP when they write values. A select or multi-select can
    depend on another select ("City" on "Country", *Depends on* in its menu): a row is offered,
    and may hold, only the options that go with its value there, and changing that value clears
    what no longer fits.
  - A URL property can *Show as link preview*: row pages then show the linked page's icon, title
    and image under the link, fetched on the server behind the same SSRF guard as bookmarks and
    kept for a day.
  - A person property can be limited to one person (*Limit to one person* in its menu): picking
    someone replaces whoever was there, and writes naming more are refused. Rows naming more when
    it is turned on keep them until they're changed.
  - A text, number, email, URL or phone property can keep its values unique (*Unique values* in
    its menu): no two rows may hold the same value, case and spaces aside, numbers by amount and
    phone numbers by their digits. Empty values don't count. It can't be turned on while two rows
    share a value (the error names one), and once on, every way a value is written is held to it:
    edits, new rows, bulk edits, pastes, imports, forms, the API, MCP, automations and syncs. A
    paste, an import or a sync run leaves out a value another row holds (or an earlier row of the
    same paste, file or run takes) and counts it with the other values that couldn't go in, rather
    than stopping; a synced item whose key is left out that way isn't added. A row
    in the trash frees its value and can't be restored while another row holds it; a duplicated
    row leaves the value out. Changing the property's type turns it off.
  - A status can *Show as checkbox* (in its menu): a box ticked while the status is done; ticking
    it picks the first done status and unticking it the first to-do one. Filters, groups and the
    API still see the status.
  - An ID property numbers a database's rows 1, 2, 3… as they are made, with an optional prefix
    (`TASK-12`). Adding one numbers the rows already there in the order they were made, numbers
    are never given out twice, and search, quick find and relation pickers find a row by its ID.
  - A two-way relation is one link shown on both rows: linking a row to another, or unlinking it,
    changes the other row's paired property too. That takes edit access to the row you change and
    being able to see the row you link, not edit access to the other database; making a two-way
    relation takes edit access to both databases, since it adds the paired property to the other.
    A one-way relation can be made two-way later from its menu (*Show on … too*), which links the
    rows back from the rows they already link to.
  - A relation can be limited to one page (*Limit to one page* in its menu), as a person property
    can to one person: picking another row replaces the linked one, writes linking more are refused,
    and rows linking more when it is turned on keep them until they're changed. Each side of a
    two-way relation has its own limit, and linking to a row whose side links one moves it away
    from its old link.
  - A relation's *Relation options* pick up to four properties of the related database (not
    formulas, rollups, relations or files) that linked rows show beside their title, in an order
    you choose, in table cells, cards, row pages and the row picker; the values come with the rows
    and keep the viewer's property access. *As a section* lists the linked rows under a row page's
    properties instead, ten at a time, with those properties editable in place and links added or
    removed there.
  - Personal views: *Only for me* in the add-view menu makes a view nobody else sees, changes or
    finds in the sidebar, marked with a person on its tab. Anyone who may read a database can make
    them, on a locked database too, and set them up as they like; people who may only read get
    personal views from the menu without asking. They are never published, copied with the
    database or forms, don't count toward the database's last view, and go when their person
    leaves the workspace. Someone who may change the database's views turns one into a shared view
    with *Share with everyone*. MCP's `create_database_view` takes `personal`, and `get_database`
    marks them.
  - Views: table, board, calendar, gallery, list, feed (rows as posts, newest first, with the
    start of their bodies, emoji reactions and their comments), timeline (a column per day, week,
    month, quarter or year), map (rows as pins at a place
    property), chart and dashboard (widgets over the database, see Dashboards), each with its own filters,
    sorting, grouping and shown properties (one by one, or all hidden or shown at once). The *View
    settings* menu beside the toolbar holds all of a view's settings in one place: its layout
    (a table, board, calendar, gallery, list, feed, timeline or map switches to any of the others,
    keeping its filters, sorts, properties and grouping, which a board shows as columns, a timeline
    as swimlanes and a map as pin colors; a board, calendar or map without one picks what it goes by),
    properties, filters, sorts and grouping, each a page of the menu, then the layout's own
    settings, *Duplicate* and *Delete*. Tables, lists and galleries can group their rows into
    sections that fold away, boards always group into columns and can split them into sub-groups
    by a second property (sections across every column; a card dragged into another changes both
    values), and a board's columns can leave out their option colors (*Color columns*). Filters
    combine with "and"/"or" in groups (nested up to three levels) and take relative dates: today,
    this, last or next week (Monday to Sunday), month or year, and the past or next few days. The
    filters in use show as chips under the view's toolbar: clicking one changes just that filter,
    its ✕ removes it. Text can be
    filtered on what it does or does not contain, numbers with =, ≠, <, ≤, > and ≥, dates on,
    before, after, on or before and on or after a day, and selects, statuses, tags, relations and
    people on any of several values or none of them in one rule. A "Me" filter (also inside such a
    list) shows each viewer their own rows. *Color rules* in the view settings menu (tables, boards,
    galleries, lists, calendars, timelines) color the whole row or card, or one property's value,
    for the rows that match filters of the same kind; the first matching rule wins.
  - People who can only view a database (or a view whose settings they can't change) still filter
    and sort it for themselves: their rules replace the view's for them alone, marked *Only for
    you*, are never saved, and *Reset* brings back the view's own. People who can change the view
    get a draft the same way, marked *Not saved*: *Save for everyone* saves its filters and sorts to
    the view, *Reset* throws them away. (A linked view's filters still save as they change.)
  - A view tab (its menu → *Icon*) and a property (its menu, beside the name) can have their own
    icon from the same picker, shown in the view bar, the table header, row pages, the sidebar and
    published pages instead of the type's.
  - Each view with rows can leave out the rows' page icons (Layout → *Show page icons*; published
    views too), and a calendar can leave out Saturdays and Sundays (*Show weekends*, month and
    week alike): its weekdays then share the width, and rows only on a weekend are listed under it
    with their day, to open or drag onto a weekday. Boards and galleries can wrap long values on
    their cards onto more lines instead of cutting them off (*Wrap all properties*), and a table
    can leave out the lines between its columns (*Show vertical lines*; published tables too).
  - Large databases: a board column and a gallery show 50 cards, then *Load more* adds as many
    again (Layout → *Load limit*: 10, 25, 50 or 100; filters, sorts, counts and calculations still
    take every row, and cards added there stay in view). A list, like a table, draws only the lines
    near the visible part of the page from 120 rows on. Published views show every card.
  - Clicking a value on a board or gallery card edits it in place with the table's editor, without
    opening the row; people who can't change it see the plain value.
  - *Duplicate view* in a view's tab menu makes a copy with its layout, filters, sorts and other
    settings, named "… (copy)", right after it. A linked view on a page can leave out the
    database's name above it (Layout → *Show title*); published and printed pages and PDFs leave it
    out too.
  - Table columns are resized by dragging their edge; double-clicking the edge fits the column to
    its header and the rows shown. The width is kept with the view.
  - Names, options and linked rows cut short with an ellipsis show in full as a tooltip on hover;
    so does a cell's list of values that doesn't all fit.
  - Table views calculate column totals, averages, counts and more over the filtered rows.
  - Board columns show how many cards they hold next to their name, and can show one calculation
    over a property for their cards on the line under it, the same in every column: the sum of the
    estimates, the average of a score, the earliest due date, how many are checked. Editors pick it
    by clicking a column's card count, and change it from that line.
  - Table cells work from the keyboard: click a cell or move with the arrow keys, select a range
    with Shift and an arrow, Shift+click or a drag; Enter edits the cell, Esc goes back to it and
    Delete clears the range. Copy puts the range on the clipboard as tab-separated text, and cells
    pasted from a spreadsheet are written from the active cell on, each value read as the CSV
    import reads it (numbers, dates, yes/no, option and people names), adding options a select
    lacks and, in an ungrouped table, rows past the last one. One pasted value fills the whole
    range; cells that don't fit their column or that you may not change are left out and counted.
    The handle at the bottom-right of the selection fills the cells it is dragged over (up or down)
    with the selection's values, and Cmd/Ctrl+D fills a range down from its top cell in each column
    (on a single row it duplicates the row); both write the same way a paste does.
    From 120 rows on, a table renders only the rows near the visible part of the page. Selected
    rows can be edited, given or cleared of an icon, duplicated, merged, exported or trashed
    together (rows the viewer may not edit, and locked rows, are skipped and counted).
  - The handle before each table row drags it among the others while no sort orders the view,
    and clicked opens the row's menu: a search box, its icon, open it (panel, full page, new tab),
    comments, copy link, duplicate (⌘D), move (⌘⇧P), merge, follow, trash (Del), copy ids, who
    last edited it and its body's word and character count.
  - Merging duplicates: select 2 to 5 rows and choose *Merge*, or *Merge with…* in a row's menu.
    The dialog sets them side by side: pick the row to keep and, for the title and each property,
    whose value it keeps, or *Combine all* for multi-select, relation, person, files and
    checklist values. Links to the merged rows from anywhere point at the kept row, their
    comments, activity, files, email and content come along, and they go to the trash.
  - List views edit the values on each line in place, with the table's editors: Tab and Shift+Tab
    move between a line's values and Shift+Enter adds a row right below the line.
  - The options of a select, multi-select or status are dragged into order or sorted A → Z or
    Z → A once, compared as the viewer's language reads (a status within each group).
  - A rollup can show the related rows' values as they are (*Show original*) or each value once
    (*Show unique values*). One showing their URL, email or phone values shows each as a link.
  - Formulas read the row's properties and, through a relation, the properties of the linked rows
    (`sum(map(prop("Tasks"), prop(current, "Hours")))`, with `filter`, `find`, `some`, `every`,
    `first`, `last` and `at`), one step away and up to 200 linked rows. `sum`, `average` (also
    written `mean`) and `median` take numbers or a list of them. `style()` shows a result
    bold, italic, underlined, struck through, as code or in the option colors, in every view, row
    pages and published pages; sorting, filtering, grouping and exports use the plain value. Where
    the workspace has AI, the editor's *Describe it* writes a formula from what it should work out
    ("days left until the due date"), from the properties' names and types only, checks it and
    shows what it gives on the first rows before *Use formula*.
  - Number properties, formulas giving a number and rollups show as a number, percentage or amount
    of money (over 40 currencies in the menu, the one you last picked first and taken by the next
    new amount; MCP takes any ISO 4217 code), or as a colored bar or ring filled by the value
    divided by a number of your choice.
  - Ratings and durations are number properties in their own formats, offered as *Rating* and
    *Duration* when a property is added (or picked in a number's format menu). A rating shows 1 to
    10 stars (5 by default), clicked right in the cell, a form question or a row page (clicking the
    current star clears it); it holds a whole number from 0 to its stars, and averages show as
    "3.5/5". A duration holds minutes and shows as hours and minutes ("1:30", or "1:30:15" with
    seconds); type `1:30`, `1h 30m`, `1 saat 30 dk` or a number of minutes. Both filter, sort and
    add up as numbers, sums and rollups of durations show as durations, and CSV exports and MCP
    give the plain number (stars, or minutes).
  - Row pages show every property, or leave some out (always, or while they are empty) behind
    "N more properties"; the choice is the database's, for everyone, and while one property hides
    when empty, new ones start that way too. Text, number, URL, email, phone, ID and created or
    edited time values have a copy button beside them there. People with full access pin up
    to four properties into a strip under the title and show the others above the body or beside it
    where the page is wide enough.
  - Rows open in a side panel beside the view, which stays in use: the row's properties, body
    (edited together, with who's there), comments and menu, with the next and previous rows of the
    view (J and K), "Open as full page" and a copy link. The open row is in the address, so links
    and reloads open it again and Back closes it; the panel's width can be dragged and is kept per
    browser. Each view can open its rows in a centered window over the view instead (the same
    panel, closed with Esc or a click beside it), or as full pages; ⌘/Ctrl-click or a middle click
    opens a row in a new tab, and phones always open the full page.
  - Quick add: a new row's name can carry its date, people and options, as in
    "Send the offer friday @Ayşe #urgent". Dates are read in the interface language and in English
    (today, tomorrow, next tuesday, in 3 days, 12/31, 31.12.2026...) and go to the view's date
    property, or the first one; `@name` fills the first person property and `#option` any select,
    multi-select or status option (a dash stands for a space). What's recognised shows under the
    name while you type, and each part can be kept in the name instead.
  - Escape in a new row's name before anything is typed throws the row away; with a name typed it
    keeps the row.
  - Dates can have an end and a time of day ("Oct 12 → Oct 14", "Oct 12, 14:30 → 16:00"), shown in
    each viewer's time zone; filters match a range on every day it covers. In the date picker's
    month, Shift-clicking a second day makes the date a range.
  - Dates can be typed in words, the same way everywhere a date is typed: after `@` in a page, in
    the box on top of a date property's picker, a date mention's menu (its date and its reminder)
    and under a date filter's value. The box says what the words name as you type; Enter sets it.
    Words are read in the interface language and in English; case, spaces and commas don't matter.
    Without a clock the words name a **day** (the same day for everyone); with one, or as minutes
    or hours from now, a **time** in your time zone, which a date property keeps only with
    *Include time* on (else its day) and a date mention keeps as its reminder.
    - Days: `today`, `tomorrow`, `yesterday`, `next week`, `next month`, `friday` or `fri` (always
      the next one, a week on when it's today), `next friday` (in next week, counted from the
      week's first day in your language), `3 days ago`.
    - Dates: `aug 31`, `31 august`, `sept 10` (any first three letters or more of a month), with
      a year `aug 31, 2027`; `2026-08-31`; slash dates `10/28`, `28/10`, `10/28/2027`, read in
      the order of your language or of the date property's format (month/day/year or
      day/month/year), except when only one of the numbers can be a month; `15.10.2026`.
    - Times: `5pm`, `9:30 am`, `17:30`, after a date (`fri 5pm`, `aug 31 at 9 pm`, `yarın saat
      17:30`) or alone: today at that time, or tomorrow once it has passed.
    - From now: `30m`, `4h`, `in 3d`, `2 weeks`, `2mo` (minutes and hours give a time, days and
      longer a day; 31 January and a month is 28 February).
    - From the day shown: `+2w`, `-3d` count from the date the picker shows (the date mention's own
      date for its reminder: `-1d` is the day before), so `+1w` and then `-2d` step through days.
    - Refused rather than guessed: a bare number (`31`, `9`), a two-digit year (`10/28/27`), a day
      that doesn't exist (`feb 29 2027`), `in +2w`.
  - Calendar views show a month, with dates over several days as bars across them, or a week with
    its hours; a row is added on a day or at an hour, and dragging it moves its whole date.
  - Date, created time and last edited time properties show dates in the viewer's language as a
    full or short date, month/day/year, day/month/year or year/month/day, with times on a 12- or
    24-hour clock, in the app and on published pages (exports, CSV, the API and MCP keep ISO
    dates). They can also show dates relative to today ("Tomorrow", "In 3 days", "2 days ago", up to
    a week either way, the full date on hover). Date properties remind people of them: on the day, or 1, 2 or
    7 days before, at 9:00 in the time zone of whoever turned the reminder on. The reminder goes to
    the people of the row's person properties (else whoever added the row) who can see the row and
    the date, to the inbox, by email and as a push like other notifications. Rows that are done, in
    the trash or templates are left out, and dates that were already past when the reminder was
    turned on aren't announced.
  - Calendar subscription: a calendar view's address for calendar apps (iCalendar events at
    their times, else all day), from the view's sync button. It is personal and secret: each read shows what its
    owner sees in that view then (its filters, page and property access), so access taken away
    empties it. It is shown once; make a new one to replace it, or turn it off. Calendar apps
    check back about every hour. Like an API token it answers to the workspace's connected-apps
    switch rather than its sign-in policies: it stops while export or connected apps are off.
    The home page's "Assigned to you" section has the same kind of address for the rows assigned
    to you across the workspace's databases (those with a date you may see, done ones left out,
    at most the 1,000 assigned rows edited last) and the dated to-dos in pages that mention you,
    named after the workspace. Settings → Email and
    calendar lists every address you made, in every workspace, and turns any of them off.
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
  - Sprints: turned on from a view's settings with a sprint length (one to four weeks) and the first
    sprint's day, a task database gets a Sprints database beside it (each sprint with its dates and
    a state: current, next, future or completed), a "Sprint" property on its tasks and three views:
    the current sprint's board by status, sprint planning and the backlog. *Complete sprint* marks
    the current sprint completed, makes the next one current, plans a new next one of the same
    length and moves the tasks not done to the new current sprint, all at once; the current sprint's
    board follows on its own. Turning sprints off keeps the sprints database and every task's
    sprint, and turning them on again picks them up. The REST API completes a sprint too.
  - Charts over a date can show a running total, or what remains (a burndown): grouped by the day
    work was finished, each period takes its rows away from the whole, and rows without that date
    stay open. An automation that sets the date to today when a status changes to done fills it in.
  - Search a view from its toolbar: the rows whose name or values (option names, people, linked
    rows, checklist items, file names, text, numbers, links, formula results) hold every word
    typed, ignoring case and accents. The search is the viewer's own and isn't saved with the
    view; values hidden from them aren't searched.
  - Deleted properties and views can be restored: "Deleted properties" at the bottom of a view's
    Properties menu and "Deleted views" under the add-view button list them with who deleted them
    and when. A restored property comes back with its values and with what views, formulas and
    rollups said about it; both sides of a two-way relation go and come back together, unless the
    other side's database is locked or someone can't edit it: then only their side goes or comes
    back, and the two become one-way relations. They are deleted permanently with the trash, after the workspace's trash retention, or at once from the
    list. While deleted they don't show, export, search, take writes or trigger automations.
  - Select rows to edit a property, duplicate, export or trash them at once.
  - Row activity: under a row page's properties, who created the row and who changed its title or
    a value, from what to what ("Ayşe changed Status from In progress to Done · 2 hours ago"),
    newest first, whether in the app, in bulk, by a form, an automation, an agent, AI autofill, MCP
    or the API. Changes by the same person to the same value within five minutes are one entry, and
    one that ends where it started leaves none. A value AI autofill filled in reads as the AI's,
    naming who it was worked out for ("AI (for Ada) set Category to Billing"), and never merges
    into that person's own edits. Formulas, rollups and who/when values aren't recorded. Each
    viewer sees only the entries about values they may see in the row, linked rows they can't open
    aren't named, and entries about a deleted property come back with it. Text is kept with
    credentials masked; the activity goes with the row when it is deleted for good.
  - Form views collect answers as new rows, in the app or through a public link, signed in or
    anonymous. A question can be asked only when an earlier answer is or isn't one of some
    options, contains a text, is ticked or is empty; questions not asked aren't required and
    their answers are dropped, which the server works out again from the answers it gets.
    Multi-select, people, linked-row and file questions can take at least and at most a number of
    choices. A form can show people who signed in to answer what they sent through it (only its
    questions, never other rows or properties, even without access to the database); anonymous
    answers are never shown.
  - A form with more than one question can ask them *one question at a time* (in the form's
    builder, or `one_by_one` in the AI chat's `create_form`): each question gets a page of its own
    with a progress bar, Next checks its answer before moving on, Back returns to earlier answers,
    and questions asked only on some answers count once they apply. On the last page Next becomes
    Submit, and an answer the server refuses takes the person back to its question.
  - Put a database inside any page, or show a view of an existing one there. A table block turns
    into a database from its block menu: its first row names the properties.
  - Lock a database to freeze its properties and views, and export its rows as CSV. A view's tab
    menu exports just what the view shows as CSV, an HTML page or a PDF.
  - Row templates with preset properties and content; pick one as the default for "New", for all
    views or only for the view you are in (that view's "New" then starts from it, or from a blank
    row, while other views, forms, the API and MCP keep the database's default). A
    template's person can be *Me* and its date *Today* or *Now*: filled in with whoever adds the
    row and the day (in their time zone) or moment they add it, whether by hand, a button, an
    automation, a repeating template (as the person who set the repeat), the API or MCP (in UTC).
    Its title can hold `@today`, `@now` and `@me`, which become the day, the moment (in the
    maker's time zone, written in their language in the app and as ISO elsewhere) and the maker's
    name in each new row's title.
  - *Duplicate without rows* (the database's page menu) copies a database's properties, views,
    row templates and its own page, as an empty database to fill anew. Relations, forms and access
    rules come along as with *Duplicate*; automations stay with the original either way.
  - Repeating templates: a row template adds a row by itself every day, every few weeks on chosen
    weekdays, every month or every year, at a time in a time zone, optionally with the date in its
    title. The rows are added as the person who set the repeat, with their access at the time, and
    start the database's "row added" automations. If that person can no longer add rows (or their
    account is gone) the repeat pauses and the template menu says why; anyone who can add rows sets
    it going again, as themselves. A server that was down adds one row for the runs it missed (dated
    the first missed day when the title carries the date), not one per run. Nothing is added while the database is in the trash. The first day of a monthly or
    yearly repeat sets its date; months without that day use their last day.
- **Database automations**: when a row is added, a property changes (or changes to a given
  value), a date of a row is some days past (optionally only for rows in some status groups), a
  schedule comes round or another service POSTs to the automation's secret address, do up to 20
  steps: set properties, notify people with a message, send the row to a webhook signed with
  HMAC-SHA256, post to a Slack channel, run an agent, move the row to the trash, send an HTTP
  request, find rows, create a row (optionally from one of the database's row templates) or update
  the one that matches, wait, ask people for approval, celebrate with confetti for whoever made the
  change (the ready-made *Celebrate finished rows* does it when a row is marked done), or log.
  *Slack notifications* in a database's ••• menu makes one that posts when a row is added or a
  property changes (to a value) in two steps. Steps go for each row an earlier step found
  and use the trigger's and earlier steps' values through `{{templates}}`. Changes can wait in a
  draft, be tried with a test run and be published as numbered versions, and a 30-day run history
  shows each step's input and output (see [Automations and webhooks](automations.md#automations-and-webhooks)).
- **Agents**: AI helpers with instructions of their own that automations run on database rows,
  that owners ask for a task over the REST API or MCP, or that members mention in a comment to
  have them answer in its thread. Each acts as a user of its own that sees
  only the pages shared with it (from its settings or the page's Share menu), and its changes and
  comments show its name. Agents follow the skills they're given, keep a memory whose notes an
  owner reviews before they count, and show their monthly usage, with an optional token limit;
  their changes to rows, and the emails they draft, can wait under *For review* for a person to
  approve (see [Agents](agents.md#agents)).
- **Connections**: link a workspace to any remote MCP server (Slack, GitHub, a CRM, another
  Leafdesk) so agents, and the AI chat for the tools owners tick *In chat*, can use its tools:
  for agents, reading tools run at once, anything else waits for an
  owner's approval in the inbox; signed events from the service can start agents, whose every call
  waits for approval unless an owner trusts what that trigger's service sends (see
  [Connections](connections.md#connections)).
- **Daily notes**: one page of your own for each day. The sidebar has three tabs, *Home* (your
  pages), *Journal* and *Chat* (your AI conversations), each coming back to where you last were in
  it. *Journal* (or the home page) opens today's note, made the first time, in your own time zone;
  its month calendar marks the days that have a note and opens any day's, it lists the notes
  (newest first), and a date mention's menu has *Open that day's note*. Notes are private pages
  kept out of your page list, so nobody else sees them unless you share one. New notes start with
  a few headings, blank, or from one of the workspace's page templates, as you pick at the bottom
  of the calendar. A note in the trash no longer counts:
  opening its day makes a new one. Guests can keep one only where they may add private pages.
- **Templates**: save a page or database (with its subpages) as a template and create new pages
  from it, or start from built-in templates for meeting notes, a weekly plan, a project tracker, a
  wins log (a dashboard of wins by month, type, area and impact over the database that holds them),
  a small business (customers, the quotes given to them, jobs and a balance sheet, linked to each
  other, with a dashboard over all four and a weekly plan; a new workspace can start with it),
  sprints (a page holding a task database with two-week sprints turned on: a board by status, the
  current sprint, sprint planning and a backlog, with example tasks in them) or docs (a doc library
  with a category, an owner and the last edit, on a board by category and sorted by the last edit,
  with example docs, two of them verified by you for three months).
  Templates stay out of the sidebar, search, trash and published sites.
- **Build with AI** (with AI set up): describe what you want to keep track of and AI drafts the
  databases for it, with typed properties, options, relations between them, a few views and example
  rows; you rename or remove what you don't need before anything is created (see
  [Building databases with AI](ai.md#ai-features)).
- **Comments**: select text and comment on it; reply, react, resolve and reopen threads, live for
  everyone on the page. People who can comment on a page (or edit it) write comments and viewers
  read along; full access also deletes other people's comments. On a database row, each property
  value takes threads of its own: the comment button beside a value (with how many open threads it
  has) starts one, and the comments panel lists them under the property's name. Only people who
  see that value read, write and hear about them (a row's access counts too), and a deleted
  property's threads come back when it is restored. The comments panel lists open, resolved,
  marked or all threads, newest comment first (or in the page's order), with *New* on those others
  wrote in since you looked, and with its person picker only those someone started or replied in.
  A thread's menu has *Come back later*, a mark only you see that the *Marked* filter lists, and
  *Mute replies*, which keeps its new comments from reaching you until you reply or are mentioned
  there. A comment can carry up to ten images (the image button under the box, or paste or drop
  them), shown as thumbnails that fold past four; a comment of just a few emoji shows them large.
- **Suggested edits**: switch the page header from *Editing* to *Suggesting* and changes show as
  suggestions instead: inserted text underlined, deleted text struck through but kept, new
  formatting marked, live for everyone. Each is a thread in the comments panel, in its author's
  name, which people who may edit accept or reject (one at a time, or all from the page menu) and
  its author withdraws. People who may only comment always suggest: their connection to the page
  takes their own suggestions and nothing else, checked by the server on every change (it compares
  the page with their suggestions taken back before and after), so they never edit the page itself.
  A pending suggestion isn't part of the page anywhere else: Markdown, search, published pages,
  PDF and print, exports, history, MCP, the REST API and the AI read the page without it, and server
  writes keep the suggestions of blocks they leave as they were. Watchers hear about new
  suggestions like new threads; authors hear when theirs are answered. The writing assistant can
  apply its text as suggestions, marked as the AI's.
- **Mentions and page links**: `@` mentions people (those with your email domain first), groups of the workspace (each member who can
  open the page is notified as if mentioned by name; hovering the mention lists them; Markdown
  writes it `@Group name`), pages (with their live title, or "No access")
  and dates with optional reminders, typed in words (`@next friday`, `@aug 31`; with a time,
  `@fri 5pm`, the date gets a reminder then; see the dates under *Databases*). Resting the pointer on a page mention or a link to a page, in
  the editor or a comment, shows a card with its place, last edit and first lines (a row's first
  values), only to people who may open it; `[[` links to a page, or to a new page inside this one with
  the title typed, and `[[Title]]` typed, pasted or written through MCP and the API links to the
  page of that title; `+` after a space does the same the other way round, a new page inside this
  one with the typed title first (a number or a space right after it stays text, `+90`, `a + b`);
  the formatting toolbar's link button (Cmd/Ctrl+K) takes a web address or searches pages, so the
  selected text links to a page, or to a new page made with it as the title; "Turn into page in…"
  in a block's menu makes the block (or the selected blocks) a page inside this one, under another
  page or as a row of a database, the first block's text as its title and a link to it in their
  place; "Link to page"
  blocks (their block menu opens the page in a new tab); a "Linked from" list of backlinks on
  every page, with how many pages link there and, for each, the text around every place it links
  (the first 20 blocks), each opening that page at the block with the link; and below it the pages
  that write the page's title without linking to it, with a button that turns that text into a
  mention (a Japanese or Chinese title is found inside a sentence too, never inside a longer word).
  The page's ••• menu sets where its backlinks show: below the page, in a popup under the title, or
  hidden (for everyone, like the page's typeface).
  Under them, *Related pages* lists up to five pages close in meaning to this one that it doesn't
  link to and isn't linked from (nor its parent or subpages), each with when it was last edited and
  its closest passage, opening the page there: an old page on the same subject comes back where it
  is useful. They come from the embeddings semantic search already keeps, so nothing is sent to a
  model; without an embeddings model, or with AI off for the workspace, the list doesn't show
  (see [Semantic search](ai.md#semantic-search)).
  "Copy link to block" in a block's menu gives a link that opens the page at that block,
  highlighted, in the editor, on published pages and in the print view; pasted into a page it
  becomes a mention of that block, a backlink like any other, and Markdown over MCP and the API
  keeps it as `[Title](/w/<workspace>/p/<page>#block-<id>)`.
  Several links to pages pasted together (one per line, or on one line) become a mention each:
  one per line makes a block each, in a list when pasted into one. *Copy links* in a table's
  selection bar copies the selected rows' links one per line, ready to paste that way.
- **Synced pages**: a block that shows another page's body inside this one, live. People who may
  edit that page edit it right there, alongside everyone else on either page; people who may only
  view it read it; people who can't open it see "No access", as a mention shows them. Its text
  stays that page's own: search, history and Markdown of the page showing it hold one line for it,
  a page showing itself (or a loop of pages) is shown once with a link, and published pages show
  the block as a link.
- **Synced blocks**: a few blocks kept on one page and shown live on others. *Turn into synced
  block* in a block's menu (or `/synced block`) wraps them; *Copy synced block* and a paste on
  another page add a reference that shows them as they are now. People who may edit the original
  page edit them right there, people who may only view it read them, and people who can't open it
  see "No access" and nothing of them; a reference says so when the original page is in the trash
  or deleted, or when the blocks were removed from it, and keeps working when that page moves. The
  original lists the pages showing it, *Unsync* turns a reference into a plain copy, and a synced
  block can't go inside another. Published pages, Markdown and PDF exports and `get_page` over MCP
  show the blocks with the same rules (a published page only when the original is published too).
  Markdown written over MCP, the REST API or *Edit as Markdown* writes what changed between a
  synced block's marker lines to its blocks, where the writer may edit the original page (saving
  that page to its history first); otherwise they stay as they are, and a synced block written with
  nothing between its lines is only placed, as are synced blocks in imported Markdown. Tables written as Markdown keep their column widths,
  header rows and columns, cell colors and alignment, which Markdown has no form for. Search, by words or by meaning,
  finds them on the original page only, and its history shows their changes.
- **Graph**: every page someone can open in a workspace as a point, joined by the links between
  pages, database relations and the page tree, laid out by how they connect. It is beside a page
  ("Show in graph" in a page's menu: the page and the pages up to three steps from it), and the
  whole workspace's graph opens from there or from search (*Graph*). The whole graph starts with
  the pages joined by links and relations, and says how to add some when there are few; switches
  show the page tree, database rows and pages without connections. A database with many rows is
  one point with their count until you show its rows; a row related to a page in view is drawn on
  its own, and the rest's relations as one weighted edge. Hover a page to see its neighbours, click
  it for a card of everything it is joined to, double-click to open it.
- **Inbox**: a notification when someone assigns you to a row, shares a page with you, replies in
  a comment thread you're in or mentions you, asks for access to a page you manage, when a
  database automation notifies you, when someone else changes a row you follow, when someone
  reacts to a comment you wrote (more reactions to it gather in one item, never sent by email),
  and when a reminder you set is due, with an email a little later. Comments and
  reactions on one page within a few hours, or edits to one page or row, show as one entry ("5 new
  comments, 1 new reaction") that opens to the single ones. You follow the database rows you
  created, are assigned to through a person property, commented on or were mentioned on; *Follow*
  and *Stop following* in a row's page menu change that for any row you can open. A row's update
  waits until its author has left the row alone for a minute (ten minutes at most), so a burst of
  edits is one item, and says what changed: "Status: To do → Done", a new title, edited text. You
  hear only about the properties you may see in the row, checked again when the inbox or the email
  shows it, and never about your own changes. Pages work the same way: you watch the pages you
  created or edited, and anyone can *Watch* or *Mute* a page from its ⋯ menu, or watch every page of
  a teamspace from the teamspace's menu in the sidebar; a mute wins over all of these. Watchers hear
  when someone else edits the page (once the author has left it alone for two minutes, fifteen at
  most) and when a new comment thread starts on it, unless they have the page open at the time.
  Emails about the same page come at most every four hours, and after five in a day the rest wait
  and come together in one digest. My account → Preferences lists the pages and teamspaces you
  watch. Owners also find there an agent's call waiting for approval and the notes an agent's run
  proposed for its memory, and the person an agent's run worked for hears of the changes it proposed
  for review (see [Agents](agents.md#agents)). A comment notification opens the page with that thread
  selected. Snooze an item for an hour, until tomorrow morning or until next Monday (9:00 your
  time): it leaves the inbox and comes back unread then, along with its email if that hadn't gone
  yet. On a phone, swipe an item toward the end of the line to mark it read (or unread again) and
  toward its start to snooze it until tomorrow morning. Archive an item, or every read one at once
  (*Archive read*), to clear the inbox: archived items are read, listed under *Archived* and can be
  moved back. Choose per kind whether it shows in the
  inbox, whether it comes by email and, on the devices where you turn them on, as a [push
  notification](self-hosting.md#push-notifications).
- **Verified pages**: someone with full access marks a page, database or row as checked and right
  from the page's `⋯` menu, for a week, a month, three months or a year, until a day they choose,
  or with no end. Under the title a badge says who verified it and until when, and once that day
  passes, that the verification expired; editing the page keeps it verified. The verifier hears
  three days before the end and when it comes (in the inbox and by email, as they choose under
  *Pages you verified* in Settings > Preferences). Search ranks a verified page above an otherwise
  equal one and marks it, and `is:verified` lists only verified pages; the AI chat is told which
  sources are verified, prefers them where sources disagree, and its citations show the mark.
  MCP's `get_page` and `search` and the REST API's pages say `verified` (who, when, until, and
  whether it expired), and MCP's `update_page` and the REST API's `PATCH /pages/{id}` take
  `verified` (`week`, `month`, `quarter`, `year`, a day, `forever`, or `none` to remove it).
  Settings > Health lists the pages whose verification expired. Templates and pages in the trash
  aren't verified, and published pages don't show verification.
- **Page history**: versions are saved automatically while you edit and before every AI edit.
  You can preview and restore any version (those of the last week listed as "2 hours ago" or
  "yesterday", older ones by their date, the exact time on hover), and see what changed since it or
  since the version before, and who (or which AI app) changed it. People who can edit a page save a
  version themselves with *Save version* in the history or Cmd/Ctrl+S on the page, giving it a name
  if they like ("Sent to legal"); when nothing changed since the newest version, that one gets the
  name instead of a copy being saved. Any version can be named, renamed or have its name cleared
  (an empty name) from the history, where a named version shows its name and *Named versions only*
  lists just those. Named versions are kept as long as the page: the daily history cleanup leaves
  them, and they don't count toward its limit of versions per page. Pages in the trash can't be
  saved or named; locked pages can. MCP's `get_page_history` and the AI chat give a version's
  `name`. Changes an AI app, the chat or an agent writes to a
  page's body can be kept or undone block by block (see
  [Reviewing AI changes](ai.md#ai-features)).
- **Teamspaces**: group pages and people. Every workspace starts with a *General* teamspace
  everyone is in. A teamspace is **default** (everyone is in it, now and later, and can't leave),
  **open** (anyone sees it and can join; until they do, they read and comment on its pages),
  **closed** (anyone sees it, only its members open its pages, its owners add them) or **private**
  (only its members know it exists, workspace owners included). The sidebar has a section per
  teamspace you're in, a *Shared* section for pages shared with you from elsewhere and a *Private*
  section for pages only you see. Settings → Teamspaces lists them with filters, their members and
  owners, the default teamspaces and whether members may create teamspaces. Moving a page to
  another teamspace, or to Private, gives it the access of its new place; people it was shared
  with by name keep theirs. *Turn into teamspace* in a page's ⋯ menu (full access to the page and
  the right to create teamspaces) makes a teamspace named after the page: the page and the pages
  right under it become its top-level pages; whoever turns it and those with full access to the page
  own it, those who could edit join as members (and groups that could edit, as groups), members
  can edit its pages, and everyone else named on the page (viewers, commenters, guests) keeps what
  they had. A sub-page whoever turns it may not manage (no full access) moves too but keeps its own
  sharing: one closed to everyone else stays closed in the teamspace. A top-level page of a teamspace
  whose top level is locked can only be turned by those who may arrange it. It is private when the
  page was private or in a private teamspace, closed when it was in a closed one, open otherwise. Guests are never in teamspaces: they get single pages. Those who
  manage a teamspace that isn't default can type an email into its *Add members* field: someone
  already in the workspace is added, anyone else is invited to the workspace as a member with the
  teamspace (and the role picked) in the invitation, and joins both on accepting. It goes through
  the workspace's own invitation rules (who can add members, approval, allowed domains, sign-in
  policies), and inviting the same address again keeps the teamspaces of the first invitation. Each teamspace
  sets what its members get on its pages (full access, can edit, can comment or can view) where a
  page isn't shared otherwise; its owners and workspace owners get full access, and so does
  whoever adds a page at its top. Below full access, members are held to the database property
  access rules too. Those who manage a teamspace can *Lock top-level pages* in its settings: then
  only they add, move, reorder, trash or restore the pages at its top, while members keep working
  in and under them as their access allows. Adding a page at the top of a teamspace of ten people
  or more asks first, once per teamspace in each browser, since it is in front of all of them.
- **Sharing and permissions**: give people, or everyone in the page's teamspace (the workspace
  for a private page), full, edit, edit content, comment, view or no access to a page. *Can edit
  content* writes the body, title and icon, adds and fills in rows and moves them to the trash, but
  doesn't change how the page is set up: a database's properties, views, automations and row
  templates, locking, moving or sharing it. Subpages inherit it
  unless you change them; pages nest at most 60 levels deep, so what is set above a page always
  reaches it. Share a page with someone outside the workspace by email and they join
  as a guest who sees only the pages shared with them (an account whose address was never
  verified is invited by email, like someone without one). Someone who opens a link to a page they
  can't see can request access, and someone who can view or comment on a page can ask to comment
  or edit from its Share panel; the people with full access see what was asked, approve it at that
  level or another one above what the person has, or decline it, from their inbox or the Share
  panel (owners can turn requests off in Settings → Security).
  The Share panel shows everyone who can view the page who has it; access inherited from a page
  above names that page only to those who can open it, and guests see people's names but not
  their email addresses, and that a group has access but not which one.
  A database's *Row access* (its ⋯ menu, full access) lets rows give the people in a person
  property, or their creator, view, comment, edit or full access to those rows, and can show each
  row only to the people it names (people with full access to the database still see every row);
  search, the sidebar, the API, MCP and the AI chat follow it.
  Someone who leaves the workspace, or is removed from it, loses what it gave them by name: their
  access to pages and properties, their calendar feeds of it and API tokens made only for it
  (pages only they could manage, and teamspaces nobody else runs, pass to someone first). An owner
  removing a member picks who receives them in the dialog, which says how many pages that is (the
  owner by default; any member or owner who stays); someone leaving hands them to the oldest owner,
  and so does the identity provider. The audit log records who received how many. Coming back
  starts afresh.
- **Property access**: people with full access to a database decide, from a column's menu, who
  may see and change that one property: everyone with access to the database can edit it, edit
  only its values, view it, see only that the column exists, or not see it at all, with
  exceptions for people, groups and whoever a person property of the row names (their own rows).
  The widest rule wins, nobody gets more than their access to the database, and full access is
  never restricted. Restricted values stay out of every view, row page, formula, rollup, filter,
  search, AI answer, export, copy, published page, MCP and REST reply of people they are hidden
  from, and their writes are refused. AI autofill never reads a restricted property, nor a
  formula or rollup reading one (of the row or of related rows), whoever asks: the text it writes
  can be read by people the value is hidden from. Nor does it read relations, rollups or people
  properties (or formulas reading them), which can name rows and people its readers can't open. Relations and the created/edited by/time
  properties can't be restricted.
- **Member groups**: workspace owners and membership admins gather members into groups (Settings → Groups) and share a
  page with a group, or add it to a teamspace, the way they would with a person. Everyone in the
  group gets that access for as long as they are in it; when a page has entries for someone and
  their groups, the highest level wins. Guests can't be in groups, and people leave their groups
  when they leave the workspace or become guests. The member list shows each person's groups.
  An identity provider can manage groups over SCIM.
- **People directory and analytics**: a *People* page with a card for each owner and member (their
  teamspaces, groups and recently edited pages, as far as the viewer may see them), and, for
  owners, Settings → Analytics: active members, edits per person and the most edited pages over
  7, 30 or 90 days, with CSV export, counted from page history and last edits. While page views
  are recorded (on by default; owners turn it off there, and each person can opt out under
  Settings → General) it adds views, unique viewers, views per person and the most viewed pages,
  and each page's menu has *Analytics* for people who may edit it: views per day, who opened it
  and who edited it. A view is an owner or member opening a page, database or row in the app,
  kept as one count per page, person and day for a year; guests, agents, API and MCP clients and
  published pages are never recorded.
- **Workspace health**: Settings → Health, for owners and members, checks the pages each person
  can open for what is worth tidying: links and mentions to pages in the trash or deleted, top-level
  pages nothing links to, pages with a title and no body, pages nobody edited for 3, 6, 12 or 24
  months, pages whose verification expired, pages that say nearly the same thing (compared by
  their embeddings, when the server has an embeddings model and the workspace has AI on),
  relations to rows in the trash or deleted, and web links that stopped working.
  *Broken web links* are the web addresses in pages' bodies (links, bookmarks, embeds, bare
  addresses; not images or code) and in rows' URL properties: each check asks about the addresses
  of the pages it looks at (up to 2,000), and the server fetches them in the background (HEAD, then
  GET if that gets an error), a few at a time and at most three of one site a minute, through the
  same guard as saving a web page. A 404 or 410 answer is listed at once; a site with no address,
  no answer or a server error only after three checks in a row a day or more apart, and answers
  that just refuse the checker (401, 403, 429) count as working. Working addresses are checked
  again after a week, broken ones after three days; addresses no check asked about for 60 days are
  forgotten. The first check says how many are still waiting. `WEB_LINK_CHECKS=off` stops the
  server from fetching them (see [Self-hosting](self-hosting.md)).
  Where it can, a finding has a one-click fix: restore the page, link the orphan where another page
  writes its title, move the empty page to the trash, take the dead row out of the relation. The
  MCP tool `check_workspace` returns the same report.
- **Audit log**: for owners, Settings → Audit log lists who changed what in the workspace (members
  and roles, invitations and join requests, page sharing, teamspaces and groups, settings with
  their before and after, single sign-on and SCIM, pages and databases created, duplicated,
  imported, moved, put in the trash, restored and deleted for good, publishing, API tokens and
  connected apps, exports), with the app or identity provider it went through and the address it
  came from, and for page events who could reach the page at that moment (private, specific
  people, a teamspace by name, the whole workspace or the web), newest first, filtered by person, kind of change and dates, and as CSV. Events are
  kept for a year. Owners can stream new events to their security tools as they happen, and
  scripts read the log through the REST API (see [Audit log streaming](account-and-security.md#audit-log-streaming)).
- **Sensitive content detection**: when owners turn it on in Settings → Security, pages and rows
  are read in the background for payment card numbers, IBANs, national ID numbers and secrets
  (private keys, access tokens), and what is found is listed to owners with a masked excerpt (see
  [Sensitive content](account-and-security.md#sensitive-content)).
- **Legal holds**: owners put a named hold, with its reason, on people of the workspace (members,
  guests, or people who have left) in Settings → Security. While it stands, nothing they created
  or edited there is deleted for good: their pages and rows (and pages above them, with their
  history, comments and files) can go to the trash and come back, but *Delete forever*, the trash
  and history retention, the file cleanups, deleting templates, deleted properties' values and
  comments keep them or refuse with a message, and neither the workspace nor their accounts can be
  deleted. Setting and releasing a hold is in the audit log.
- **Publish to the web**: a read-only public link for a page and its subpages, kept out of search
  engines unless you allow them. Published databases show the views you pick (tables, boards,
  lists, galleries) and visitors switch between them; their browsers get each property's name,
  type and how its values show, never a formula's expression, an AI autofill prompt or a
  reminder. A published link can have an expiry: once it passes, the link, its subpages, the
  files they show and the workspace site treat the page as unpublished, until someone extends or
  removes the expiry in the Publish panel (Settings → Security lists links with their expiry, and
  setting or removing one is in the audit log). Owners decide whether members may publish,
  can take any published page offline, or turn publishing off for the whole workspace (see
  [Workspace security switches](account-and-security.md#workspace-security-switches)).
- **Workspace site**: owners give the workspace's published pages one readable address
  (`/s/<slug>`) with a home page and a navigation of the pages listed in it; pages get addresses
  like `/s/<slug>/getting-started-<id>`, and links between listed pages stay on the site. Pages
  are listed only when someone chooses to, so a page shared by link stays unlisted; each keeps its
  own link and search-engine setting. Owners pick the site's theme (light, dark or the visitor's
  system), put up to six links in its header (to listed pages or web addresses), give it a default
  search description (each published page can have its own, shown with the title as the meta
  description and in Open Graph and Twitter link previews), and may add a Google Analytics 4
  measurement ID, used only on the site's own domain. The site's favicon is its home page's emoji or built-in icon, drawn as SVG by the server. A site
  can also have a domain of its own (see [Workspace site on its own domain](../README.md#workspace-site-on-its-own-domain)).
  A publication can also **allow duplicate**: signed-in
  visitors copy the page, as published, into one of their workspaces (or its templates), files
  included and without comments, history, people or private properties; of a database, only the
  rows its views on the web show.
- **File uploads**: drop, paste or pick images, video, audio and other files into a page. They are
  stored on disk or in S3-compatible storage, only people who can see a page showing them can open
  them, and published pages show theirs (see [File uploads](self-hosting.md#file-uploads)). Uploaded PDFs show
  in place, and so do Excel workbooks (.xlsx), read-only, a sheet at a time; an editor can turn one
  into a database. Search finds pages by the words of the PDFs, Word documents and Excel workbooks
  they show. Any uploaded file opens full screen in the file viewer, with ← and → for the page's
  other files: images zoom, Word documents, CSV, Markdown, JSON, code and text show their
  contents, and the rest offers a download. An image can link to a web address or a page of the
  workspace (*Link…* in its block menu): in the editor a small button on it follows the link,
  while read-only and published pages and the print view make the image itself the link, and
  Markdown keeps it as `[![alt](image)](link)`. An image can be cropped too (*Crop…* in its block
  menu): the part to show is kept with the block and the file stays whole, so the crop can be
  changed or removed later. The editor, published pages, the print view, HTML exports and PDFs show
  the part; Markdown has the whole image, and writing a page's Markdown back keeps the crop of each
  image whose file didn't change.
- **Import**: bring in Markdown files, a folder or a ZIP as pages that keep their folder
  structure, with links between the files turned into page links and the images they show
  uploaded, into the page or teamspace you start it from. A link naming a file by its bare name
  (`[Plan](Plan.md)`) finds it elsewhere in the upload when nothing sits at that path. A Leafdesk
  export comes back as it went, templates included. Import a CSV file as a new database with its column types guessed (and
  changeable before importing), or add its rows to an existing database by matching columns to
  properties. Files whose path is longer than 2,048 characters or 100 folders deep are left out
  (and listed in the result). Each person runs one import at a time; starting another while one
  is still reading its files asks to wait for it.
- **Import from Word**: choose one or more `.docx` files on Import's Word tab; each becomes a
  page. A heading (or Title paragraph) at the very top becomes the page's title, otherwise the file
  name does. Headings (levels past the third as the third), bold, italic, underline,
  strikethrough, links (web and email only), bulleted and numbered lists with their nesting, tables
  with a header row, quotes, monospace paragraphs (as code) and footnotes and endnotes (as the
  page's footnotes, their notes as plain text) come along; pictures inside the document are uploaded to the page. Pictures linked from outside
  the document, of types pages don't show (such as Windows metafiles) or over the upload limit are
  left out and listed in the result; comments and page breaks are dropped. Old `.doc` files need
  saving as `.docx` first. A document is read in a separate worker with a time and memory limit,
  and one that can't be read stops the import before any page is created.
- **Import from Google Docs**: on Import's Google Docs tab, documents come in through the
  workspace's **Google Drive** connection (Settings → Connections, from the catalog). Paste links
  to documents (`docs.google.com/document/d/…`, or Drive's `/file/d/…`), or search the
  connection's Drive by words in the title (no words lists the latest documents) and tick up to 20.
  Each is exported by Drive as a Word document and imported as above: one page per document, the
  heading at the very top or else the document's name as its title, pictures uploaded, all or
  nothing. A connection is one owner's Google account, so owners may import through any signed-in
  Google Drive connection; members only through one whose `download_file_content` tool an owner
  ticked *In chat* (they could already read the same files through the AI chat), and search only
  with `search_files` ticked too; guests never. Each call to Drive is recorded in the audit log
  like the chat's, and the import as from Google Docs. A Google Docs connection alone isn't
  enough: the export is Drive's. Tested against a stand-in Drive server
  (`scripts/google-docs-import-e2e.ts`), with Google's answers as its MCP server gives them.
- **Import from PDF**: choose one or more PDFs on Import's PDF tab; each becomes a page made of
  its text layer, read by the same reader search uses for PDFs. A PDF has no structure of its own,
  so it is read from the layout: the size most of the text has is the body's, and short lines in a
  larger size become headings (the largest size a first-level one, then second and third); lines
  close under each other join into paragraphs (a word hyphenated at a line's end is joined again),
  and a paragraph that runs over a page break stays whole; lines starting with a bullet character
  or a number (`1.`, `1)`) become bulleted or numbered lists, nested by how far in they stand.
  What recurs at the top or bottom of most pages (running headers and footers) and page numbers
  there are left out. A heading at the very top becomes the page's title, otherwise the file name
  does. With *Also attach each PDF to its page* (on by default) the PDF itself is uploaded and
  shown at the end of the page, for its pictures, tables and layout; one over the upload limit is
  left off and listed in the result. Bullets drawn as shapes rather than characters, bold and
  italic, links, tables and columns side by side don't come through as such (columns are read
  line by line across). A scan without a text layer is refused with a note to run text
  recognition (OCR) first; so are PDFs over 25 MB or 500 pages, and damaged or password-protected
  ones. As with Word, one that can't be read stops the import before any page is created.
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
- **Import from Confluence**: in Confluence, open a space's settings and choose *Export space →
  HTML*, then pick the downloaded ZIP on Import's Confluence tab. Each page of the space becomes a
  page, nested as the space's index lists them (a page it leaves out goes under the parent its
  breadcrumbs name); a space with one top page comes in as that page, otherwise a page named after
  the space holds the top pages. Headings, formatting, lists, tables, links and quotes come along;
  info, note, tip and warning panels become callouts in their colors (with their titles), the code
  macro a code block in its language, expand sections toggles, task lists to-dos, the table of
  contents a table of contents and emoticons emoji. Links between the space's pages become page
  links, pictures and linked attachments are uploaded to the page under their own names, and a
  link to a page the export doesn't hold keeps its text and is reported. Other macros keep the
  text they show. The export's HTML is read without running its scripts or loading anything.
- **Import TextBundles and TextPacks**: Bear, Ulysses, iA Writer and other Markdown apps export a
  note as a TextBundle (a `Name.textbundle` folder holding `info.json`, the text as `text.md`,
  `text.markdown` or `text.txt`, and an `assets/` folder) or a TextPack (the same, zipped). Choose
  `.textpack` files, a ZIP of them (alongside other Markdown, as in any ZIP), or a folder holding
  `.textbundle` folders on Import's Markdown tab. Each bundle becomes a page beside the upload's
  other files, titled by the heading its text starts with (which then leaves the body), else by the
  bundle's name; its text is read as Markdown, and the pictures and files of its `assets/` folder
  that the text shows are uploaded to the page, as for any Markdown note. Assets the text doesn't
  show are listed in the result; `info.json` is left out. A link from one bundle to another leads
  to that bundle's page.
- **Import from OneNote**: OneNote's own `.one` and `.onepkg` files can't be read outside OneNote,
  so export first: in OneNote for Windows, choose *File → Export*, then *Page* or *Section* and
  *Single File Web Page (\*.mht)*, and pick the saved files on Import's *OneNote (.mht)* tab. A
  page's file becomes a page titled by the page's title, with its date and time as the first line;
  a section's file becomes a page named after the file (OneNote names it after the section) with a
  page under it for each OneNote page, in order. Headings, bold, italic, underline, lists, tables,
  web and mail links and pictures come along; pictures are uploaded once each, and a picture shown
  on several pages points at the one upload. OneNote's tag icons (to-do boxes and the like, exported
  as tiny pictures), its "Created with OneNote" line and links between OneNote pages are left out.
  A file whose pages don't have the shape OneNote writes comes in as one page. OneNote's *Word
  Document (.docx)* and *PDF* exports can be imported on the Word and PDF tabs instead. Any other
  web page saved as one file (`.mht` or `.mhtml`, by a browser or Word) is imported on the same tab
  as one page, titled by a first-level heading at its very top, else its `<title>`, else its file
  name, with all of its body (menus included: it isn't trimmed to its article as *Save from web*
  does). The file is read as a MIME message (`base64` and quoted-printable parts, each text in its
  character set) and its pictures are found by `Content-Location` or `cid:`; nothing it links to
  outside the file is fetched (such pictures are left out and reported), its HTML is read without
  running scripts or loading anything, and only what pages can hold survives. Tested against files
  written by hand in the shape OneNote's export has, not yet a real export.
- **Import from Evernote**: in Evernote, select notes or a notebook and choose *Export → ENEX*,
  then pick the .enex files (or a ZIP of them) on Import's Evernote tab. Each export becomes a
  database named after its file, with a row per note: tags become a multi-select, the creation and
  update times dates (Evernote writes them in UTC), the author and source URL a text and a URL
  property. The note's content becomes the row's page: headings, bold, italic, underline,
  strikethrough, highlights, web and mail links, nested lists, to-dos as checklist items, tables,
  code blocks, quotes and dividers. Pictures are uploaded as images and other attachments as files,
  where the note shows them (attachments it doesn't show go at the end). Encrypted text can't be
  read without its passphrase and is replaced by a line saying so; links to other notes keep their
  text only. The export is read with a strict XML reader that refuses a DOCTYPE declaring entities
  and never fetches anything; a note whose content isn't well-formed is skipped and reported.
- **Import from Trello**: in Trello, choose *Print, export and share → Export as JSON* in the
  board's menu, and pick the downloaded file on Import's Trello tab. The board becomes a database
  that opens on a board view grouped by list: lists become a select property in the board's order,
  labels a multi-select in the nearest colors, members people when exactly one person in the
  workspace has their name (the export has no email addresses) and text otherwise, start and due
  dates one date (a range when both are set), checklists one checklist per card, and custom fields
  properties of their own type. A card's description becomes its row's body, followed by its other
  attachments and its comments, each under its author and time (comments can't be posted in
  someone else's name). Links between cards lead to the imported rows. Nothing is downloaded from
  Trello: the first linked attachment goes in a Link property, files uploaded to Trello stay links
  to Trello, and images in descriptions become links. Archived lists and cards are left out and
  counted before importing. Trello's export holds only a board's more recent actions, so the oldest
  comments of a busy board may be missing.
- **Import from Asana**: in Asana, choose *Export → CSV* (or *JSON*) in the project's menu, and
  pick the downloaded file on Import's Asana tab. The project becomes a database named after it
  that opens on a board view grouped by section: sections become a select in the order they come,
  completion a status (to do or done), the assignee a person when exactly one person in the
  workspace has their email address (by name when the export has no address) and text otherwise,
  start and due dates one date (a range when both are set), tags a multi-select, and custom fields
  properties typed by their values (number, date, select and so on; the JSON export says their
  types and option colors itself), which the Import dialog shows and lets you change before
  importing. Subtasks become sub-items of their task, and *Blocked By* and *Blocking* the
  database's dependencies; both find tasks by id, else by name when exactly one task has it. Notes
  become the row's body, where links to tasks of the project lead to their rows; the JSON export's
  comments follow under their author and time and its attachments as links (nothing is
  downloaded). *Created At*, *Last Modified* and other projects a task is in are left out and
  listed in the result, as are parents and dependencies that name no task of the export. Tested
  against files built from Asana's documented export format, not yet a real export.
- **Import from Monday.com**: in Monday.com, choose *Export board to Excel* in the board's menu
  (with updates, if you want them), and pick the downloaded `.xlsx` (or its sheet saved as CSV) on
  Import's Monday.com tab. The board becomes a database named after it that opens on a board view
  grouped by group, and subitems become sub-items of their item. The export doesn't say what kind
  each column is, so it is guessed from the column's name and values, shown in the Import dialog
  and changeable there: *Status* (and Stage, State) becomes a status whose labels are options (Done
  and the like done, Working on it and Stuck in progress, others to do); Person, People, Owner and
  the like people, matched by name when exactly one person in the workspace has it (text
  otherwise); dates a date, timelines (`2026-10-01 - 2026-10-05`) a date range, numbers a number,
  Tags and Dropdown a multi-select, links a URL (the address, without its text), email addresses
  and phone numbers their own types, `v` checkboxes a checkbox, a *Location* column a place when
  every value carries its coordinates (an address alone stays text: the import doesn't look
  addresses up), and the rest text. A *Dependency*
  column becomes the database's dependencies, by item name. Updates become comments in the row's
  body under their author and time, where links to items of the board lead to their rows; files
  and links stay links. Other sheets of the workbook, and updates or dependencies naming no item,
  are listed in the result. Read as the documented layout: the board's name on top, each group's
  name over its header row, subitems one column in under their item, updates on a sheet of their
  own. Tested against files built from that layout, not yet a real export.
- **Save a web page**: *Save from web…* in the sidebar's *New* and *+* menus (or Import's *Web
  page* tab) takes a web page's address and saves its title, a link back, its main text (without
  the menus, ads, comments and footers around it) and its pictures, copied into the workspace (up
  to 20 of 5 MB each). A page with a schema.org recipe starts with it: yield and times, the
  ingredients as a checklist, the steps as a numbered list, then the rest of the page. It goes
  under a page, into a database as a row (its first URL property gets the address) or to a
  private page at the top; the form starts where you saved the last time. The *Save to Leafdesk*
  bookmarklet in that dialog opens the quick note with the page you are on (address, title and the
  text you selected, as a quote); there, as for links shared to the installed app, *Save full page*
  saves the whole page. The *Save to Leafdesk* browser extension (Chrome, Edge, Firefox; a zip in
  every release, see [`extension/`](../extension/README.md)) does the same from its toolbar button
  (Alt+Shift+S) and from the context menu of a page, a link or selected text: it opens the quick
  note on the Leafdesk address set in its settings, and sends nothing anywhere else. The server fetches only public addresses (http or https on the usual web
  ports, every redirect checked again; `WEB_FETCH_ALLOWED_HOSTS` lets hosts on your own network
  through, see [Self-hosting](self-hosting.md#broken-web-links)), at most 5 MB of page in 15 seconds. REST:
  `POST /api/v1/pages/from-web` (see [REST API](rest-api.md)).
- **Sync Jira issues**: Import's Jira tab takes a Jira Cloud site, an email address and an
  [API token](https://id.atlassian.com/manage-profile/security/api-tokens) (kept sealed like a
  connection's secrets), then a project or a JQL query, and makes a database whose rows are the
  issues: key, summary as the title, status (grouped to do, in progress and done by Jira's status
  category), assignee and reporter as persons when their Jira email address is a member's (Jira usually hides
  it; then the assignee's name goes in *Assignee (others)*), priority, type, labels, due date and a link back,
  opening on a board by status. It syncs every 15 minutes, hour, 6 hours, day or only on demand,
  one way: each run writes Jira's values over the synced properties and titles and adds new issues
  as rows, while properties added in Leafdesk stay, rows whose issue stops matching are left alone
  and rows in the trash stay there. Changes after the first run count as edits, so automations,
  row activity and assignment notices follow them. A run goes through as whoever last set the sync
  up or synced it by hand, and needs them to still be able to edit the database. Refused
  credentials, a refused query, a deleted *Key* property or more than 2,000 issues pause it until
  it is changed in the database's sync dialog (the ⟳ button on its toolbar), where people with
  full access can also sync now, change the query or sign-in, pick the person property the
  reporter goes to (or none), or stop syncing (the rows stay). Only the person whose sign-in the
  sync keeps changes its query or lists its projects with it; anyone else gives their own email
  address and token to do so, which then replace it (syncs set up before this keep a sign-in of
  no one's until it is given again). Setting up any sync, or checking a sign-in, first checks that
  the person may make the database where they asked, and each person may do so ten times a
  minute and sixty an hour.
  Tested against a stand-in Jira (`scripts/jira-sync-e2e.ts`), not yet a real site.
- **Sync GitHub pull requests**: Import's GitHub tab takes a repository (`owner/name` or its
  address), a token for a private one (read access to pull requests is enough; it also raises
  GitHub's rate limit, and is kept sealed) and, for GitHub Enterprise Server, its address, and makes
  a database whose rows are the pull requests: number, title, state (*Draft*, *Open*, *Merged*,
  *Closed*, grouped to do, in progress and done), author and assignees as persons when they sign in
  to Leafdesk with that GitHub account (others by login in *Author (others)* and *Assignees
  (others)*), labels, branch, base branch, created and merged dates and a link back, opening on a
  board by state. It takes the open pull requests (and, on each run, the last 100 closed ones, to
  finish the rows of those merged or closed since) or all of them, the 1,000 most recently updated,
  and syncs as often and as one-way as a Jira sync. A spent rate limit waits for the next run; a
  refused token or a deleted *Number* property pauses it. In the database's sync dialog people with
  full access can change which pull requests it takes, how often, the token, sync now or stop.
  Tested against a stand-in GitHub (`scripts/github-pulls-sync-e2e.ts`), not yet the real API.
- **Sync a calendar**: Import's Calendar tab takes a calendar's iCal address (an `.ics` or `webcal://`
  link: Google Calendar's secret address in iCal format, an Outlook published calendar, a booking
  tool's feed; kept sealed and never shown again, only its host) and makes a database whose rows
  are the events from 90 days back to a year ahead: summary as the title, *When* (a day, days, a
  time or a time range, in the event's own time zone, Windows zone names included), location,
  description, status (*Confirmed*, *Tentative*, *Cancelled*), organizer and a link, opening
  beside a calendar view by *When*. Each occurrence of a repeating event is a row of its own
  (daily, weekly, monthly and yearly rules with their intervals, counts, end dates, weekdays and
  days of the month; excluded dates; moved and cancelled occurrences). It syncs as often and as
  one-way as a Jira sync; rows of events that leave the calendar stay. A calendar that asks for a
  sign-in, refuses or is gone pauses it until its address is changed in the sync dialog. Up to
  5,000 events and 10 MB. Tested against a calendar the e2e serves (`scripts/ical-sync-e2e.ts`).
- **Sync a PostgreSQL table**: Import's PostgreSQL tab takes a connection address
  (`postgres://user:password@host:5432/database`, kept sealed), a table or view (`schema.table`),
  the column that finds each row again (the primary key when left empty) and the one that names
  it (the first text column), and makes a database with the key as text and a property for each
  other column by its type: text, numbers, checkboxes, dates, times and JSON (as text). Runs read
  up to 5,000 rows and 50 million characters (each value cut at 10,000) ordered by the key in a
  read-only transaction with a 30-second limit, and Leafdesk hangs up after a minute whatever the
  server does; they write the table's values over and add new rows; rows that leave the table
  stay. Keys keep every digit, however big the number. The server is reached on
  public addresses only, with TLS unless the address's `sslmode` says otherwise; a database on
  your own network needs its host in `CONNECTOR_ALLOWED_HOSTS` (a bare name allows port 5432; name
  any other port, `db:6543`). A refused password, a missing
  table, a dropped column (with the server's words in the sync dialog) or a deleted key property
  pauses it. Use a user that may only read the table. Tested against a table of the e2e's own
  database (`scripts/postgres-sync-e2e.ts`).
- **GitHub pull requests update tasks**: *GitHub pull requests* in the ••• menu of a database with
  an ID property with a prefix gives a payload URL and a secret to add as a repository webhook
  (JSON, *Pull requests* events). A pull request that names rows by their ID (`TASK-12`, in any
  case, in its title, description or branch; at most 20 per pull request) adds its link to a text
  property (one per line, the last 30) or a URL property (the latest), and can move a status
  property: one option when it is opened or ready for review, one when it is merged and,
  optionally, one when it is closed without merging. Drafts only add their link, and a row
  already in a done status moves only for a merge, so a later pull request never moves a finished
  task back. Deliveries are checked against the secret (`X-Hub-Signature-256`) and taken once
  (`X-GitHub-Delivery`), and the writes are made as whoever last saved the setup, with their access
  when the delivery comes: rows they can't edit are skipped, and automations follow the changes.
  The dialog lists the latest deliveries with the rows each changed; setting up, changing and
  removing it are in the audit log. Tested with signed deliveries (`scripts/github-sync-e2e.ts`),
  not yet against GitHub itself.
- **Workspaces and members**: four roles. Owners run the workspace; members see and edit every
  page that isn't restricted; guests see only what is shared with them; **membership admins** have
  exactly a member's access to content (pages, databases, teamspaces, AI, agents, MCP and the REST
  API) and run its people as owners do: they add and remove members and guests, change roles among
  member, membership admin and guest, approve or decline join requests, manage invitations (into
  teamspaces too) and groups, and see Settings → Members, Guests and Groups. They never make,
  demote or remove an owner, nor change an invitation to become one, can't add themselves to a
  group, and get no other owner tab or action (security, join link, ownership, SCIM, single
  sign-on, audit log, analytics, connections, export and the like). An owner removing someone
  picks who takes over the pages only that person could manage; when a membership admin removes
  someone, they go to the oldest owner.
  Add people by email (several at once) as owners, membership admins or members, send
  an invitation link to people who don't have an account yet (or whose account's address was
  never verified: anyone can sign up with someone else's address), or turn on a join link anyone
  can use. Invitation emails are limited (per person inviting, 100 an hour; per workspace, 200;
  per address invited, 3 from any workspace); past that the invitation is made all the same, and
  its link is shown to share instead. Owners can export the member list as CSV, hand ownership to someone else, and decide who
  may invite guests and add members, which email domains may join on their own, who may ask to
  join, whether pages may be exported, and what connected apps and API tokens may do (see
  [Who can join a workspace](account-and-security.md#who-can-join-a-workspace) and
  [Workspace security switches](account-and-security.md#workspace-security-switches)).
- **Email**: invitations, password reset, assignment and share notifications over SMTP (see [Email](self-hosting.md#email)).
- **Sign in with GitHub, Google or Apple**, optional (see [Social login](self-hosting.md#social-login)).
- **My account**: name and picture, password, email address, signed-in devices, connected apps,
  language and notification settings in one place, and deleting the account (see
  [My account](account-and-security.md#my-account)).
- **Two-step verification and passkeys**: an authenticator app with one-time recovery codes,
  passkeys, and a workspace policy that requires one of them (see
  [Two-step verification and passkeys](account-and-security.md#two-step-verification-and-passkeys)).
- **Single sign-on and provisioning**: OpenID Connect for the whole server, OpenID Connect or SAML
  per workspace with DNS-verified email domains, a "single sign-on only" policy, and SCIM 2.0 user
  and group provisioning (see [Single sign-on (OIDC, SAML) and SCIM](account-and-security.md#single-sign-on-oidc-saml-and-scim)).
- **AI writing assistant, AI properties and AI chat** (optional, off until a provider is set up):
  improve, shorten, fix, translate or rewrite selected text as you ask, continue writing, and
  summarize a page, as a suggestion you accept or discard; database properties that AI fills in
  (text: a summary, a translation or your own prompt over the row's values; a select, multi-select,
  status, number or checkbox from your prompt); a chat, on its own page
  or in a panel beside a page, that answers questions from the pages you can read, citing them,
  reads the images, documents and CSV files you attach, writes long cited reports in research mode
  (from the web too, where owners turn web search on), answers with the model you pick where the
  server offers several, and remembers what you tell it about yourself (asking first; each person,
  or a workspace's owners for everyone, can turn the memory off, see [Memory](ai.md#ai-features)); and
  semantic search with an
  embeddings model. Anthropic, OpenAI, Google, any OpenAI-compatible server, or a local model
  with Ollama or LM Studio (see [AI features](ai.md#ai-features)).
- **Voice notes** (optional, off until speech to text is set up): speak in the quick note or with
  `/` *Voice note* in a page, and AI writes what you said up as a clean note with a title, lists
  kept, the transcript in a toggle under it. From the quick note it is saved as a private page or a
  database row whose select and multi-select properties it fills from their options. In a page,
  Cmd/Ctrl+Shift+D (or `/` *Dictate*) writes what you say at the caret as you said it, without AI;
  press again, press Enter or hold the keys while you talk. OpenAI or any server with an
  OpenAI-compatible transcription API, such as a local Whisper server (see
  [Voice notes](ai.md#voice-notes)).
- **Meeting notes** (with speech to text): `/` *Meeting notes* in a page records a meeting of up to
  three hours, the transcript filling in as you talk, and AI writes the summary, decisions and
  action items, each linked to its moment in the transcript. *Meetings* in the sidebar lists them
  (see [Meeting notes](ai.md#meeting-notes)).
- **AI chat from Telegram** (optional, off until the server has a Telegram bot): people link their
  Telegram account in My account → *Connected apps* and ask the AI chat there, by text or voice
  message; answers cite their pages as links, and changes are asked about with buttons. Their
  inbox notifications come there too, to mark read or snooze from the chat (see
  [AI chat from Telegram](ai.md#ai-chat-from-telegram)).
- **Skills**: instructions your team reuses (how to wrap up meeting notes, reply to a customer),
  kept as rows of a skills database or as pages marked *Use as skill*; picked with `/` in the AI
  chat, offered to MCP clients as prompts and tools, listed in the workspace's skills library and
  exported as `SKILL.md` (see [Skills](ai.md#skills)).
- **24 interface languages**: English, Turkish, German, Spanish, French, Italian, Portuguese, Polish, Russian, Ukrainian, Arabic, Hebrew, Persian, Japanese, Korean, Chinese, Indonesian, Thai, Vietnamese, Danish, Dutch, Norwegian, Finnish and Swedish, chosen in My account or taken from the
  browser; Arabic, Hebrew and Persian lay the app out right to left (see [Languages](development.md#languages)).
- **Light and dark themes**: following the system, or chosen for the browser in Preferences, each
  with a high contrast option (stronger secondary text, lines and focus) that also follows the
  system's "increase contrast" setting. Ctrl+Shift+L (⌘⇧L on a Mac) switches between light and
  dark.
- **MCP server with OAuth 2.1**: remote MCP endpoint at `/mcp`.
  - Supports Client ID Metadata Documents and Dynamic Client Registration, with PKCE and a
    consent screen.
  - Tokens are audience-bound. Apps can be read-only or read-write, and you can revoke them in
    My account → Connected apps.
- **Page webhooks**: workspace owners send what happens to pages (made, edited, moved, trashed,
  restored, deleted for good, commented on) to a service of their own as signed POST requests, for
  the whole workspace, one teamspace or a page and the pages under it, under Settings > Webhooks or
  with the REST API (see [Page webhooks](automations.md#page-webhooks)).
- **REST API** under `/api/v1` with personal access tokens (read or read-write, optionally one
  workspace, optional expiry) and an OpenAPI 3.1 document (see [REST API](rest-api.md#rest-api)).
- **Snippets**: content you insert while typing: `;` and a snippet's trigger in any page (or the
  slash menu's *Snippets* group) puts in its blocks, with today's date, the time, your name and the
  page's title filled in and the caret where the snippet says. Your own snippets, and the
  workspace's that its owners keep, in Settings, with import and export as JSON (see
  [Snippets](ai.md#snippets)).
- **Edit as Markdown**: open a page's text as Markdown beside a live preview, edit it with
  formatting shortcuts, equation completion and file uploads, and save it back; colors and other
  things Markdown can't hold are named before saving, and edits made meanwhile by others are
  never overwritten unasked (see [Edit as Markdown](export.md#edit-as-markdown)).
- **Callout styles**: owners name up to 30 box looks in Settings → General → Callout styles, each
  with an icon (or none), one of the editor's colors, a border (none, a bar at the side or a full
  frame) and an optional default title. Everyone inserts them from the `/` menu's *Callouts* group
  or picks one in a callout's block menu (*Turn into callout* does it for a block of text), and
  any callout can have a title of its own. Changing a style changes every callout using it, in the
  editor, on published pages and in PDFs; a callout whose style was deleted shows as a plain
  callout. Every workspace also has a framed box (*Frame*). In Markdown a styled callout is
  `> [!key] Title`, a plain one keeps its alert (`> [!NOTE] Title`, `> [!NOTE|blue]` for a color
  the alerts don't have), and imports read `:::info`, `:::warning`, `:::details`, `:::card` and
  similar containers as callouts, toggles and framed boxes, nested ones too.
