"use client";

import {
  Bookmark,
  ChevronRight,
  ChevronsUpDown,
  Database,
  File as FileIcon,
  Image as ImageIcon,
  MonitorPlay,
  Music,
  Route,
  Square,
  SquareCheck,
  TableOfContents,
  Video,
} from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useMemo, useState, type ReactNode } from "react";
import type { diffSnapshotAction } from "@/app/actions/pages";
import { cn } from "@/components/ui";
import { DATABASE_BLOCK, isEmbedBlockType } from "@/lib/embed-blocks";
import { foldUnchanged, onlyFormatChanged, type BlockChange, type DiffBlock, type WordSegment } from "@/lib/page-diff";

export type VersionDiff = NonNullable<Awaited<ReturnType<typeof diffSnapshotAction>>>;

function Words({ words }: { words: WordSegment[] }) {
  return words.map((w, i) =>
    w.op === "eq" ? (
      <span key={i}>{w.text}</span>
    ) : w.op === "add" ? (
      <ins key={i} className="rounded-sm bg-added-bg text-added-fg underline decoration-added-bar underline-offset-2">
        {w.text}
      </ins>
    ) : (
      <del key={i} className="rounded-sm bg-removed-bg text-removed-fg line-through decoration-removed-bar">
        {w.text}
      </del>
    ),
  );
}

const MEDIA_ICONS: Record<string, typeof FileIcon> = {
  image: ImageIcon,
  video: Video,
  audio: Music,
  file: FileIcon,
  bookmark: Bookmark,
  webEmbed: MonitorPlay,
};

/** A block drawn by its type, close to how the editor shows it, with `text` as its content. */
function BlockBody({ block, text }: { block: DiffBlock; text: ReactNode }) {
  const marker = (m: ReactNode) => (
    <div className="flex gap-2">
      <span className="shrink-0 select-none text-fg-muted">{m}</span>
      <div className="min-w-0 flex-1 whitespace-pre-wrap">{text}</div>
    </div>
  );
  switch (block.type) {
    case "heading":
      return (
        <div
          className={cn(
            "whitespace-pre-wrap font-semibold",
            block.level === 1 ? "text-2xl" : block.level === 2 ? "text-xl" : "text-lg",
          )}
        >
          {text}
        </div>
      );
    case "bulletListItem":
      return marker("•");
    case "numberedListItem":
      return marker(`${block.ordinal ?? 1}.`);
    case "toggleListItem":
      return marker(<ChevronRight className="mt-1 h-4 w-4" />);
    case "checkListItem":
      return marker(block.checked ? <SquareCheck className="mt-1 h-4 w-4" /> : <Square className="mt-1 h-4 w-4" />);
    case "quote":
      return <div className="whitespace-pre-wrap border-l-[3px] border-fg-faint pl-3">{text}</div>;
    case "codeBlock":
    case "math":
    case "mermaid":
      return <pre className="whitespace-pre-wrap rounded-md bg-bg-subtle px-3 py-2 font-mono text-sm">{text}</pre>;
    case "callout":
      return (
        <div className="flex gap-2 rounded-md bg-bg-subtle px-3 py-2">
          {block.icon && <span className="shrink-0 select-none">{block.icon}</span>}
          <div className="min-w-0 flex-1 whitespace-pre-wrap">{text}</div>
        </div>
      );
    case "tableOfContents":
      return marker(<TableOfContents className="mt-1 h-4 w-4" />);
    case "breadcrumb":
      return marker(<Route className="mt-1 h-4 w-4" />);
    case "table":
      return <div className="whitespace-pre-wrap text-sm">{text}</div>;
    case "divider":
      return <hr className="my-3 border-border" />;
    case "database":
    case "linkedView":
      return marker(<Database className="mt-1 h-4 w-4" />);
    default: {
      const Icon = MEDIA_ICONS[block.type];
      if (Icon) return marker(<Icon className="mt-1 h-4 w-4" />);
      return <div className="whitespace-pre-wrap">{text}</div>;
    }
  }
}

const BAR = { same: "border-transparent", added: "border-added-bar", removed: "border-removed-bar", changed: "border-accent" };

function ChangeRow({ change }: { change: BlockChange }) {
  const t = useTranslations("page.history");
  const te = useTranslations("page.embed");
  const tb = useTranslations("page.blocks");
  const { block } = change;
  // A database block is only named: the version keeps which database, not its rows back then.
  // An empty block still takes a line (a no-break space), so an added or removed empty paragraph shows.
  const plain = isEmbedBlockType(block.type)
    ? te(block.type === DATABASE_BLOCK ? "label" : "linkedLabel")
    : block.type === "tableOfContents"
      ? tb("toc.label")
      : block.type === "breadcrumb"
        ? tb("breadcrumb.label")
        : block.text || "\u00a0";
  const text =
    change.op === "changed" ? (
      <Words words={change.words} />
    ) : change.op === "added" ? (
      <Words words={[{ op: "add", text: plain }]} />
    ) : change.op === "removed" ? (
      <Words words={[{ op: "del", text: plain }]} />
    ) : (
      plain
    );
  return (
    <div
      className={cn("border-l-2 py-1 pl-3", BAR[change.op], change.op === "same" && "opacity-50")}
      style={block.depth ? { marginLeft: `${block.depth * 1.5}rem` } : undefined}
    >
      <BlockBody block={block} text={text} />
      {onlyFormatChanged(change) && <p className="mt-0.5 text-xs text-fg-muted">{t("diff.formatOnly")}</p>}
    </div>
  );
}

/**
 * The changes between two versions: changed blocks with their words marked, unchanged blocks
 * dimmed, and longer unchanged stretches folded until opened.
 */
export function HistoryDiff({ diff, range }: { diff: VersionDiff; range: string }) {
  const t = useTranslations("page.history");
  const tc = useTranslations("common");
  const format = useFormatter();
  const [opened, setOpened] = useState<ReadonlySet<number>>(new Set());
  const items = useMemo(() => foldUnchanged(diff.changes), [diff]);
  const changed = diff.title !== null || diff.changes.some((c) => c.op !== "same");
  const actors = diff.actors.map((a) =>
    a.client
      ? a.name
        ? t("diff.actorApp", { client: a.client, name: a.name })
        : a.client
      : a.isAgent && a.name
        ? tc("agentName", { name: a.name })
        : (a.name ?? ""),
  );

  return (
    <div className="px-4 md:px-12">
      <p className="text-xs text-fg-muted">{range}</p>
      {changed && actors.length > 0 && (
        <p className="mt-1 text-xs text-fg-muted">{t("diff.changedBy", { names: format.list(actors) })}</p>
      )}
      {!changed ? (
        <p className="mt-6 text-sm text-fg-muted">{t("diff.none")}</p>
      ) : (
        <div className="mt-5 space-y-0.5 leading-relaxed">
          {diff.title && (
            <h1 className="mb-4 text-3xl font-bold">
              <Words words={diff.title} />
            </h1>
          )}
          {items.map((item, i) =>
            item.op !== "hidden" ? (
              <ChangeRow key={i} change={item} />
            ) : opened.has(i) ? (
              item.blocks.map((block, j) => <ChangeRow key={`${i}-${j}`} change={{ op: "same", block }} />)
            ) : (
              <button
                key={i}
                type="button"
                onClick={() => setOpened((s) => new Set(s).add(i))}
                className="flex w-full items-center gap-2 rounded-md px-3 py-1 text-left text-xs text-fg-muted hover:bg-bg-hover hover:text-fg"
              >
                <ChevronsUpDown className="h-3.5 w-3.5" />
                {t("diff.showUnchanged", { count: item.blocks.length })}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
