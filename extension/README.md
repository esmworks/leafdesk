# Save to Leafdesk

A browser extension for Chrome, Edge, Firefox and other browsers that run Manifest V3 extensions.
It saves the page you are on, a link or the text you selected to your own Leafdesk server.

- **The toolbar button** (or Alt+Shift+S) saves the page you are on, with the text you selected on
  it as a quote.
- **The context menu** saves a page, a link or a selection.

Either opens Leafdesk's quick note (`/share`) in a new tab with the address, title and selected
text filled in. There you choose where it goes, or *Save full page* to keep the page's text and
pictures. Saving happens in Leafdesk, signed in as you; the extension keeps only your Leafdesk
address (in the browser's synced storage) and sends nothing anywhere else. It reads a page's
selected text only when you click its button there.

## Install

Every [release](https://github.com/esmworks/leafdesk/releases) has a `leafdesk-extension-<version>.zip`.

- **Chrome, Edge, Brave:** unzip it, open `chrome://extensions`, turn on *Developer mode*, choose
  *Load unpacked* and pick the folder.
- **Firefox:** open `about:debugging#/runtime/this-firefox`, choose *Load Temporary Add-on…* and
  pick `manifest.json` in the folder. A temporary add-on goes away when Firefox restarts; for a
  lasting install, sign the zip through [addons.mozilla.org](https://addons.mozilla.org/developers/)
  (it can be listed or kept to yourself).

The first time, the extension's settings open: enter the address you open Leafdesk at.

## Development

Plain JavaScript modules, no build step: load this folder unpacked as above. `share.js` holds the
part worth testing (`share.test.ts`, run with the app's `pnpm test`). Texts are in
`_locales/<language>/messages.json`, one folder per language Leafdesk speaks (Chrome's codes:
`pt_BR`, `zh_CN`, `no` for Norwegian bokmål). The version follows Leafdesk's: the release workflow
(`.github/workflows/extension.yml`) writes the release's version into `manifest.json` and adds
the zip to the release.
