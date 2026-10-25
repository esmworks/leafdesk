import { normalizeAddress } from "./share.js";

const ext = globalThis.browser ?? globalThis.chrome;

/** The extension's settings: the address of the person's Leafdesk. */

for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = ext.i18n.getMessage(el.dataset.i18n);
document.documentElement.lang = ext.i18n.getUILanguage();
document.documentElement.dir = ext.i18n.getMessage("@@bidi_dir");

const form = document.getElementById("form");
const input = document.getElementById("address");
const status = document.getElementById("status");

const { address } = await ext.storage.sync.get("address");
if (address) input.value = address;

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const base = normalizeAddress(input.value);
  status.classList.toggle("error", !base);
  if (!base) {
    status.textContent = ext.i18n.getMessage("optionsInvalid");
    input.focus();
    return;
  }
  await ext.storage.sync.set({ address: base });
  input.value = base;
  status.textContent = ext.i18n.getMessage("optionsSaved");
});
