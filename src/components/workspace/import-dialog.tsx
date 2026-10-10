"use client";

import { FileUp, FolderUp, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { importTargetAction, type ImportTarget } from "@/app/actions/import";
import { usePropertyTypeLabel } from "@/components/database/property-icons";
import { Button, cn, Dialog, IconButton, Input, pageLabel } from "@/components/ui";
import { formatBytes } from "@/lib/files";
import {
  CSV_COLUMN_TYPES,
  CSV_MAX_COLUMNS,
  CSV_MAX_ROWS,
  csvTable,
  decodeText,
  guessColumn,
  guessTitleColumn,
  type CsvColumnType,
  type CsvTable,
} from "@/lib/import/csv";
import { cleanTitle, IMPORT_LIMITS, isIgnoredPath } from "@/lib/import/markdown";
import { isVaultSettingsPath } from "@/lib/import/obsidian";
import { ImportError, type ImportResult, type ImportWarning } from "@/lib/import/result";
import { isWorkbook, readWorkbook } from "@/lib/import/xlsx";
import type { TreeNode } from "@/server/pages";

const selectClass = "h-8 w-full rounded-md border border-border bg-bg px-2 text-sm outline-none focus:border-accent disabled:opacity-60";
const labelClass = "mb-1 block text-xs font-medium text-fg-muted";

const canEdit = (node: TreeNode) => node.level === "edit" || node.level === "full";

/** Tree nodes in sidebar order with their depth, for indented pickers. */
function flatten(tree: TreeNode[]) {
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

type Picked = { file: File; path: string };

/** What the Word tab's file picker offers, and what it takes from a drop. */
const DOCX_ACCEPT = ".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const isDocx = (file: File) => /\.docx$/i.test(file.name);
/** The chosen CSV file or workbook; a workbook's sheets by name, and the one shown. */
type CsvState = { file: File; table: CsvTable; guesses: CsvColumnType[]; sheets: string[]; sheet: number };

/**
 * Imports Markdown files, folders and ZIPs as pages, Word documents as a page each, or a CSV file
 * or Excel workbook (one of its sheets) as a new database or as rows of an existing one (with a
 * column → property mapping). Sends everything to /api/import and shows what was created and what
 * was left out.
 */
export function ImportDialog({
  workspaceId,
  open,
  onClose,
  tree,
  topLevel,
  activeId,
  teamspaceId,
}: {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
  tree: TreeNode[];
  /** Whether the user may add top-level pages. */
  topLevel: boolean;
  /** The page open now: the default destination, or the database to add rows to. */
  activeId: string | null;
  /** Where top-level imports go: a teamspace, null for private, undefined for the workspace default. */
  teamspaceId?: string | null;
}) {
  const router = useRouter();
  const t = useTranslations("import");
  const tc = useTranslations("common");
  const typeLabel = usePropertyTypeLabel();

  const flat = useMemo(() => flatten(tree), [tree]);
  const destinations = flat.filter(({ node }) => node.kind === "page" && canEdit(node));
  const databases = flat.filter(({ node }) => node.kind === "database" && canEdit(node));
  const activeNode = tree.find((n) => n.id === activeId);

  const [tab, setTab] = useState<"pages" | "docx" | "csv">("pages");
  const [destination, setDestination] = useState("");
  const [picked, setPicked] = useState<Picked[]>([]);
  // A folder that came with an Obsidian vault's settings folder (which isn't sent).
  const [vault, setVault] = useState(false);
  const [documents, setDocuments] = useState<File[]>([]);
  const [csv, setCsv] = useState<CsvState | null>(null);
  const [csvMode, setCsvMode] = useState<"new" | "existing">("new");
  const [name, setName] = useState("");
  const [titleColumn, setTitleColumn] = useState<number | null>(0);
  const [types, setTypes] = useState<(CsvColumnType | null)[]>([]);
  const [databaseId, setDatabaseId] = useState("");
  const [target, setTarget] = useState<ImportTarget | null | "error">(null);
  const [mapping, setMapping] = useState<(string | null)[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const csvInput = useRef<HTMLInputElement>(null);
  const docxInput = useRef<HTMLInputElement>(null);

  // Fresh each time it opens, aimed at the page (or database) open now.
  useEffect(() => {
    if (!open) return;
    const activeEditable = activeNode && canEdit(activeNode);
    setTab(activeEditable && activeNode.kind === "database" ? "csv" : "pages");
    setDestination(
      activeEditable && activeNode.kind === "page" ? activeNode.id : topLevel ? "" : (destinations[0]?.node.id ?? ""),
    );
    setPicked([]);
    setVault(false);
    setDocuments([]);
    setCsv(null);
    setCsvMode(activeEditable && activeNode.kind === "database" ? "existing" : "new");
    setDatabaseId(activeEditable && activeNode.kind === "database" ? activeNode.id : "");
    setError(null);
    setResult(null);
    setBusy(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- resets only when the dialog opens, not while the tree changes
  }, [open]);

  useEffect(() => {
    folderInput.current?.setAttribute("webkitdirectory", "");
  }, [open, tab, result]);

  // The chosen database's properties, and where each column goes by default: a property of the
  // same name, else the title for the column that looks like one.
  useEffect(() => {
    setTarget(null);
    if (!databaseId) return;
    let live = true;
    importTargetAction(databaseId).then(
      (loaded) => live && setTarget(loaded ?? "error"),
      () => live && setTarget("error"),
    );
    return () => {
      live = false;
    };
  }, [databaseId]);
  useEffect(() => {
    if (!csv || !target || target === "error") return;
    const guessedTitle = guessTitleColumn(csv.table.headers);
    const used = new Set<string>();
    setMapping(
      csv.table.headers.map((header, i) => {
        const prop = target.properties.find((p) => p.name.trim().toLowerCase() === header.toLowerCase() && !used.has(p.id));
        if (prop) {
          used.add(prop.id);
          return prop.id;
        }
        return i === guessedTitle && !used.has("title") ? (used.add("title"), "title") : null;
      }),
    );
  }, [csv, target]);

  const destinationValid = destination ? destinations.some((d) => d.node.id === destination) : topLevel;
  const totalSize = picked.reduce((sum, p) => sum + p.file.size, 0);
  const documentsSize = documents.reduce((sum, f) => sum + f.size, 0);

  function addFiles(list: FileList | File[] | null) {
    if (!list) return;
    // Hidden folders (an app's settings, such as a vault's .obsidian) and system files aren't sent:
    // the import leaves them out anyway. A vault's settings folder still says it is one.
    const all = [...list].map((file) => ({ file, path: file.webkitRelativePath || file.name }));
    if (all.some((p) => isVaultSettingsPath(p.path))) setVault(true);
    const next = all.filter((p) => !isIgnoredPath(p.path));
    setPicked((prev) => [...prev.filter((p) => !next.some((n) => n.path === p.path)), ...next]);
    setError(null);
  }

  /** Adds Word documents to the list (by name: choosing one again replaces it); other files are passed over. */
  function addDocuments(list: FileList | File[] | null) {
    if (!list) return;
    const next = [...list].filter(isDocx);
    setDocuments((prev) => [...prev.filter((f) => !next.some((n) => n.name === f.name)), ...next]);
    setError(null);
  }

  /** Reads a CSV file, or sheet `sheet` of a workbook, for the column table and the import. */
  async function chooseCsv(file: File | undefined, sheet = 0) {
    if (!file) return;
    setError(null);
    let table: CsvTable;
    let sheets: string[] = [];
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (isWorkbook(file.name, bytes)) {
        const book = readWorkbook(bytes);
        sheets = book.sheets.map((s) => s.name);
        table = book.table(sheet);
      } else table = csvTable(decodeText(bytes));
    } catch (e) {
      if (e instanceof ImportError) return setError(errorText({ code: e.code, params: e.params }));
      return setError(t("errors.badWorkbook"));
    }
    if (!table.headers.length) return setError(t("errors.emptyCsv"));
    if (table.headers.length > CSV_MAX_COLUMNS) return setError(t("errors.tooManyColumns", { limit: CSV_MAX_COLUMNS }));
    if (table.rows.length > CSV_MAX_ROWS) return setError(t("errors.tooManyRows", { limit: CSV_MAX_ROWS }));
    const guesses = table.headers.map((_, i) => guessColumn(table.rows.map((r) => r[i])).type);
    setCsv({ file, table, guesses, sheets, sheet });
    setName(cleanTitle(file.name));
    setTitleColumn(guessTitleColumn(table.headers));
    setTypes(guesses);
  }

  function errorText(body: { code?: string; params?: Record<string, string | number> } | null) {
    const code = body?.code ?? "badRequest";
    const params = { ...body?.params };
    if (code === "tooLarge" && typeof params.limit === "number") params.limit = formatBytes(params.limit);
    const known = [
      "tooLarge",
      "tooManyFiles",
      "tooManyPages",
      "tooManyRows",
      "tooManyColumns",
      "badZip",
      "nothingToImport",
      "emptyCsv",
      "badWorkbook",
      "unsupportedWorkbook",
      "badDocx",
      "docxTooComplex",
      "badMapping",
      "noAccess",
      "notADatabase",
    ];
    return known.includes(code) ? t(`errors.${code}` as "errors.badRequest", params) : t("errors.badRequest");
  }

  async function submit() {
    setError(null);
    const form = new FormData();
    form.append("workspaceId", workspaceId);
    if (teamspaceId !== undefined) form.append("teamspaceId", teamspaceId ?? "private");
    if (tab === "pages") {
      if (totalSize > IMPORT_LIMITS.uploadBytes) return setError(t("errors.tooLarge", { limit: formatBytes(IMPORT_LIMITS.uploadBytes) }));
      form.append("mode", "pages");
      form.append("parentId", destination);
      if (vault) form.append("vault", "1");
      for (const p of picked) {
        form.append("file", p.file, p.file.name);
        form.append("path", p.path);
      }
    } else if (tab === "docx") {
      if (documentsSize > IMPORT_LIMITS.uploadBytes) return setError(t("errors.tooLarge", { limit: formatBytes(IMPORT_LIMITS.uploadBytes) }));
      form.append("mode", "docx");
      form.append("parentId", destination);
      for (const file of documents) form.append("file", file, file.name);
    } else if (csv && csvMode === "new") {
      form.append("mode", "csv-new");
      form.append("parentId", destination);
      form.append("title", name);
      form.append("titleColumn", titleColumn === null ? "" : String(titleColumn));
      form.append("types", JSON.stringify(types));
      if (csv.sheets.length) form.append("sheet", String(csv.sheet));
      form.append("file", csv.file, csv.file.name);
    } else if (csv) {
      form.append("mode", "csv-merge");
      form.append("databaseId", databaseId);
      form.append("mapping", JSON.stringify(mapping));
      if (csv.sheets.length) form.append("sheet", String(csv.sheet));
      form.append("file", csv.file, csv.file.name);
    }
    setBusy(true);
    try {
      const response = await fetch("/api/import", { method: "POST", body: form, headers: { "X-Leafdesk-Import": "1" } });
      const body = await response.json().catch(() => null);
      if (!response.ok) setError(errorText(body));
      else setResult(body as ImportResult);
    } catch {
      setError(tc("genericError"));
    } finally {
      setBusy(false);
    }
  }

  function warningText(w: ImportWarning) {
    switch (w.code) {
      case "invalidValues":
        return t("warnings.invalidValues", { count: w.count, column: w.column });
      case "missingFile":
        return t("warnings.missingFile", { path: w.path, page: w.page });
      case "unresolvedLink":
        return t("warnings.unresolvedLink", { target: w.target, page: w.page });
      case "fileNotStored":
        return t(`warnings.fileNotStored.${w.reason}`, { path: w.path });
      case "skipped":
        return t(`warnings.skipped.${w.reason}`, { path: w.path });
    }
  }

  const ready =
    !busy &&
    (tab === "pages"
      ? picked.length > 0 && destinationValid
      : tab === "docx"
        ? documents.length > 0 && destinationValid
        : csv !== null &&
        (csvMode === "new"
          ? destinationValid && types.some((type, i) => type !== null || i === titleColumn)
          : target !== null && target !== "error" && mapping.some((m) => m !== null)));

  const sample = (i: number) =>
    (csv?.table.rows ?? [])
      .map((r) => r[i].trim())
      .filter(Boolean)
      .slice(0, 3)
      .join(", ")
      .slice(0, 60);

  const destinationPicker = (
    <label className="block">
      <span className={labelClass}>{t("destination")}</span>
      {destinations.length === 0 && !topLevel ? (
        <p className="text-sm text-fg-muted">{t("noDestination")}</p>
      ) : (
        <select className={selectClass} value={destination} disabled={busy} onChange={(e) => setDestination(e.target.value)}>
          {topLevel && <option value="">{t("topLevel")}</option>}
          {destinations.map(({ node, depth }) => (
            <option key={node.id} value={node.id}>
              {`${"  ".repeat(depth)}${node.icon ? `${node.icon} ` : ""}${pageLabel(node.title, tc("untitled"))}`}
            </option>
          ))}
        </select>
      )}
    </label>
  );

  return (
    <Dialog open={open} onClose={busy ? () => {} : onClose} className="max-w-2xl">
      <div className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-medium">{result ? t("done.title") : t("title")}</h2>
          {!result && <p className="mt-0.5 text-xs text-fg-muted">{t("description")}</p>}
        </div>
        <IconButton label={tc("close")} onClick={onClose} disabled={busy}>
          <X className="h-3.5 w-3.5" />
        </IconButton>
      </div>

      {result ? (
        <ResultView
          result={result}
          warningText={warningText}
          onOpen={() => {
            const first = result.pages[0];
            onClose();
            if (first) router.push(`/w/${workspaceId}/p/${first.id}`);
          }}
          onAgain={() => {
            setResult(null);
            setPicked([]);
            setVault(false);
            setDocuments([]);
            setCsv(null);
          }}
        />
      ) : (
        <div className="max-h-[70vh] space-y-4 overflow-y-auto p-4" aria-busy={busy}>
          <div role="tablist" aria-label={t("title")} className="inline-flex gap-0.5 rounded-lg bg-bg-hover p-0.5">
            {(["pages", "docx", "csv"] as const).map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                disabled={busy}
                onClick={() => {
                  setTab(key);
                  setError(null);
                }}
                className={cn(
                  "flex h-7 items-center rounded-md px-2.5 text-sm transition-colors",
                  tab === key ? "bg-bg font-medium text-fg shadow-sm" : "text-fg-muted hover:text-fg",
                )}
              >
                {t(`tabs.${key}`)}
              </button>
            ))}
          </div>

          {tab === "pages" ? (
            <>
              <p className="text-sm text-fg-muted">{t("pages.help")}</p>
              <p className="text-sm text-fg-muted">{t("pages.notion")}</p>
              <p className="text-sm text-fg-muted">{t("pages.obsidian")}</p>
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  addFiles(e.dataTransfer.files);
                }}
                className={cn(
                  "flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border px-3 py-3",
                  dragOver && "border-accent bg-accent/5",
                )}
              >
                <Button disabled={busy} onClick={() => filesInput.current?.click()}>
                  <FileUp className="h-4 w-4" />
                  {t("pages.chooseFiles")}
                </Button>
                <Button disabled={busy} onClick={() => folderInput.current?.click()}>
                  <FolderUp className="h-4 w-4" />
                  {t("pages.chooseFolder")}
                </Button>
                <span className="text-xs text-fg-faint">{t("pages.drop")}</span>
                <input
                  ref={filesInput}
                  type="file"
                  multiple
                  hidden
                  data-import="files"
                  onChange={(e) => {
                    addFiles(e.target.files);
                    e.target.value = "";
                  }}
                />
                <input
                  ref={folderInput}
                  type="file"
                  multiple
                  hidden
                  data-import="folder"
                  onChange={(e) => {
                    addFiles(e.target.files);
                    e.target.value = "";
                  }}
                />
              </div>
              {picked.length > 0 && (
                <div className="rounded-lg border border-border">
                  <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-xs text-fg-muted">
                    <span>{t("pages.selected", { count: picked.length, size: formatBytes(totalSize) })}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        setPicked([]);
                        setVault(false);
                      }}
                    >
                      {t("pages.clear")}
                    </Button>
                  </div>
                  <ul className="max-h-32 overflow-y-auto px-3 py-1.5 text-xs text-fg-muted">
                    {picked.slice(0, 50).map((p) => (
                      <li key={p.path} className="truncate">
                        {p.path}
                      </li>
                    ))}
                    {picked.length > 50 && <li>…</li>}
                  </ul>
                </div>
              )}
              {destinationPicker}
            </>
          ) : tab === "docx" ? (
            <>
              <p className="text-sm text-fg-muted">{t("docx.help")}</p>
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  addDocuments(e.dataTransfer.files);
                }}
                className={cn(
                  "flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border px-3 py-3",
                  dragOver && "border-accent bg-accent/5",
                )}
              >
                <Button disabled={busy} onClick={() => docxInput.current?.click()}>
                  <FileUp className="h-4 w-4" />
                  {t("docx.choose")}
                </Button>
                <span className="text-xs text-fg-faint">{t("pages.drop")}</span>
                <input
                  ref={docxInput}
                  type="file"
                  multiple
                  hidden
                  accept={DOCX_ACCEPT}
                  data-import="docx"
                  onChange={(e) => {
                    addDocuments(e.target.files);
                    e.target.value = "";
                  }}
                />
              </div>
              {documents.length > 0 && (
                <div className="rounded-lg border border-border">
                  <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-xs text-fg-muted">
                    <span>{t("pages.selected", { count: documents.length, size: formatBytes(documentsSize) })}</span>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDocuments([])}>
                      {t("pages.clear")}
                    </Button>
                  </div>
                  <ul className="max-h-32 overflow-y-auto px-3 py-1.5 text-xs text-fg-muted">
                    {documents.slice(0, 50).map((file) => (
                      <li key={file.name} className="truncate">
                        {file.name}
                      </li>
                    ))}
                    {documents.length > 50 && <li>…</li>}
                  </ul>
                </div>
              )}
              {destinationPicker}
            </>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Button disabled={busy} onClick={() => csvInput.current?.click()}>
                  <FileUp className="h-4 w-4" />
                  {t("csv.choose")}
                </Button>
                {csv && (
                  <span className="text-xs text-fg-muted">
                    {t("csv.summary", { name: csv.file.name, rows: csv.table.rows.length, columns: csv.table.headers.length })}
                  </span>
                )}
                <input
                  ref={csvInput}
                  type="file"
                  accept=".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  hidden
                  data-import="csv"
                  onChange={(e) => {
                    void chooseCsv(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
              </div>

              {csv && csv.sheets.length > 1 && (
                <label className="block">
                  <span className={labelClass}>{t("csv.sheet")}</span>
                  <select
                    className={selectClass}
                    value={csv.sheet}
                    disabled={busy}
                    onChange={(e) => void chooseCsv(csv.file, Number(e.target.value))}
                  >
                    {csv.sheets.map((sheetName, i) => (
                      <option key={i} value={i}>
                        {sheetName}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {csv && (
                <>
                  <fieldset className="flex flex-wrap gap-4 text-sm" disabled={busy}>
                    <legend className={labelClass}>{t("csv.mode")}</legend>
                    <label className="flex items-center gap-1.5">
                      <input type="radio" name="csv-mode" checked={csvMode === "new"} onChange={() => setCsvMode("new")} />
                      {t("csv.newDatabase")}
                    </label>
                    <label className="flex items-center gap-1.5">
                      <input type="radio" name="csv-mode" checked={csvMode === "existing"} onChange={() => setCsvMode("existing")} />
                      {t("csv.existing")}
                    </label>
                  </fieldset>

                  {csvMode === "new" ? (
                    <>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <label className="block">
                          <span className={labelClass}>{t("csv.name")}</span>
                          <Input value={name} maxLength={200} disabled={busy} onChange={(e) => setName(e.target.value)} />
                        </label>
                        {destinationPicker}
                      </div>
                      <label className="block">
                        <span className={labelClass}>{t("csv.titleColumn")}</span>
                        <select
                          className={selectClass}
                          value={titleColumn ?? ""}
                          disabled={busy}
                          onChange={(e) => setTitleColumn(e.target.value === "" ? null : Number(e.target.value))}
                        >
                          <option value="">{t("csv.noTitle")}</option>
                          {csv.table.headers.map((h, i) => (
                            <option key={i} value={i}>
                              {h}
                            </option>
                          ))}
                        </select>
                      </label>
                      <ColumnTable
                        headers={csv.table.headers}
                        sample={sample}
                        heading={t("csv.type")}
                        labels={{ column: t("csv.column"), values: t("csv.values") }}
                        render={(i) =>
                          i === titleColumn ? (
                            <span className="text-sm text-fg-muted">{t("csv.rowTitle")}</span>
                          ) : (
                            <select
                              className={selectClass}
                              aria-label={`${t("csv.type")}: ${csv.table.headers[i]}`}
                              value={types[i] ?? ""}
                              disabled={busy}
                              onChange={(e) =>
                                setTypes((prev) => prev.map((v, j) => (j === i ? ((e.target.value || null) as CsvColumnType | null) : v)))
                              }
                            >
                              {CSV_COLUMN_TYPES.map((type) => (
                                <option key={type} value={type}>
                                  {typeLabel(type)}
                                </option>
                              ))}
                              <option value="">{t("csv.leaveOut")}</option>
                            </select>
                          )
                        }
                      />
                    </>
                  ) : (
                    <>
                      <label className="block">
                        <span className={labelClass}>{t("csv.database")}</span>
                        {databases.length === 0 ? (
                          <p className="text-sm text-fg-muted">{t("csv.noDatabases")}</p>
                        ) : (
                          <select className={selectClass} value={databaseId} disabled={busy} onChange={(e) => setDatabaseId(e.target.value)}>
                            <option value="" disabled>
                              {t("csv.chooseDatabase")}
                            </option>
                            {databases.map(({ node, depth }) => (
                              <option key={node.id} value={node.id}>
                                {`${"  ".repeat(depth)}${node.icon ? `${node.icon} ` : ""}${pageLabel(node.title, tc("untitled"))}`}
                              </option>
                            ))}
                          </select>
                        )}
                      </label>
                      {target === "error" && <p className="text-sm text-danger">{t("csv.cantLoad")}</p>}
                      {databaseId && target === null && <p className="text-sm text-fg-muted">{tc("loading")}</p>}
                      {target && target !== "error" && (
                        <>
                          <ColumnTable
                            headers={csv.table.headers}
                            sample={sample}
                            heading={t("csv.target")}
                            labels={{ column: t("csv.column"), values: t("csv.values") }}
                            render={(i) => (
                              <select
                                className={selectClass}
                                aria-label={`${t("csv.target")}: ${csv.table.headers[i]}`}
                                value={mapping[i] ?? ""}
                                disabled={busy}
                                onChange={(e) => {
                                  const value = e.target.value || null;
                                  // One column per property: taking one frees it from the column that had it.
                                  setMapping((prev) => prev.map((m, j) => (j === i ? value : m === value ? null : m)));
                                }}
                              >
                                <option value="">{t("csv.leaveOut")}</option>
                                <option value="title">{t("csv.rowTitle")}</option>
                                {target.properties.map((p) => (
                                  <option key={p.id} value={p.id}>
                                    {`${p.name} (${typeLabel(p.type)})`}
                                  </option>
                                ))}
                              </select>
                            )}
                          />
                          <p className="text-xs text-fg-muted">{t("csv.newOptions")}</p>
                        </>
                      )}
                    </>
                  )}
                </>
              )}
            </>
          )}

          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              {tc("cancel")}
            </Button>
            <Button variant="primary" disabled={!ready} onClick={() => void submit()}>
              {busy ? t("importing") : t("import")}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function ColumnTable({
  headers,
  sample,
  heading,
  labels,
  render,
}: {
  headers: string[];
  sample: (i: number) => string;
  heading: string;
  labels: { column: string; values: string };
  render: (i: number) => React.ReactNode;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-fg-muted">
            <th className="px-3 py-1.5 font-medium">{labels.column}</th>
            <th className="w-48 px-3 py-1.5 font-medium">{heading}</th>
            <th className="px-3 py-1.5 font-medium max-sm:hidden">{labels.values}</th>
          </tr>
        </thead>
        <tbody>
          {headers.map((header, i) => (
            <tr key={i} className="border-b border-border last:border-0">
              <td className="max-w-40 truncate px-3 py-1.5" title={header}>
                {header}
              </td>
              <td className="px-3 py-1">{render(i)}</td>
              <td className="max-w-56 truncate px-3 py-1.5 text-xs text-fg-muted max-sm:hidden">{sample(i)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ResultView({
  result,
  warningText,
  onOpen,
  onAgain,
}: {
  result: ImportResult;
  warningText: (w: ImportWarning) => string;
  onOpen: () => void;
  onAgain: () => void;
}) {
  const t = useTranslations("import");
  const counts = (["pages", "databases", "rows", "templates", "files"] as const)
    .filter((key) => result.created[key] > 0)
    .map((key) => t(`counts.${key}`, { count: result.created[key] }));
  return (
    <div className="max-h-[70vh] space-y-3 overflow-y-auto p-4">
      <p className="text-sm">{counts.length ? t("done.created", { list: counts.join(", ") }) : t("done.nothing")}</p>
      {result.warnings.length > 0 && (
        <div>
          <h3 className="mb-1 text-xs font-medium text-fg-muted">{t("warnings.heading")}</h3>
          <ul className="list-disc space-y-0.5 pl-5 text-sm text-fg-muted">
            {result.warnings.map((w, i) => (
              <li key={i} className="break-words">
                {warningText(w)}
              </li>
            ))}
            {result.moreWarnings > 0 && <li>{t("warnings.more", { count: result.moreWarnings })}</li>}
          </ul>
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onAgain}>
          {t("done.again")}
        </Button>
        {result.pages.length > 0 && (
          <Button variant="primary" onClick={onOpen}>
            {t("done.open")}
          </Button>
        )}
      </div>
    </div>
  );
}
