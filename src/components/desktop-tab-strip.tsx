"use client";

import { useEffect } from "react";

/**
 * The desktop app on macOS (`<html data-tab-strip>`, set by its preload) lays its tab strip over
 * the page beside the sidebar, which runs the window's full height (globals.css). This tells it
 * where: `<html data-tab-strip-room="left right">`, what the open sidebar takes of the page's width
 * at its left and right edges in CSS pixels, or "none" on pages without a sidebar and in
 * phone-sized windows, where the strip goes above the page.
 * On every system it also tells the strip, which the page can't draw over, the shade a dialog's
 * backdrop lays over the window (`[data-window-shade]`): `<html data-tab-strip-shade="<color>">`.
 */
export function DesktopTabStrip() {
  useEffect(() => {
    const root = document.documentElement;
    if (!root.hasAttribute("data-desktop-app")) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      // The last one shown is on top; a hidden one (a phone's sidebar backdrop in a wide window) shades nothing.
      const shown = [...document.querySelectorAll("[data-window-shade]")].filter((each) => each.getClientRects().length > 0).at(-1);
      const shade = shown ? getComputedStyle(shown).backgroundColor : null;
      if (shade) {
        if (root.getAttribute("data-tab-strip-shade") !== shade) root.setAttribute("data-tab-strip-shade", shade);
      } else root.removeAttribute("data-tab-strip-shade");
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      mutations.disconnect();
      window.removeEventListener("resize", schedule);
      root.removeAttribute("data-tab-strip-shade");
    };
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    if (!root.hasAttribute("data-tab-strip")) return;
    const wide = window.matchMedia("(min-width: 768px)");
    let frame = 0;
    let observed: Element | null = null;
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const resize = new ResizeObserver(schedule);
    const measure = () => {
      frame = 0;
      const sidebar = document.querySelector("[data-sidebar]");
      if (sidebar !== observed) {
        if (observed) resize.unobserve(observed);
        if (sidebar) resize.observe(sidebar);
        observed = sidebar;
      }
      let room = "none";
      let left = 0;
      let right = 0;
      if (sidebar && wide.matches) {
        // Hidden, the sidebar floats over the page and the strip runs the whole width.
        const box = sidebar.hasAttribute("data-sidebar-open") && getComputedStyle(sidebar).position !== "fixed" ? sidebar.getBoundingClientRect() : null;
        const rtl = root.dir === "rtl";
        left = Math.max(0, Math.round(box && !rtl ? box.right : 0));
        right = Math.max(0, Math.round(box && rtl ? window.innerWidth - box.left : 0));
        room = `${left} ${right}`;
      }
      if (root.getAttribute("data-tab-strip-room") !== room) root.setAttribute("data-tab-strip-room", room);
      // The page's own region moving the window stops where the strip starts, and the line under
      // the strip runs between its ends (globals.css).
      root.style.setProperty("--tab-strip-start", `${left}px`);
      root.style.setProperty("--tab-strip-end", `${right}px`);
    };
    // The sidebar comes and goes with the route, and is hidden or shown.
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-sidebar-open"] });
    window.addEventListener("resize", schedule);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, []);
  return null;
}
