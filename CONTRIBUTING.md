# Contributing to Leafdesk

Issues and pull requests are welcome. For code, the [Development](README.md#development) section
of the README has the setup; run `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm i18n:check` before
opening a pull request (CI runs them too, plus a build and the end-to-end scripts).

Security problems are the exception: report them privately as [SECURITY.md](SECURITY.md)
describes, not in an issue or pull request.

## What 1.0 means

Leafdesk is called 1.0 when all of the following hold, and a release that breaks one of them is
fixed before anything new is added:

1. **No known data loss.** No open bug loses or silently changes what someone saved: page text,
   database rows and their values, comments, files, page history or anything in the trash.
2. **No known permission leak.** No open bug lets someone read or change what their access
   doesn't allow, through the app, the REST API, MCP, published pages, exports, search, AI or
   agents.
3. **Upgrades are tested.** CI's *Upgrade from an older release* job installs an older release
   (`UPGRADE_FROM` in the workflow), fills it with a workspace through that release's own code,
   upgrades the database to the branch and checks that everything is still there and the same,
   that the schema matches a fresh install, and that a set of the end-to-end scripts passes on it.
   Green on `main`.
4. **Large workspaces are tested.** CI's *Large workspace* job seeds a database with 50,000 rows
   and a workspace with 5,000 pages and times opening, filtering and sorting the table, searching,
   opening a page and connecting to its live document against the limits in
   `scripts/scale-e2e.ts`. Green on `main`.
5. **The end-to-end scripts are stable.** A script that fails without a change to the code is a
   bug, in the script or in Leafdesk: it is fixed, not re-run until it passes. A fixed flaky script
   passes 20 runs in a row before the fix is merged.

## Licensing of contributions

Leafdesk is licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only).
By opening a pull request or otherwise submitting a contribution (code, documentation,
translations, images), you agree to the following:

1. **Your contribution is licensed under AGPL-3.0-only**, like the rest of Leafdesk.
2. **You also grant esmworks** a perpetual, worldwide, non-exclusive, royalty-free, irrevocable
   license to use, copy, modify, distribute and sublicense your contribution, and to license it
   under other terms, including commercial ones. You keep the copyright to your contribution and
   may use it however you like.
3. **You have the right to grant this**: the contribution is your own work, or you have
   permission to contribute it under these terms (from your employer too, if it owns what you
   write). If any of it comes from somewhere else, say so in the pull request.

Code, styles, texts or images from other projects come in only under a license that allows the
above, such as MIT, BSD or Apache-2.0, with their notice added to [NOTICE](NOTICE). Code under the
GPL or AGPL from other projects can't be accepted, because esmworks couldn't grant point 2 for it:
take the idea and write it yourself.

## Translations

Leafdesk's interface is available in English, Turkish, German, Spanish, French, Italian, Portuguese, Polish, Russian, Ukrainian, Arabic, Hebrew, Persian, Japanese, Korean, Chinese, Indonesian, Thai and Vietnamese.
English is the source language: every other language is compared with it, and any text a language lacks is shown
in English until someone translates it.

### Where the texts are

| What | Where |
| --- | --- |
| The app (menus, dialogs, settings, errors…) | `src/i18n/messages/<locale>/*.json`, one file per area (`page.json`, `database.json`, …) |
| Emails (invitations, password reset, notifications) | `src/i18n/messages/<locale>/email.json` |
| Built-in templates (Meeting notes, Weekly plan, Project tracker) | `src/i18n/messages/<locale>/templates.json` |
| Ready-made skills (Wrap up meeting notes, Reply to a customer…) | `src/i18n/messages/<locale>/skillTemplates.json` |
| The editor's own menus (slash menu, formatting toolbar, placeholders) | [BlockNote](https://www.blocknotejs.org)'s dictionaries, mapped in `src/i18n/blocknote/loaders.ts` |
| Language names in the language picker | `LOCALE_NAMES` in `src/i18n/config.ts` |

The files are plain JSON in [ICU MessageFormat](https://next-intl.dev/docs/usage/messages), as read
by next-intl:

```json
{
  "title": "Members of {name}",
  "addSelected": "{count, plural, =0 {Add people} other {Add #}}",
  "kind": "{kind, select, page {Page} database {Database} other {Item}}"
}
```

- Keep the placeholders (`{name}`, `{count}`) and rich-text tags (`<b>…</b>`) exactly as they are.
  Only translate the text around them and the text inside plural and select branches; the words
  before a branch (`one`, `other`, `=0`, `page`) stay as they are.
- Plurals follow your language's categories (`one`, `few`, `many`, `other`…; see the
  [CLDR plural rules](https://www.unicode.org/cldr/charts/latest/supplemental/language_plural_rules.html))
  and always keep `other`. A language without plural forms may write a plain `{count}`, and one that
  needs a plural where English doesn't may add one.
- An ASCII apostrophe right before `{` or `}` starts a quoted text in ICU and swallows the
  placeholder (`l'{name}`). Use the typographic apostrophe `’` instead.
- In `templates.json` and `skillTemplates.json` keep the Markdown structure (`##`, `- [ ] `, blank lines); in `templates.json` the property and
  option names become the names in the created database.
- Product and technical names stay as they are: Leafdesk, MCP, Markdown, CSV, formula function
  names, keyboard keys. The Turkish files are a complete example of what gets translated.

### Checking a translation

```bash
pnpm i18n:check        # every language
pnpm i18n:check de     # only German
```

It lists, per language and file, what doesn't match English:

- **missing file** / **missing**: not translated yet (the English text is shown next to it),
- **extra file** / **extra**: a file or key English doesn't have (renamed or removed there),
- **empty**: an empty translation,
- **syntax**: the file isn't valid JSON, or a message isn't valid ICU,
- **placeholders**: the message uses other placeholders or tags than the English one,
- **select options**: a `select` with other branches than the English one.

The same check runs in `pnpm test` and in CI, so a pull request that adds an English text without
the other languages, or breaks a translation, fails there with this list.

### Fixing or improving a translation

Edit the JSON file and open a pull request. Mention what you changed and why (a wrong term, a more
natural wording). Keep terms consistent across the files: if you change how a word is translated,
change it everywhere.

### Adding a language

1. Add the language to `LOCALE_NAMES` in `src/i18n/config.ts`: its code (lower case BCP 47, such
   as `it` or `pt-br`) and its name in that language (`Italiano`). The language picker, the
   `<html lang>` attribute, date and number formats (through `Intl`) and choosing the language
   from the browser's `Accept-Language` all follow from this list. A language written right to
   left also goes into `RIGHT_TO_LEFT` there, which sets `<html dir="rtl">`; the layout uses
   logical CSS (`ms-*`, `ps-*`, `start-*`, `text-start`…), so it mirrors without further code.
2. Copy `src/i18n/messages/en/` to `src/i18n/messages/<code>/` and translate every file. Nothing
   else loads them: files are found by the folder name.
3. The editor: if BlockNote has the language (see the list in
   `node_modules/@blocknote/core/src/i18n/locales/`), copy `src/i18n/blocknote/locales/de.ts` to
   `locales/<code>.ts` with the code changed. If not, copy `src/i18n/blocknote/tr.ts` to
   `src/i18n/blocknote/<code>.ts` and translate it (and consider contributing it to BlockNote
   too). Either way, add its line to `EDITOR_DICTIONARY_LOADERS` in
   `src/i18n/blocknote/loaders.ts`; `pnpm typecheck` fails until every language has one.
4. Run `pnpm i18n:check <code>` until it reports nothing, then `pnpm typecheck` and `pnpm test`.
5. Try it: `pnpm dev`, then My account → Language.
6. Open a pull request with the new folder and the two small code changes. Say whether you are a
   native speaker and whether you can review future changes to the language.

A language is merged only complete: CI fails while keys are missing. If you can't finish, open
the pull request as a draft and others can continue it.

### When English changes

A pull request that adds or changes an English text adds it in every language, since CI fails
otherwise. Turkish is maintained with English; for the other languages, write the best
translation you can and list those keys in the pull request so a speaker of the language can
review them. When an English text changes meaning, update the translations too: the check can't
see that they are out of date.
