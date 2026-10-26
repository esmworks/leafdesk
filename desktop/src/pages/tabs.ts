/**
 * The tab strip (pages/tabs.html): draws the window's tabs as the main process tells them
 * (windows.ts, StripState) and tells it what the person does: show, close, move or add a tab, or
 * open a tab's menu. A plain script, not a module, like app.ts; built with tsconfig.pages.json.
 */

type StripTab = { id: number; title: string; icon: string | null; loading: boolean; away: string | null };

type StripState = {
  tabs: StripTab[];
  active: number | null;
  strings: { newTab: string; closeTab: string; tabs: string; back: string; forward: string };
  dir: "ltr" | "rtl";
  canGoBack: boolean;
  canGoForward: boolean;
  clearOfControls: boolean;
};

interface Window {
  leafdeskTabs: {
    onState(listener: (state: StripState) => void): void;
    show(id: number): void;
    close(id: number): void;
    move(id: number, index: number): void;
    menu(id: number): void;
    add(): void;
    back(): void;
    forward(): void;
    focus(): void;
  };
}

{
  const bridge = window.leafdeskTabs;
  const list = document.querySelector<HTMLElement>(".tabs")!;
  const newTab = document.getElementById("new-tab") as HTMLButtonElement;
  const back = document.getElementById("back") as HTMLButtonElement;
  const forward = document.getElementById("forward") as HTMLButtonElement;
  const SVG = "http://www.w3.org/2000/svg";
  /** Below this width a tab shows its icon alone. */
  const NARROW = 72;
  /** How far the pointer moves before a press on a tab becomes dragging it. */
  const DRAG_THRESHOLD = 5;

  let state: StripState | null = null;
  /** A state that came while a tab was being dragged, drawn when it is dropped. */
  let waiting: StripState | null = null;
  let drag: { id: number; tab: HTMLElement; pointer: number; startX: number; grab: number; moved: boolean } | null = null;

  const icon = (paths: string[], className?: string) => {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    if (className) svg.setAttribute("class", className);
    for (const d of paths) {
      const path = document.createElementNS(SVG, "path");
      path.setAttribute("d", d);
      svg.append(path);
    }
    return svg;
  };
  /** A page without an emoji: a sheet of paper. */
  const pageGlyph = () => icon(["M4 1.75h5l3 3v9.5H4z", "M9 1.75v3h3", "M6 8.5h4M6 11h4"]);
  /** A page of another site: a globe. */
  const globeGlyph = () => icon(["M8 1.75a6.25 6.25 0 1 0 0 12.5 6.25 6.25 0 1 0 0-12.5z", "M1.75 8h12.5", "M8 1.75c-3.3 3.5-3.3 9 0 12.5c3.3-3.5 3.3-9 0-12.5z"]);

  const tabElement = (tab: StripTab, shown: boolean, t: StripState["strings"]) => {
    const element = document.createElement("div");
    element.className = "tab";
    element.dataset.id = String(tab.id);
    element.setAttribute("role", "tab");
    element.setAttribute("aria-selected", String(shown));
    element.tabIndex = shown ? 0 : -1;
    element.title = tab.away ? `${tab.away} · ${tab.title}` : tab.title;
    // A tab off the server (signing in elsewhere) shows where it is first, as an address bar would.
    element.classList.toggle("away", !!tab.away);

    const mark = document.createElement("span");
    mark.className = tab.loading ? "icon loading" : "icon";
    if (!tab.loading) {
      if (tab.away) mark.append(globeGlyph());
      else if (tab.icon) mark.textContent = tab.icon;
      else mark.append(pageGlyph());
    }
    const title = document.createElement("span");
    title.className = "title";
    if (tab.away) {
      const where = document.createElement("span");
      where.className = "where";
      where.dir = "ltr";
      where.textContent = tab.away;
      title.append(where, " ", tab.title);
    } else title.textContent = tab.title;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "close";
    close.tabIndex = -1;
    close.setAttribute("aria-label", t.closeTab);
    close.title = t.closeTab;
    close.append(icon(["M4 4l8 8M12 4l-8 8"]));
    close.addEventListener("pointerdown", (event) => event.stopPropagation());
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      bridge.close(tab.id);
    });
    element.append(mark, title, close);
    return element;
  };

  const render = (next: StripState) => {
    state = next;
    document.documentElement.dir = next.dir;
    // Beside the page's sidebar the strip starts past the window's buttons (windows.ts).
    document.documentElement.toggleAttribute("data-clear-of-controls", next.clearOfControls);
    list.setAttribute("aria-label", next.strings.tabs);
    newTab.setAttribute("aria-label", next.strings.newTab);
    newTab.title = next.strings.newTab;
    for (const [button, label, enabled] of [
      [back, next.strings.back, next.canGoBack],
      [forward, next.strings.forward, next.canGoForward],
    ] as const) {
      button.setAttribute("aria-label", label);
      button.title = label;
      button.disabled = !enabled;
    }
    list.replaceChildren(...next.tabs.map((tab) => tabElement(tab, tab.id === next.active, next.strings)));
    markNarrow();
  };

  const markNarrow = () => {
    for (const element of list.children) element.classList.toggle("narrow", (element as HTMLElement).offsetWidth < NARROW);
  };

  /** Where among the other tabs a dragged one goes, by the pointer's place. */
  const dropIndex = (x: number, dragged: HTMLElement) => {
    const others = [...list.children].filter((element) => element !== dragged) as HTMLElement[];
    const rtl = document.documentElement.dir === "rtl";
    let index = 0;
    for (const other of others) {
      const box = other.getBoundingClientRect();
      const middle = box.left + box.width / 2;
      if (rtl ? x < middle : x > middle) index += 1;
    }
    return index;
  };

  const endDrag = () => {
    if (!drag) return;
    const { id, tab, moved } = drag;
    drag = null;
    tab.classList.remove("dragging");
    tab.style.transform = "";
    if (moved) bridge.move(id, [...list.children].indexOf(tab));
    bridge.focus();
    if (waiting) {
      const next = waiting;
      waiting = null;
      render(next);
    }
  };

  list.addEventListener("pointerdown", (event) => {
    const tab = (event.target as HTMLElement).closest<HTMLElement>(".tab");
    if (!tab || event.button !== 0) return;
    const id = Number(tab.dataset.id);
    // A tab is shown as it is pressed, as in a browser; holding it on and moving drags it.
    if (state?.active !== id) bridge.show(id);
    // The pointer is followed on the whole page: the strip may lose the capture (and the focus) as
    // the tab pressed is shown below it.
    list.setPointerCapture(event.pointerId);
    drag = { id, tab, pointer: event.pointerId, startX: event.clientX, grab: event.clientX - tab.offsetLeft, moved: false };
  });

  window.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointer) return;
    // Let go of outside the window: the press is over.
    if (!(event.buttons & 1)) return endDrag();
    if (!drag.moved && Math.abs(event.clientX - drag.startX) < DRAG_THRESHOLD) return;
    drag.moved = true;
    const { tab, grab } = drag;
    tab.classList.add("dragging");
    const index = dropIndex(event.clientX, tab);
    const others = [...list.children].filter((element) => element !== tab);
    const before = others[index] ?? null;
    if (tab.nextElementSibling !== before) list.insertBefore(tab, before);
    // The tab follows the pointer from where it now sits in the row, kept inside the row.
    tab.style.transform = "";
    const left = Math.max(0, Math.min(event.clientX - grab, list.offsetLeft + list.offsetWidth - tab.offsetWidth));
    tab.style.transform = `translateX(${left - tab.offsetLeft}px)`;
  });

  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);

  // A middle click closes a tab, as in a browser.
  list.addEventListener("auxclick", (event) => {
    const tab = (event.target as HTMLElement).closest<HTMLElement>(".tab");
    if (tab && event.button === 1) bridge.close(Number(tab.dataset.id));
  });
  list.addEventListener("mousedown", (event) => {
    if (event.button === 1) event.preventDefault();
  });

  list.addEventListener("contextmenu", (event) => {
    const tab = (event.target as HTMLElement).closest<HTMLElement>(".tab");
    if (!tab) return;
    event.preventDefault();
    bridge.menu(Number(tab.dataset.id));
  });

  // Arrow keys move between the tabs when the strip has the keyboard.
  list.addEventListener("keydown", (event) => {
    if (!state?.tabs.length || state.active === null) return;
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const index = state.tabs.findIndex((tab) => tab.id === state!.active);
    const forward = document.documentElement.dir === "rtl" ? -step : step;
    const next = state.tabs[(index + forward + state.tabs.length) % state.tabs.length];
    bridge.show(next.id);
  });

  newTab.addEventListener("click", () => bridge.add());
  back.addEventListener("click", () => bridge.back());
  forward.addEventListener("click", () => bridge.forward());

  new ResizeObserver(markNarrow).observe(list);

  bridge.onState((next) => {
    if (drag) waiting = next;
    else render(next);
  });
}
