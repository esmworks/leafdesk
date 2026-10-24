import { clipboard, Menu, shell, type ContextMenuParams, type MenuItemConstructorOptions, type WebContents } from "electron";
import type { Strings } from "./strings.ts";

/**
 * The right-click menu Electron leaves out: spelling suggestions, editing and links. Leafdesk's
 * own menus (the editor's, a table's) open on their own and never reach this. `openInTab`: the link
 * leads to a page of the server, which opens in a new tab rather than in the browser.
 */
export function showContextMenu(contents: WebContents, params: ContextMenuParams, t: Strings, openInTab?: (url: string) => void) {
  const items: MenuItemConstructorOptions[] = [];

  if (params.misspelledWord) {
    for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
      items.push({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) });
    }
    items.push({
      label: t.addToDictionary,
      click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
    });
    items.push({ type: "separator" });
  }

  if (openInTab) {
    items.push(
      { label: t.openLinkInNewTab, click: () => openInTab(params.linkURL) },
      { label: t.copyLink, click: () => clipboard.writeText(params.linkURL) },
      { type: "separator" },
    );
  } else if (/^https?:|^mailto:/.test(params.linkURL)) {
    items.push(
      { label: t.openLinkInBrowser, click: () => void shell.openExternal(params.linkURL) },
      { label: t.copyLink, click: () => clipboard.writeText(params.linkURL) },
      { type: "separator" },
    );
  }

  const flags = params.editFlags;
  if (params.isEditable) {
    items.push(
      { role: "cut", label: t.cut, enabled: flags.canCut },
      { role: "copy", label: t.copy, enabled: flags.canCopy },
      { role: "paste", label: t.paste, enabled: flags.canPaste },
      { role: "selectAll", label: t.selectAll, enabled: flags.canSelectAll },
    );
  } else if (params.selectionText.trim()) {
    items.push({ role: "copy", label: t.copy });
  }

  while (items.at(-1)?.type === "separator") items.pop();
  if (items.length) Menu.buildFromTemplate(items).popup();
}
