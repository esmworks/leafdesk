import { normalizeAddress, shareUrl } from "./share.js";

// Firefox's `browser` answers with promises everywhere; Chrome's `chrome` does in Manifest V3.
const ext = globalThis.browser ?? globalThis.chrome;

/**
 * The toolbar button (and its shortcut) saves the page you are on with the text you selected on it;
 * the context menu saves the page, a link or the selection. Each opens Leafdesk's quick note in a
 * new tab beside this one. Without a Leafdesk address yet, the settings open instead.
 */

const MENUS = [
  { id: "page", contexts: ["page"], title: "menuPage" },
  { id: "link", contexts: ["link"], title: "menuLink" },
  { id: "selection", contexts: ["selection"], title: "menuSelection" },
];

ext.runtime.onInstalled.addListener(async ({ reason }) => {
  await ext.contextMenus.removeAll();
  for (const menu of MENUS) ext.contextMenus.create({ id: menu.id, title: ext.i18n.getMessage(menu.title), contexts: menu.contexts });
  if (reason === "install" && !(await leafdeskAddress())) ext.runtime.openOptionsPage();
});

async function leafdeskAddress() {
  const { address } = await ext.storage.sync.get("address");
  return normalizeAddress(address);
}

async function save(tab, item) {
  const base = await leafdeskAddress();
  if (!base) return ext.runtime.openOptionsPage();
  await ext.tabs.create({
    url: shareUrl(base, item),
    ...(tab && tab.id !== undefined && tab.id >= 0 ? { index: tab.index + 1, openerTabId: tab.id } : {}),
  });
}

/** The text selected in the tab, where the browser lets the extension read it (not on its own pages). */
async function selectionIn(tab) {
  try {
    const [first] = await ext.scripting.executeScript({ target: { tabId: tab.id }, func: () => String(getSelection()) });
    return first?.result ?? "";
  } catch {
    return "";
  }
}

ext.action.onClicked.addListener(async (tab) => {
  await save(tab, { url: tab.url, title: tab.title, text: await selectionIn(tab) });
});

ext.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "link") await save(tab, { url: info.linkUrl, title: info.linkText || "" });
  else if (info.menuItemId === "selection") await save(tab, { url: info.pageUrl || tab?.url, title: tab?.title, text: info.selectionText });
  else await save(tab, { url: info.pageUrl || tab?.url, title: tab?.title });
});
