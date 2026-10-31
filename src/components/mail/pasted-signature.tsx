"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/components/ui";
import { pastedHtml } from "@/lib/pasted-signature";

/**
 * A pasted signature (lib/pasted-signature.ts) shown as mail shows it: in a shadow root, where the
 * app's styles don't reach it nor its styles the app, on white as the message frame
 * (mail-frame.tsx) draws mail, and never clicked through. The HTML given is cleaned already.
 */

// The signature's own classes are taken out (PASTED_SIGNATURE_CONFIG): `.s` is only this box.
const STYLE = `:host{display:block;color-scheme:light}.s{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#1f2328;overflow-wrap:anywhere;pointer-events:none}img{max-width:100%}`;

/** The box's own classes: white, padded on the dark theme like a message, and scrolled sideways when wider than its place. */
export const PASTED_BOX = "overflow-x-auto overflow-y-hidden bg-white dark:rounded-md dark:p-3";

export function showPasted(host: HTMLElement, html: string) {
  const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${STYLE}</style><div class="s" dir="auto">${html}</div>`;
}

export function PastedSignatureView({ html, className }: { html: string; className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (host.current) showPasted(host.current, html);
  }, [html]);
  return <div ref={host} className={cn(PASTED_BOX, className)} />;
}

/** A mailbox's saved signature that was pasted, as the server kept it. */
export const SavedPastedSignature = ({ signature, className }: { signature: string; className?: string }) => <PastedSignatureView html={pastedHtml(signature) ?? ""} className={className} />;
