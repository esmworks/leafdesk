"use client";

import {
  DeleteLinkButton,
  EditLinkButton,
  LinkToolbar,
  OpenLinkButton,
  useComponentsContext,
  type LinkToolbarProps,
} from "@blocknote/react";
import { AtSign, Bookmark, Check, Link2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { TextSelection } from "prosemirror-state";
import { EMPTY_MENTION, linkedPageRef, MENTION } from "@/lib/mentions";
import { parseWebUrl } from "@/lib/web-url";
import type { PageEditor } from "./embed-blocks";

/**
 * Replaces the text from `from` to `to` (a link, or a pasted address) with a mention of `url`, and
 * puts the cursor after it. False when `url` isn't a web address, or a page of this app (those
 * become page mentions instead).
 */
export function linkToMention(editor: PageEditor, from: number, to: number, url: string): boolean {
  const href = parseWebUrl(url)?.href;
  if (!href || linkedPageRef(href, window.location.origin)) return false;
  editor.transact((tr) => {
    const node = tr.doc.type.schema.nodes[MENTION].create({ ...EMPTY_MENTION, kind: "link", url: href });
    tr.replaceWith(from, to, node);
    tr.setSelection(TextSelection.create(tr.doc, from + node.nodeSize));
  });
  return true;
}

/**
 * The toolbar of a link in the text: BlockNote's buttons, "Copy link" and, when `mentionable` (the
 * page can be edited), "Show as mention" and "Turn into bookmark".
 */
export function LinkToolbarWithMention({ editor, mentionable: allowed, ...props }: LinkToolbarProps & { editor: PageEditor; mentionable: boolean }) {
  const t = useTranslations("page.mention");
  const Components = useComponentsContext()!;
  const [copied, setCopied] = useState(false);
  const href = parseWebUrl(props.url)?.href;
  const mentionable = allowed && Boolean(href && !linkedPageRef(href, window.location.origin));
  return (
    <LinkToolbar {...props}>
      <EditLinkButton
        url={props.url}
        text={props.text}
        range={props.range}
        setToolbarOpen={props.setToolbarOpen}
        setToolbarPositionFrozen={props.setToolbarPositionFrozen}
      />
      <OpenLinkButton url={props.url} />
      <DeleteLinkButton range={props.range} setToolbarOpen={props.setToolbarOpen} />
      {mentionable && (
        <Components.LinkToolbar.Button
          className="bn-button"
          label={t("showAsMention")}
          mainTooltip={t("showAsMention")}
          isSelected={false}
          onClick={() => {
            if (linkToMention(editor, props.range.from, props.range.to, props.url)) props.setToolbarOpen?.(false);
          }}
          icon={<AtSign size={16} />}
        />
      )}
      {mentionable && href && (
        <Components.LinkToolbar.Button
          className="bn-button"
          label={t("toBookmark")}
          mainTooltip={t("toBookmark")}
          isSelected={false}
          onClick={() => {
            const { from, to } = props.range;
            props.setToolbarOpen?.(false);
            void import("./link-bookmark").then(({ linkToBookmark }) => linkToBookmark(editor, from, to, href));
          }}
          icon={<Bookmark size={16} />}
        />
      )}
      <Components.LinkToolbar.Button
        className="bn-button"
        label={copied ? t("linkCopied") : t("copyLink")}
        mainTooltip={copied ? t("linkCopied") : t("copyLink")}
        isSelected={false}
        onClick={() => {
          // A browser that refuses the clipboard leaves the button as it was.
          navigator.clipboard.writeText(props.url).then(
            () => setCopied(true),
            () => {},
          );
        }}
        icon={copied ? <Check size={16} /> : <Link2 size={16} />}
      />
    </LinkToolbar>
  );
}
