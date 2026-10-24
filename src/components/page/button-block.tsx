"use client";

import { createReactBlockSpec, type DefaultReactSuggestionItem } from "@blocknote/react";
import { Loader2, MousePointerClick, Settings2 } from "lucide-react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { pressButtonAction } from "@/app/actions/buttons";
import { cn, IconButton } from "@/components/ui";
import { BUTTON_BLOCK, buttonBlockConfig, cleanButtonLabel, parseButtonConfig } from "@/lib/buttons";
import { useEmbedHost } from "./database-embed";
import type { PageEditor } from "./embed-blocks";

/**
 * The button block (lib/buttons.ts): a click runs its steps on the server as whoever clicked
 * (server/buttons.ts) and then opens what its last "open" step names. People who may edit the page
 * set it up in its settings, which load only when opened.
 */
const ButtonSettings = dynamic(() => import("./button-settings"), { ssr: false });

/** A button just added from the slash menu: its settings open as it appears. */
let setUpNext = false;

const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

export const ButtonBlock = createReactBlockSpec(buttonBlockConfig, {
  // A control, not text: clicks are its own.
  meta: { selectable: false },
  render: function ButtonBlockView({ block, editor }) {
    const t = useTranslations("page.button");
    const host = useEmbedHost();
    const router = useRouter();
    const label = cleanButtonLabel(block.props.label);
    const icon = block.props.icon;
    const config = useMemo(() => parseButtonConfig(block.props.config), [block.props.config]);
    const editable = Boolean(host?.editable) && editor.isEditable;
    const [setting, setSetting] = useState(() => {
      if (!setUpNext || label || config.steps.length) return false;
      setUpNext = false;
      return true;
    });
    const [running, setRunning] = useState(false);
    const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
    useEffect(() => {
      if (!result?.ok) return;
      const timer = setTimeout(() => setResult(null), 2500);
      return () => clearTimeout(timer);
    }, [result]);

    const press = async () => {
      if (!host || running) return;
      if (!config.steps.length) {
        if (editable) setSetting(true);
        else setResult({ ok: false, text: t("failed.noSteps") });
        return;
      }
      if (config.confirm && !window.confirm(t("confirm", { label: label || t("untitled") }))) return;
      setRunning(true);
      setResult(null);
      try {
        const res = await pressButtonAction(host.pageId, block.id, browserZone());
        if (!res.ok) return setResult({ ok: false, text: res.error });
        setResult({ ok: true, text: t("done") });
        const open = res.data.open;
        if (open?.page) router.push(open.href);
        else if (open) window.open(open.href, "_blank", "noopener,noreferrer");
      } catch {
        setResult({ ok: false, text: t("failed.error") });
      } finally {
        setRunning(false);
      }
    };

    return (
      <div contentEditable={false} className="group/button my-0.5 flex w-full flex-wrap items-center gap-2" data-button-block={block.id}>
        <button
          type="button"
          // Outside the app's pages (history, previews) a button does nothing.
          disabled={!host || running}
          onClick={() => void press()}
          aria-busy={running || undefined}
          className={cn(
            "inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-md border border-border bg-bg px-3 py-1 text-sm font-medium shadow-sm transition-colors",
            "hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-default disabled:opacity-70",
            !label && "text-fg-muted",
          )}
        >
          {running ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden /> : icon ? <span aria-hidden>{icon}</span> : <MousePointerClick className="h-3.5 w-3.5 shrink-0" aria-hidden />}
          <span className="truncate">{label || t("untitled")}</span>
        </button>
        {editable && (
          <IconButton
            label={t("settings.open")}
            onClick={() => setSetting(true)}
            className="opacity-0 focus-visible:opacity-100 group-hover/button:opacity-100 [@media(hover:none)]:opacity-100"
          >
            <Settings2 className="h-3.5 w-3.5" />
          </IconButton>
        )}
        {result && (
          <span role={result.ok ? "status" : "alert"} className={cn("min-w-0 text-xs", result.ok ? "text-fg-muted" : "text-danger")}>
            {result.text}
          </span>
        )}
        {host && editable && setting && (
          <ButtonSettings editor={editor as unknown as PageEditor} blockId={block.id} workspaceId={host.workspaceId} pageId={host.pageId} onClose={() => setSetting(false)} />
        )}
      </div>
    );
  },
  // Copied out of the app, a button is its label.
  toExternalHTML: ({ block }) => <p>{[block.props.icon, cleanButtonLabel(block.props.label)].filter(Boolean).join(" ")}</p>,
});

/** The "Button" slash menu entry: adds a button, whose settings open at once. */
export function useButtonSlashItem(editor: PageEditor, onPlace: (at: string, block: { type: typeof BUTTON_BLOCK; props: { label: string } }) => void): DefaultReactSuggestionItem[] {
  const t = useTranslations("page.button.slash");
  const host = useEmbedHost();
  return useMemo(() => {
    if (!host?.editable) return [];
    return [
      {
        title: t("title"),
        subtext: t("subtext"),
        aliases: t("aliases").split(" "),
        group: editor.dictionary.slash_menu.table.group,
        icon: <MousePointerClick size={18} />,
        onItemClick: () => {
          setUpNext = true;
          onPlace(editor.getTextCursorPosition().block.id, { type: BUTTON_BLOCK, props: { label: "" } });
        },
      },
    ];
  }, [editor, host, t, onPlace]);
}
