"use client";

import { useEffect, useRef, useState } from "react";
import { useQuickAdd } from "./quick-add";
import type { Property, View } from "./types";
import type { DatabaseApi } from "./use-database";

/**
 * An invisible text field that takes what is typed while the row is being created. Being a real
 * field, it gets accented letters, other keyboards, phone keyboards and paste like any input.
 */
function captureField() {
  const field = document.createElement("input");
  field.type = "text";
  field.tabIndex = -1;
  field.autocomplete = "off";
  field.setAttribute("aria-hidden", "true");
  // 16px keeps iOS from zooming in on focus.
  field.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;font-size:16px;";
  document.body.appendChild(field);
  field.focus({ preventScroll: true });
  return field;
}

/** How long the title editor has to take focus before what was typed is saved without it. */
const EDITOR_WAIT_MS = 300;

/**
 * A new row's title editor opens once the server has created the row. What is typed before that is
 * kept and handed to the editor; Enter or Escape saves it as the title without opening it; and
 * "New" does nothing while a row is still being created, so neither a click nor Enter on the
 * focused button makes a second row. The title is saved with quick add (see quick-add): the view
 * provides `quick` (QuickAddContext) to the title editor, which then shows what it recognises.
 */
export function useNewRow(api: DatabaseApi, view: View, properties: Property[]) {
  const quick = useQuickAdd(api, view, properties);
  const saveTitle = quick.save;
  const [editing, setEditing] = useState<string | null>(null);
  const busy = useRef(false);
  const capture = useRef<HTMLInputElement | null>(null);

  useEffect(() => () => capture.current?.remove(), []);

  const create = async (run: () => Promise<string | null>) => {
    if (busy.current) return;
    busy.current = true;
    capture.current?.remove();
    const field = captureField();
    capture.current = field;
    let finished = false;
    let created = false;
    field.addEventListener("keydown", (e) => {
      if (e.isComposing || e.keyCode === 229 || (e.key !== "Enter" && e.key !== "Escape")) return;
      e.preventDefault();
      finished = true;
      field.remove();
    });
    // Focus moving on (to the title editor, or a click elsewhere) ends the capture; the text stays.
    // Before the row exists only a click elsewhere can take it: that saves the text as Enter does,
    // without opening the editor (which may not be shown to take it).
    // Removing the focused field fires blur while it is being removed: removing it again from in
    // there makes that first removal throw, so this one waits until it's done (and does nothing).
    field.addEventListener("blur", () => {
      if (!created) finished = true;
      queueMicrotask(() => field.remove());
    });
    try {
      const id = await run();
      created = true;
      const text = field.value.trim();
      if (!id || finished) {
        field.remove();
        if (id && text) saveTitle(id, text);
        return;
      }
      setEditing(id);
      // The row may not be shown here (filtered out, in a collapsed group): nothing takes the field's
      // focus then, so save what was typed rather than lose it.
      setTimeout(() => {
        if (!field.isConnected) return;
        field.remove();
        if (field.value.trim()) saveTitle(id, field.value.trim());
        setEditing((current) => (current === id ? null : current));
      }, EDITOR_WAIT_MS);
    } finally {
      busy.current = false;
    }
  };

  return {
    /** The row whose title editor is open, if any. */
    editTitleOf: editing,
    /** What was typed before that editor opened; it starts with this. */
    typed: editing ? (capture.current?.value ?? "") : "",
    create,
    quick,
    /** Names a row from its title editor: the title without what quick add took, and those values. */
    saveTitle,
    stopEditing: () => {
      capture.current?.remove();
      setEditing(null);
    },
  };
}
