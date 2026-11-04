# Design

How Leafdesk's interface is put together: which size, weight and color each kind of text takes,
how far apart things sit, what separates them, when something is a dialog and when a page. The
colors are tokens in `src/app/globals.css`; sizes, spacing and corners are Tailwind's own scale,
used as written here rather than redefined. The shared components (`Button`, `Input`, `Dialog`,
`DialogHeader`, `DialogBody`, `DialogFooter`, `Switch`, `MenuItem`) are in `src/components/ui.tsx`.

A screen looks finished when the eye knows where to go first: one title, a few short lines, a lot
of room, and nothing drawn that space could do instead.

## Text

Two weights only: regular (400) for what is read, medium (500) or semibold (600) for what names
or is pressed. Color does the rest of the ranking: `text-fg` for content, `text-fg-muted` for what
explains it, `text-fg-faint` for counts and times. Page titles alone take the display face
(`font-display`, Roboto Slab), at the regular weight; everything else is the interface's face.
A page's own title (a document, database or row, wherever it shows: the editor, a published page,
a form, print, slides, a version's preview) is the `page-title` class (globals.css): the same face,
or the typeface the page picked (serif, mono). PDFs and Word files set it in Roboto Slab too
(`server/pdf.ts` reads `src/app/fonts/roboto-slab/RobotoSlab-Regular.ttf`; Word files embed it).

| Role | Class | Used for |
| --- | --- | --- |
| Page title | `font-display text-2xl tracking-tight text-fg` | The name at the top of a page (an agent, a settings tab, Home's greeting, the graph) |
| A page's own title | `page-title leading-tight tracking-tight` | A document's, database's or row's name, at its own size |
| Dialog title | `text-lg font-semibold text-fg` | `DialogTitle` |
| Section title | `text-base font-semibold text-fg` | A part of a page: *Memory*, *Triggers* |
| Group title | `text-sm font-medium text-fg` | A list's heading inside a section |
| Body | `text-sm text-fg` | Values, list items, what people wrote |
| Help | `text-[13px] text-fg-muted` | The one line under a section title or a field |
| Field label | `text-[13px] font-medium text-fg` | Above an input |
| Meta | `text-xs text-fg-faint tabular-nums` | Counts, times, who did something |

Running text is at most `max-w-[640px]` wide (about 75 characters); a wide page centers a column
of that width or puts a second column beside it, never one long line across.

## Words on the screen

- A section has at most **one line** of help under its title. The rest goes behind an info button
  beside the title (a popover) or into the docs, linked from there.
- A warning is one line with an icon in `text-fg-muted`, not a boxed paragraph. A box (filled
  `bg-bg-subtle`, no border, `rounded-lg`) is kept for something the person must act on now.
- Empty states are one line and the button that fills them.
- Labels say what the thing is in one or two words; they don't repeat the section's title.

## Spacing

On the 4 px grid (Tailwind's 1 = 4 px):

| Between | Gap |
| --- | --- |
| A label and its field, a title and its help line | `gap-1` – `gap-1.5` (4–6 px) |
| Rows of a list | none: rows carry their own `py-2` |
| Fields of a form | `gap-4` (16 px) |
| Groups in a section | `gap-6` (24 px) |
| Sections of a page | `gap-10` (40 px) |
| A page's edge | `px-8 py-8` desktop, `px-4 py-4` phone |
| A dialog's edge | `px-5`, `pt-5`, `pb-5` (`DialogHeader`, `DialogBody`, `DialogFooter`) |

## Surfaces and lines

Separate with space first, a filled surface second and a line last.

- Lists have no frame and no lines between rows: a row shows its edge by its hover
  (`hover:bg-bg-hover`, `rounded-md`) and its room.
- A field is filled (`bg-bg-hover`, no edge) in a dialog and on a page's settings; the edge returns
  in high contrast (`--field-edge`).
- Corners: controls (buttons, fields, rows) `rounded-md`; cards and boxes `rounded-lg`; dialogs
  and panels over the page `rounded-2xl`. Nothing is fully round but avatars and dots.
- Shadows: none on what sits in the page; `shadow-lg` for menus and cards that float; `dialogShadow`
  for dialogs and panels over a shade.
- An icon beside a title stands on its own, without a box around it.
- The window has a frame (`bg-frame`, a step darker than the page): on wide windows the rail sits
  on it, and the sidebar's panel and the page are one card above it, edged by a line and rounded
  at the start of its top. Something on the frame hovers and is picked with `bg-frame-hover` and
  `bg-frame-active`; the page's own tints would vanish into it. The workspace's menu is at the
  panel's foot, or on the rail's top while the panel is hidden.
- Icons are drawn with a 1.5 line (`LucideProvider` in `app/layout.tsx`); the rail's own icons
  (`sidebar/rail-icons.tsx`) are as thin, and the place that is open shows its icon filled.

## Navigation inside a screen

- **One kind of tab**: a row of words, the current one in `text-fg` with a 2 px line under it,
  the others `text-fg-muted`. A segmented control (a gray track with a raised button) switches a
  value, such as a view's layout, and never navigates.
- **Never two rows of tabs.** When the parts of something have parts of their own, it is a page
  with a list of sections down its side.

## Dialog or page

- A **dialog** asks one thing or takes a short form: a confirmation, a name and a few settings,
  no tabs, no scrolling list of its own. Its main button is last; Cancel is `secondary`.
- Anything with sections or tabs, or that people stay in and come back to, is a **page** with its
  own address, so it can be linked, opened in a tab and gone back to.
- The pattern for such a page is an agent's settings (`components/settings/agent-editor.tsx`, at
  `/w/<workspace>/agents/<agent>/settings`): a top bar with where it is and its actions, the page
  title with its status and one line about it, the sections down the side (a scrolling row on a
  phone) and one section beside them, `max-w-[640px]` unless it is a wide list. Its fields are
  filled like a dialog's (`data-filled-fields`). The section is in the address (`?section=`),
  changed with `history.pushState`, so it switches without a round trip and the back button works.

- A workspace place that isn't a page (Home, My tasks, Meetings, the Calendar) has a page's top
  bar too (`components/place-top-bar.tsx`, 44 px, sticky): the place's icon and name where a page
  has its path, and the place's own controls at its end (the Calendar's weeks and layout, Meetings'
  new note). Not Share, favorites or comments: those belong to pages. Its title then sits where a
  page's does.

## Lists

A row of a list on a page is: an optional 16 px icon, the item in `text-sm text-fg`, an optional
second line of meta (`text-xs text-fg-faint`: when, from which run, by whom), and its actions at
the end, shown on hover or focus (always shown on touch). A row is at least 40 px tall. The
sidebar's panels are denser; they follow the next section.

## Sidebar panel

Every panel beside the rail (Pages, Journal, My tasks, Meetings, Mail, Chat, Agents) is built from
the same pieces, exported by `components/sidebar/panel.tsx`, so a person who has learned one has
learned them all:

- **Head**: 44 px, as tall as the page's top bar beside it, so both titles sit on one line; the
  panel's rows start 4 px under it. The panel's name in `text-[15px] font-semibold`, and at its end the one thing the
  panel makes (a pen, `SquarePen`, for a page, note, task, message or agent; `CalendarCheck`
  opens today's note), then a ⋯ with the list's own actions when it has some. Never a text button.
- **Row** (`panelRow`): 28 px tall, a 16 px icon in `text-fg-icon`, the item in `text-sm`, meta at
  the end (`panelMeta`: `text-xs text-fg-faint tabular-nums`, a count or a time). Lit on hover; the
  place that is open takes `panelRowActive` (`bg-bg-active font-medium text-fg`). A row's own
  actions appear at its end on hover. An agent's row alone has a second line (what it does).
- **Block** (`panelSection`, 12 px above): a heading (`panelHeading`: 28 px, `text-xs
  font-medium text-fg-faint`, in the rows' column) and its rows. Nothing else separates blocks;
  no lines. A block whose heading folds shows its chevron on hover.
- **Empty** (`PanelEmpty`): one line in `text-xs text-fg-faint`, where the rows would be. "More"
  (`panelMore`) is a quieter row under a block.
- Something that is not a row, or a heading, or one of these, doesn't belong in a panel: a text
  button, a field with a border, a second heading for the whole list (the head names it).

## Buttons

- One `primary` button per screen or dialog: the thing the screen is for. It is drawn in the text's
  color (`bg-primary text-primary-fg`); the green accent is left to what is picked, on or done
  (checkboxes, switches, today) and to links and counts.
- Something that deletes or forgets is a button (`ghost` with `hover:text-danger`, or `danger` in
  its confirmation), never a text link.
- An action that isn't available is hidden when the person can never use it, and disabled with a
  reason (`title`) when they can't use it yet.

## Never

Cream or warm paper backgrounds, an emphasized word in italics inside a title, numbered section
labels, labels in a monospace font, pill-shaped buttons.
