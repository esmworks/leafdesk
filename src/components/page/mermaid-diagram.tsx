"use client";

import { useEffect, useState } from "react";
import { useColorScheme } from "@/components/theme/theme-provider";

/**
 * Mermaid diagrams, drawn in the browser for the editor and for published pages.
 *
 * Mermaid is large, so it is loaded the first time a diagram is drawn. It runs with
 * `securityLevel: "strict"` (no click handlers, labels sanitized), and what it draws is shown as an
 * image (`<img src="data:image/svg+xml,…">`), never put into the page: an SVG image can't run
 * scripts, load anything or style the page, whatever the diagram's source says.
 */

type Mermaid = (typeof import("mermaid"))["default"];

let loading: Promise<Mermaid> | null = null;
let theme: string | null = null;
// Mermaid draws one diagram at a time; overlapping renders trip over each other's temporary nodes.
let queue: Promise<unknown> = Promise.resolve();
let counter = 0;

// System fonts: the diagram is measured in the page but shown as an image, which can't load the
// page's web fonts, so both must use a font every system has.
const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

export type MermaidImage = { src: string; width: number; height: number };
export type MermaidResult = { ok: true; image: MermaidImage } | { ok: false; error: string };

function message(error: unknown) {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return text.trim() || "Syntax error";
}

/** The SVG as a standalone image: well-formed XML (Mermaid writes HTML) with its own size. */
function toImage(svg: string): MermaidImage | null {
  const element = new DOMParser().parseFromString(svg, "text/html").querySelector("svg");
  if (!element) return null;
  const [, , width = 0, height = 0] = (element.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
  if (width > 0 && height > 0) {
    element.setAttribute("width", String(width));
    element.setAttribute("height", String(height));
    element.removeAttribute("style");
  }
  const xml = new XMLSerializer().serializeToString(element);
  return { src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`, width, height };
}

export function renderMermaid(source: string, dark: boolean): Promise<MermaidResult> {
  const job = queue.then(async (): Promise<MermaidResult> => {
    loading ??= import("mermaid").then((module) => module.default);
    const mermaid = await loading;
    const wanted = dark ? "dark" : "default";
    if (theme !== wanted) {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: wanted, fontFamily: FONT });
      theme = wanted;
    }
    try {
      await mermaid.parse(source);
    } catch (error) {
      return { ok: false, error: message(error) };
    }
    const id = `leafdesk-mermaid-${++counter}`;
    try {
      const { svg } = await mermaid.render(id, source);
      const image = toImage(svg);
      return image ? { ok: true, image } : { ok: false, error: "Syntax error" };
    } catch (error) {
      return { ok: false, error: message(error) };
    } finally {
      // Mermaid leaves its scratch element behind when a render fails.
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  });
  queue = job.catch(() => undefined);
  return job;
}

/**
 * The drawing of `source`, redrawn a moment after it stops changing. `image` is the last diagram
 * that drew, so a typo while editing doesn't blank it; `error` says what's wrong with the current
 * source. `light` draws it in the light theme whatever the system's is (print).
 */
export function useMermaid(source: string, { light = false }: { light?: boolean } = {}) {
  const dark = useColorScheme() === "dark" && !light;
  const [state, setState] = useState<{ image: MermaidImage | null; error: string | null; pending: boolean }>({
    image: null,
    error: null,
    pending: true,
  });
  useEffect(() => {
    if (!source.trim()) {
      setState({ image: null, error: null, pending: false });
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void renderMermaid(source, dark).then((result) => {
        if (cancelled) return;
        setState((current) =>
          result.ok
            ? { image: result.image, error: null, pending: false }
            : { image: current.image, error: result.error, pending: false },
        );
      });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [source, dark]);
  return state;
}

export function MermaidImageView({ image, label }: { image: MermaidImage; label: string }) {
  return (
    <img
      src={image.src}
      alt={label}
      width={image.width || undefined}
      height={image.height || undefined}
      draggable={false}
      className="mx-auto block h-auto max-w-full"
    />
  );
}

/**
 * A diagram on a published page: its source as a code block until the diagram is drawn, and when
 * it can't be (no JavaScript, a mistake in the source). `light` for print (see useMermaid);
 * `data-leafdesk-mermaid` is "pending" until it is drawn or has failed, so the print view knows
 * when everything is ready.
 */
export function PublishedMermaid({ source, label, light = false }: { source: string; label: string; light?: boolean }) {
  const { image, error, pending } = useMermaid(source, { light });
  const state = pending ? "pending" : "done";
  if (image && !error) {
    return (
      <figure className="my-2 overflow-x-auto" data-leafdesk-mermaid={state}>
        <MermaidImageView image={image} label={label} />
      </figure>
    );
  }
  return (
    <pre data-leafdesk-mermaid={state}>
      <code className="language-mermaid">{source}</code>
    </pre>
  );
}
