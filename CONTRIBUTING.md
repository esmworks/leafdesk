# Contributing to Leafdesk

Issues and pull requests are welcome. For code, the [Development](README.md#development) section
of the README has the setup; run `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm i18n:check` before
opening a pull request (CI runs them too, plus a build and the end-to-end scripts).

Security problems are the exception: report them privately as [SECURITY.md](SECURITY.md)
describes, not in an issue or pull request.

## Translations

Leafdesk's interface is available in English, Turkish, German, Spanish and French. English is the
source language: every other language is compared with it, and any text a language lacks is shown
in English until someone translates it.

### Where the texts are

| What | Where |
| --- | --- |
| The app (menus, dialogs, settings, errors…) | `src/i18n/messages/<locale>/*.json`, one file per area (`page.json`, `database.json`, …) |
| Emails (invitations, password reset, notifications) | `src/i18n/messages/<locale>/email.json` |
| Built-in templates (Meeting notes, Weekly plan, Project tracker) | `src/i18n/messages/<locale>/templates.json` |
| The editor's own menus (slash menu, formatting toolbar, placeholders) | [BlockNote](https://www.blocknotejs.org)'s dictionaries, mapped in `src/i18n/blocknote/index.ts` |
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
- In `templates.json` keep the Markdown structure (`##`, `- [ ] `, blank lines); the property and
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
   from the browser's `Accept-Language` all follow from this list.
2. Copy `src/i18n/messages/en/` to `src/i18n/messages/<code>/` and translate every file. Nothing
   else loads them: files are found by the folder name.
3. The editor: if BlockNote has the language (see the list in
   `node_modules/@blocknote/core/src/i18n/locales/`), import it in `src/i18n/blocknote/index.ts`
   and add it to `EDITOR_DICTIONARIES`. If not, copy `src/i18n/blocknote/tr.ts` to
   `src/i18n/blocknote/<code>.ts`, translate it and import that instead (and consider
   contributing it to BlockNote too). `pnpm typecheck` fails until every language has one.
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
