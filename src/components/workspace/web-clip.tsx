"use client";

import { BookmarkPlus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { webClipSetupAction, type WebClipSetup } from "@/app/actions/web-clip";
import { cn, Input, pageLabel, selectClass } from "@/components/ui";
import { iconPrefix } from "@/lib/icon-value";
import type { TreeNode } from "@/server/pages";

const labelClass = "mb-1 block text-xs font-medium text-fg-muted";

const canEdit = (node: TreeNode) => node.level === "edit" || node.level === "full";

/** Tree nodes in sidebar order with their depth, for indented pickers. */
export function flattenTree(tree: TreeNode[]) {
  const ids = new Set(tree.map((n) => n.id));
  const kids = new Map<string | null, TreeNode[]>();
  for (const n of tree) {
    const key = n.parentId && ids.has(n.parentId) ? n.parentId : null;
    kids.set(key, [...(kids.get(key) ?? []), n]);
  }
  const out: { node: TreeNode; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const node of (kids.get(parent) ?? []).sort((a, b) => a.position - b.position)) {
      out.push({ node, depth });
      walk(node.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** Where a web page can be saved in a tree: pages to save under, databases to save into. */
export function webClipTargets(tree: TreeNode[]) {
  const flat = flattenTree(tree).filter(({ node }) => canEdit(node));
  return { pages: flat.filter(({ node }) => node.kind === "page"), databases: flat.filter(({ node }) => node.kind === "database") };
}

/**
 * The target a save form starts with: where the person saved the last time when the tree offers
 * it, else a private page at the top, else (for someone who can't add pages there) the first page.
 */
export function startingTarget(tree: TreeNode[], setup: Pick<WebClipSetup, "last" | "topLevel">): string {
  const { pages, databases } = webClipTargets(tree);
  if (setup.last && [...pages, ...databases].some(({ node }) => node.id === setup.last)) return setup.last;
  return setup.topLevel ? "" : (pages[0]?.node.id ?? databases[0]?.node.id ?? "");
}

/** Whether `value` is a target the picker offers. */
export function validTarget(tree: TreeNode[], topLevel: boolean, value: string) {
  if (!value) return topLevel;
  const { pages, databases } = webClipTargets(tree);
  return [...pages, ...databases].some(({ node }) => node.id === value);
}

/** Picks where a saved web page goes: a private page at the top, under a page, or into a database as a row. */
export function WebClipTargetPicker({
  tree,
  topLevel,
  value,
  onChange,
  disabled,
}: {
  tree: TreeNode[];
  topLevel: boolean;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("import.web");
  const tc = useTranslations("common");
  const { pages, databases } = useMemo(() => webClipTargets(tree), [tree]);
  const label = ({ node, depth }: { node: TreeNode; depth: number }) =>
    `${"  ".repeat(depth)}${iconPrefix(node.icon)}${pageLabel(node.title, tc("untitled"))}`;
  return (
    <label className="block">
      <span className={labelClass}>{t("target")}</span>
      <select className={cn(selectClass, "w-full")} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {topLevel && <option value="">{t("privatePage")}</option>}
        {pages.length > 0 && (
          <optgroup label={t("underPage")}>
            {pages.map((entry) => (
              <option key={entry.node.id} value={entry.node.id}>
                {label(entry)}
              </option>
            ))}
          </optgroup>
        )}
        {databases.length > 0 && (
          <optgroup label={t("intoDatabase")}>
            {databases.map((entry) => (
              <option key={entry.node.id} value={entry.node.id}>
                {label({ ...entry, depth: 0 })}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </label>
  );
}

/**
 * The bookmarklet's code: opens the share page (app/share) with the address and title of the page
 * the person is on, and the text they selected on it. Nothing else of that page is read.
 */
export function bookmarkletCode(appUrl: string): string {
  const share = JSON.stringify(`${appUrl.replace(/\/+$/, "")}/share?`);
  return `javascript:(()=>{const s=String(getSelection()).trim().slice(0,2000),p=new URLSearchParams({url:location.href,title:document.title});if(s)p.set('text',s);window.open(${share}+p,'_blank','noopener')})()`;
}

/** A link to drag to the bookmarks bar (see bookmarkletCode). */
export function Bookmarklet({ appUrl }: { appUrl: string }) {
  const t = useTranslations("import.web.bookmarklet");
  const link = useRef<HTMLAnchorElement>(null);
  // React refuses javascript: addresses in href; this one is ours, written here, not a person's.
  useEffect(() => {
    link.current?.setAttribute("href", bookmarkletCode(appUrl));
  }, [appUrl]);
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="text-sm font-medium">{t("heading")}</p>
      <p className="mt-0.5 text-xs text-fg-muted">{t("help")}</p>
      <a
        ref={link}
        draggable
        onClick={(e) => e.preventDefault()}
        className="mt-2 inline-flex h-8 cursor-grab items-center gap-1.5 rounded-md border border-border bg-bg-subtle px-3 text-sm font-medium text-fg hover:bg-bg-hover active:cursor-grabbing"
      >
        <BookmarkPlus className="h-4 w-4 text-accent" aria-hidden />
        {t("link")}
      </a>
    </div>
  );
}

/** What the import dialog sends to save, once an address is given. */
export type WebClipSetupChoice = { url: string; targetId: string | null };

/**
 * The import dialog's web page tab: the address, where it goes (the person's last choice first)
 * and the bookmarklet. Tells the dialog the choice (or null while it isn't complete) as it changes.
 */
export function WebClipTab({
  workspaceId,
  tree,
  busy,
  onSetup,
}: {
  workspaceId: string;
  tree: TreeNode[];
  busy: boolean;
  onSetup: (setup: WebClipSetupChoice | null) => void;
}) {
  const t = useTranslations("import.web");
  const tc = useTranslations("common");
  const [setup, setSetup] = useState<WebClipSetup | null>(null);
  const [url, setUrl] = useState("");
  const [target, setTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    webClipSetupAction(workspaceId)
      .then((result) => {
        if (!live) return;
        if (!result.ok) return setError(result.error);
        setSetup(result.data);
      })
      .catch(() => live && setError(tc("genericError")));
    return () => {
      live = false;
    };
  }, [workspaceId, tc]);

  // The starting target once the setup is in; the person's own choice after that.
  const chosen = target ?? (setup ? startingTarget(tree, setup) : "");
  const valid = setup !== null && validTarget(tree, setup.topLevel, chosen);
  useEffect(() => {
    onSetup(url.trim() && valid ? { url: url.trim(), targetId: chosen || null } : null);
  }, [url, chosen, valid, onSetup]);

  return (
    <div className="space-y-4">
      <p className="text-sm text-fg-muted">{t("help")}</p>
      <label className="block">
        <span className={labelClass}>{t("url")}</span>
        <Input
          type="url"
          inputMode="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://"
          autoFocus
          disabled={busy}
        />
      </label>
      {setup && <WebClipTargetPicker tree={tree} topLevel={setup.topLevel} value={chosen} onChange={setTarget} disabled={busy} />}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {setup && <Bookmarklet appUrl={setup.appUrl} />}
    </div>
  );
}
