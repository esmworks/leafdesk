"use client";

import { Search } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { googleDocsSourcesAction, searchGoogleDocsAction } from "@/app/actions/google-docs-import";
import { Button, Input, textareaClass } from "@/components/ui";
import { googleDocIds, MAX_GOOGLE_DOCS, type GoogleDoc, type GoogleDocsSource } from "@/lib/import/google-docs";

const selectClass = "h-8 w-full rounded-md border border-border bg-bg px-2 text-sm outline-none focus:border-accent disabled:opacity-60";
const labelClass = "mb-1 block text-xs font-medium text-fg-muted";

/** What the import dialog sends to import, once documents are chosen. */
export type GoogleDocsSetup = { connectionId: string; ids: string[] };

/**
 * The import dialog's Google Docs tab: the Google Drive connection to read through (the ones the
 * person may use), links to documents pasted, and documents found by title and ticked. Tells the
 * dialog the setup (or null while nothing is chosen) as it changes. Asks for the connections only
 * when it opens: listing them reads the workspace's settings, not Google.
 */
export function GoogleDocsTab({
  workspaceId,
  busy,
  destinationPicker,
  onSetup,
}: {
  workspaceId: string;
  busy: boolean;
  destinationPicker: React.ReactNode;
  onSetup: (setup: GoogleDocsSetup | null) => void;
}) {
  const t = useTranslations("import");
  const tc = useTranslations("common");
  const format = useFormatter();
  const [sources, setSources] = useState<GoogleDocsSource[] | null>(null);
  const [connectionId, setConnectionId] = useState("");
  const [links, setLinks] = useState("");
  const [words, setWords] = useState("");
  const [found, setFound] = useState<{ docs: GoogleDoc[]; next: string | null; words: string } | null>(null);
  const [ticked, setTicked] = useState<GoogleDoc[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    googleDocsSourcesAction(workspaceId)
      .then((result) => {
        if (!live) return;
        if (!result.ok) return setError(result.error);
        setSources(result.data);
        setConnectionId(result.data[0]?.id ?? "");
      })
      .catch(() => live && setError(tc("genericError")));
    return () => {
      live = false;
    };
  }, [workspaceId, tc]);

  const source = sources?.find((s) => s.id === connectionId) ?? null;
  const pasted = useMemo(() => googleDocIds(links), [links]);
  const ids = useMemo(() => [...new Set([...pasted.ids, ...ticked.map((d) => d.id)])], [pasted.ids, ticked]);

  useEffect(() => {
    onSetup(connectionId && ids.length && ids.length <= MAX_GOOGLE_DOCS && !pasted.invalid.length ? { connectionId, ids } : null);
  }, [connectionId, ids, pasted.invalid.length, onSetup]);

  async function search(more: boolean) {
    if (!source?.search) return;
    setSearching(true);
    setError(null);
    try {
      const query = more && found ? found.words : words;
      const result = await searchGoogleDocsAction({ connectionId, words: query, pageToken: more ? found?.next : null });
      if (!result.ok) return setError(result.error);
      setFound({
        docs: more && found ? [...found.docs, ...result.data.docs.filter((d) => !found.docs.some((f) => f.id === d.id))] : result.data.docs,
        next: result.data.next,
        words: query,
      });
    } catch {
      setError(tc("genericError"));
    } finally {
      setSearching(false);
    }
  }

  const toggle = (doc: GoogleDoc) =>
    setTicked((list) => (list.some((d) => d.id === doc.id) ? list.filter((d) => d.id !== doc.id) : [...list, doc]));

  if (sources === null) {
    return error ? (
      <p role="alert" className="text-sm text-danger">
        {error}
      </p>
    ) : (
      <p className="text-sm text-fg-muted">{t("googleDocs.loading")}</p>
    );
  }
  if (!sources.length) {
    return (
      <div className="space-y-2 text-sm text-fg-muted">
        <p>{t("googleDocs.help")}</p>
        <p className="rounded-lg border border-border px-3 py-2">{t("googleDocs.noConnection")}</p>
      </div>
    );
  }

  const disabled = busy || searching;
  return (
    <>
      <p className="text-sm text-fg-muted">{t("googleDocs.help")}</p>
      {sources.length > 1 && (
        <label className="block">
          <span className={labelClass}>{t("googleDocs.connection")}</span>
          <select
            className={selectClass}
            value={connectionId}
            disabled={disabled}
            onChange={(e) => {
              setConnectionId(e.target.value);
              setFound(null);
              setTicked([]);
            }}
          >
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {sources.length === 1 && <p className="text-xs text-fg-muted">{t("googleDocs.through", { name: sources[0].name })}</p>}

      <label className="block">
        <span className={labelClass}>{t("googleDocs.links")}</span>
        <textarea
          className={textareaClass}
          rows={2}
          value={links}
          disabled={busy}
          placeholder={t("googleDocs.linksPlaceholder")}
          onChange={(e) => setLinks(e.target.value)}
        />
      </label>
      {pasted.invalid.length > 0 && (
        <p role="alert" className="text-xs text-danger">
          {t("googleDocs.invalidLink", { link: pasted.invalid[0].slice(0, 80) })}
        </p>
      )}

      {source?.search ? (
        <div className="space-y-2">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void search(false);
            }}
          >
            <Input
              value={words}
              disabled={disabled}
              aria-label={t("googleDocs.search")}
              placeholder={t("googleDocs.searchPlaceholder")}
              onChange={(e) => setWords(e.target.value)}
            />
            <Button type="submit" className="shrink-0" disabled={disabled}>
              <Search className="h-4 w-4" />
              {searching ? t("googleDocs.searching") : t("googleDocs.search")}
            </Button>
          </form>
          {found && (
            <div className="rounded-lg border border-border">
              {found.docs.length ? (
                <ul className="max-h-56 divide-y divide-border overflow-y-auto">
                  {found.docs.map((doc) => (
                    <li key={doc.id}>
                      <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-bg-hover">
                        <input
                          type="checkbox"
                          checked={ticked.some((d) => d.id === doc.id)}
                          disabled={busy}
                          onChange={() => toggle(doc)}
                        />
                        <span className="min-w-0 flex-1 truncate">{doc.title || tc("untitled")}</span>
                        {doc.modifiedTime && (
                          <span className="shrink-0 text-xs text-fg-faint">{format.dateTime(new Date(doc.modifiedTime), { dateStyle: "medium" })}</span>
                        )}
                      </label>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-3 py-2 text-sm text-fg-muted">{t("googleDocs.noneFound")}</p>
              )}
              {found.next && (
                <div className="border-t border-border px-3 py-1.5">
                  <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void search(true)}>
                    {t("googleDocs.more")}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <p className="text-xs text-fg-muted">{t("googleDocs.linksOnly")}</p>
      )}

      {ids.length > 0 && (
        <div className="flex items-center justify-between gap-2 text-xs text-fg-muted">
          <span className={ids.length > MAX_GOOGLE_DOCS ? "text-danger" : undefined}>
            {ids.length > MAX_GOOGLE_DOCS ? t("googleDocs.tooMany", { limit: MAX_GOOGLE_DOCS }) : t("googleDocs.chosen", { count: ids.length })}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setTicked([]);
              setLinks("");
            }}
          >
            {t("pages.clear")}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {destinationPicker}
    </>
  );
}
