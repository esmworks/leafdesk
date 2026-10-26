"use client";

import { FileUp, FolderUp, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { importTargetAction, type ImportTarget } from "@/app/actions/import";
import { importGoogleDocsAction } from "@/app/actions/google-docs-import";
import { createGithubPullsSyncAction } from "@/app/actions/github-pulls-sync";
import { createIcalSyncAction } from "@/app/actions/ical-sync";
import { createPostgresSyncAction } from "@/app/actions/postgres-sync";
import { createJiraSyncAction } from "@/app/actions/jira-sync";
import { saveWebPageAction } from "@/app/actions/web-clip";
import { usePropertyTypeLabel } from "@/components/database/property-icons";
import { Button, cn, Dialog, IconButton, Input, pageLabel } from "@/components/ui";
import { formatBytes } from "@/lib/files";
import type { Board } from "@/lib/import/board";
import { BOARD_COLUMN_TYPES, type BoardColumnType } from "@/lib/import/board-columns";
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
import { parseTrelloExport, readTrelloBoard, type TrelloBoard } from "@/lib/import/trello";
import { isWorkbook, readWorkbook } from "@/lib/import/xlsx";
import { iconPrefix } from "@/lib/icon-value";
import type { TreeNode } from "@/server/pages";
import { GoogleDocsTab, type GoogleDocsSetup } from "./google-docs-import";
import { GithubPullsTab, type GithubPullsSetup } from "./github-pulls-import";
import { IcalTab, type IcalSetup } from "./ical-import";
import { PostgresTab, type PostgresSetup } from "./postgres-import";
import { JiraTab, type JiraSetup } from "./jira-import";
import { flattenTree, WebClipTab, type WebClipSetupChoice } from "./web-clip";

const selectClass = "h-8 w-full rounded-md border border-border bg-bg px-2 text-sm outline-none focus:border-accent disabled:opacity-60";
const labelClass = "mb-1 block text-xs font-medium text-fg-muted";

const canEdit = (node: TreeNode) => node.level === "edit" || node.level === "full";

type Picked = { file: File; path: string };

/** What the Word tab's file picker offers, and what it takes from a drop. */
const DOCX_ACCEPT = ".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const isDocx = (file: File) => /\.docx$/i.test(file.name);
/** What the PDF tab's file picker offers, and what it takes from a drop. */
const PDF_ACCEPT = ".pdf,application/pdf";
const isPdf = (file: File) => /\.pdf$/i.test(file.name);
/** What the Evernote tab's file picker offers (exports, and ZIPs of them), and what it takes from a drop. */
const ENEX_ACCEPT = ".enex,.zip,application/zip";
const CONFLUENCE_ACCEPT = ".zip,application/zip";
const isEnexUpload = (file: File) => /\.(enex|zip)$/i.test(file.name);
/** What the OneNote tab's file picker offers (single-file web pages), and what it takes from a drop. */
const MHTML_ACCEPT = ".mht,.mhtml,multipart/related,message/rfc822,application/x-mimearchive";
const isMhtml = (file: File) => /\.(mht|mhtml)$/i.test(file.name);
/** What the Trello tab's file picker offers. */
const TRELLO_ACCEPT = ".json,application/json";
/** What the Asana and Monday.com tabs' file pickers offer. */
const BOARD_ACCEPT = {
  asana: ".csv,text/csv,.json,application/json",
  monday: ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.csv,text/csv",
} as const;
type BoardSource = keyof typeof BOARD_ACCEPT;
/** The chosen CSV file or workbook; a workbook's sheets by name, and the one shown. */
type CsvState = { file: File; table: CsvTable; guesses: CsvColumnType[]; sheets: string[]; sheet: number };

/**
 * Imports Markdown files, folders, TextBundles and ZIPs as pages, Word documents, PDFs and single-file
 * web pages (OneNote's export) as a page each, a CSV file
 * or Excel workbook (one of its sheets) as a new database or as rows of an existing one (with a
 * column → property mapping), or a Trello board's JSON export, an Asana project's export or a
 * Monday.com board's as a new database; a web page by its address (a server action: see
 * server/web-clip.ts), as a page or a database's row. Sends files to /api/import and shows what was
 * created and what was left out.
 */
export function ImportDialog({
  workspaceId,
  open,
  onClose,
  tree,
  topLevel,
  activeId,
  teamspaceId,
  file,
  initialTab,
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
  /**
   * A CSV file or workbook a page shows, to start from: it opens chosen, to import as a new
   * database under that page (`pageId`), offered even when the tree doesn't list it (a row's page).
   */
  file?: { file: File; pageId: string } | null;
  /** Opened from "Save from web": starts on the web page tab. */
  initialTab?: "web";
}) {
  const router = useRouter();
  const t = useTranslations("import");
  const tc = useTranslations("common");
  const typeLabel = usePropertyTypeLabel();
  const locale = useLocale();

  const flat = useMemo(() => flattenTree(tree), [tree]);
  const destinations = flat.filter(({ node }) => node.kind === "page" && canEdit(node));
  // The page showing `file`, when the tree doesn't list it: offered too, by what it is.
  const filePage = file && !destinations.some(({ node }) => node.id === file.pageId) ? file.pageId : null;
  const databases = flat.filter(({ node }) => node.kind === "database" && canEdit(node));
  const activeNode = tree.find((n) => n.id === activeId);

  const [tab, setTab] = useState<"pages" | "docx" | "googleDocs" | "pdf" | "evernote" | "onenote" | "confluence" | "csv" | "trello" | BoardSource | "jira" | "github" | "ical" | "postgres" | "web">("pages");
  const [destination, setDestination] = useState("");
  const [picked, setPicked] = useState<Picked[]>([]);
  // A folder that came with an Obsidian vault's settings folder (which isn't sent).
  const [vault, setVault] = useState(false);
  const [documents, setDocuments] = useState<File[]>([]);
  const [pdfs, setPdfs] = useState<File[]>([]);
  const [notebooks, setNotebooks] = useState<File[]>([]);
  const [archives, setArchives] = useState<File[]>([]);
  // A Confluence space exported as HTML: one ZIP.
  const [confluence, setConfluence] = useState<File | null>(null);
  // Each PDF is uploaded to its page too, for its pictures, tables and layout.
  const [attachPdf, setAttachPdf] = useState(true);
  const [csv, setCsv] = useState<CsvState | null>(null);
  const [trello, setTrello] = useState<{ file: File; board: TrelloBoard } | null>(null);
  const [boardName, setBoardName] = useState("");
  // An Asana or Monday.com export, and what each of its columns becomes (null: left out).
  const [board, setBoard] = useState<ChosenBoard | null>(null);
  const [boardTypes, setBoardTypes] = useState<(BoardColumnType | null)[]>([]);
  // The Jira tab's sync, once it is filled in.
  const [jira, setJira] = useState<JiraSetup | null>(null);
  // The GitHub tab's sync, once a repository is named.
  const [github, setGithub] = useState<GithubPullsSetup | null>(null);
  const [ical, setIcal] = useState<IcalSetup | null>(null);
  const [postgresSetup, setPostgresSetup] = useState<PostgresSetup | null>(null);
  // The Google Docs tab's connection and documents, once some are chosen.
  const [googleDocs, setGoogleDocs] = useState<GoogleDocsSetup | null>(null);
  const [web, setWeb] = useState<WebClipSetupChoice | null>(null);
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
  const pdfInput = useRef<HTMLInputElement>(null);
  const enexInput = useRef<HTMLInputElement>(null);
  const mhtmlInput = useRef<HTMLInputElement>(null);
  const confluenceInput = useRef<HTMLInputElement>(null);
  const trelloInput = useRef<HTMLInputElement>(null);
  const boardInput = useRef<HTMLInputElement>(null);

  // Fresh each time it opens, aimed at the page (or database) open now.
  useEffect(() => {
    if (!open) return;
    const activeEditable = activeNode && canEdit(activeNode);
    setTab(initialTab ?? (activeEditable && activeNode.kind === "database" ? "csv" : "pages"));
    setDestination(
      activeEditable && activeNode.kind === "page" ? activeNode.id : topLevel ? "" : (destinations[0]?.node.id ?? ""),
    );
    setPicked([]);
    setVault(false);
    setDocuments([]);
    setPdfs([]);
    setNotebooks([]);
    setConfluence(null);
    setArchives([]);
    setAttachPdf(true);
    setCsv(null);
    setTrello(null);
    setBoard(null);
    setJira(null);
    setGithub(null);
    setIcal(null);
    setPostgresSetup(null);
    setGoogleDocs(null);
    setWeb(null);
    setCsvMode(activeEditable && activeNode.kind === "database" ? "existing" : "new");
    setDatabaseId(activeEditable && activeNode.kind === "database" ? activeNode.id : "");
    setError(null);
    setResult(null);
    setBusy(false);
    if (file) {
      setTab("csv");
      setCsvMode("new");
      setDatabaseId("");
      setDestination(file.pageId);
      void chooseCsv(file.file);
    }
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

  const destinationValid = destination ? destination === filePage || destinations.some((d) => d.node.id === destination) : topLevel;
  const totalSize = picked.reduce((sum, p) => sum + p.file.size, 0);
  const documentsSize = documents.reduce((sum, f) => sum + f.size, 0);
  const pdfsSize = pdfs.reduce((sum, f) => sum + f.size, 0);
  const notebooksSize = notebooks.reduce((sum, f) => sum + f.size, 0);
  const archivesSize = archives.reduce((sum, f) => sum + f.size, 0);

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

  /** Adds PDFs to the list (by name: choosing one again replaces it); other files are passed over. */
  function addPdfs(list: FileList | File[] | null) {
    if (!list) return;
    const next = [...list].filter(isPdf);
    setPdfs((prev) => [...prev.filter((f) => !next.some((n) => n.name === f.name)), ...next]);
    setError(null);
  }

  /** Adds Evernote exports (and ZIPs of them) to the list (by name: choosing one again replaces it); other files are passed over. */
  function addNotebooks(list: FileList | File[] | null) {
    if (!list) return;
    const next = [...list].filter(isEnexUpload);
    setNotebooks((prev) => [...prev.filter((f) => !next.some((n) => n.name === f.name)), ...next]);
    setError(null);
  }

  /** Adds single-file web pages to the list (by name: choosing one again replaces it); other files are passed over. */
  function addArchives(list: FileList | File[] | null) {
    if (!list) return;
    const next = [...list].filter(isMhtml);
    setArchives((prev) => [...prev.filter((f) => !next.some((n) => n.name === f.name)), ...next]);
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

  /** Reads a Trello export, for its summary and to tell early when the file isn't one. */
  async function chooseTrello(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      const board = readTrelloBoard(parseTrelloExport(decodeText(new Uint8Array(await file.arrayBuffer()))));
      setTrello({ file, board });
      setBoardName(board.title || cleanTitle(file.name));
    } catch (e) {
      setTrello(null);
      setError(errorText(e instanceof ImportError ? { code: e.code, params: e.params } : { code: "badTrello" }));
    }
  }

  /** Reads an Asana or Monday.com export, for its summary and column table, and to tell early when the file isn't one. */
  async function chooseBoard(source: BoardSource, file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // The readers load only now: most people never open these tabs.
      const [{ cellText }, read] = await Promise.all([
        import("@/lib/import/board"),
        source === "asana"
          ? import("@/lib/import/asana").then((m) => m.readAsanaExport(file.name, bytes))
          : import("@/lib/import/monday").then((m) => m.readMondayExport(file.name, bytes)),
      ]);
      const samples = read.columns.map((_, column) =>
        read.items
          .map((item) => cellText(item.cells[column] ?? "").trim())
          .filter(Boolean)
          .slice(0, 3)
          .join(", ")
          .slice(0, 60),
      );
      setBoard({ file, board: read, samples });
      setBoardName(read.title || cleanTitle(file.name));
      setBoardTypes(read.columns.map((c) => c.type));
    } catch (e) {
      setBoard(null);
      const code = source === "asana" ? "badAsana" : "badMonday";
      setError(errorText(e instanceof ImportError ? { code: e.code, params: e.params } : { code }));
    }
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
      "badPdf",
      "pdfNoText",
      "pdfTooComplex",
      "badEnex",
      "badMhtml",
      "badTrello",
      "badAsana",
      "badMonday",
      "badMapping",
      "noAccess",
      "notADatabase",
      "busy",
    ];
    return known.includes(code) ? t(`errors.${code}` as "errors.badRequest", params) : t("errors.badRequest");
  }

  async function submit() {
    setError(null);
    if (tab === "jira") return submitJira();
    if (tab === "github") return submitGithub();
    if (tab === "ical") return submitIcal();
    if (tab === "postgres") return submitPostgres();
    if (tab === "googleDocs") return submitGoogleDocs();
    if (tab === "web") return submitWeb();
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
    } else if (tab === "pdf") {
      if (pdfsSize > IMPORT_LIMITS.uploadBytes) return setError(t("errors.tooLarge", { limit: formatBytes(IMPORT_LIMITS.uploadBytes) }));
      form.append("mode", "pdf");
      form.append("parentId", destination);
      if (attachPdf) form.append("attach", "1");
      for (const file of pdfs) form.append("file", file, file.name);
    } else if (tab === "evernote") {
      if (notebooksSize > IMPORT_LIMITS.uploadBytes) return setError(t("errors.tooLarge", { limit: formatBytes(IMPORT_LIMITS.uploadBytes) }));
      form.append("mode", "enex");
      form.append("parentId", destination);
      for (const file of notebooks) form.append("file", file, file.name);
    } else if (tab === "onenote") {
      if (archivesSize > IMPORT_LIMITS.uploadBytes) return setError(t("errors.tooLarge", { limit: formatBytes(IMPORT_LIMITS.uploadBytes) }));
      form.append("mode", "mhtml");
      form.append("parentId", destination);
      for (const file of archives) form.append("file", file, file.name);
    } else if (tab === "confluence") {
      if (!confluence) return;
      if (confluence.size > IMPORT_LIMITS.uploadBytes) return setError(t("errors.tooLarge", { limit: formatBytes(IMPORT_LIMITS.uploadBytes) }));
      form.append("mode", "confluence");
      form.append("parentId", destination);
      form.append("file", confluence, confluence.name);
    } else if (tab === "trello") {
      if (!trello) return;
      form.append("mode", "trello");
      form.append("parentId", destination);
      form.append("title", boardName);
      form.append("file", trello.file, trello.file.name);
    } else if (tab === "asana" || tab === "monday") {
      if (board?.board.source !== tab) return;
      form.append("mode", tab);
      form.append("parentId", destination);
      form.append("title", boardName);
      form.append("types", JSON.stringify(boardTypes));
      form.append("file", board.file, board.file.name);
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

  /** Sets a Jira sync up: a server action, as nothing is uploaded. */
  async function submitJira() {
    if (!jira) return;
    setBusy(true);
    try {
      const response = await createJiraSyncAction({
        ...jira,
        workspaceId,
        parentId: destination || null,
        teamspaceId: teamspaceId === undefined ? undefined : (teamspaceId ?? "private"),
      });
      if (!response.ok) setError(response.error);
      else setResult(response.data);
    } catch {
      setError(tc("genericError"));
    } finally {
      setBusy(false);
    }
  }

  /** Sets a GitHub pull request sync up: a server action, as nothing is uploaded. */
  async function submitGithub() {
    if (!github) return;
    setBusy(true);
    try {
      const response = await createGithubPullsSyncAction({
        ...github,
        workspaceId,
        parentId: destination || null,
        teamspaceId: teamspaceId === undefined ? undefined : (teamspaceId ?? "private"),
      });
      if (!response.ok) setError(response.error);
      else setResult(response.data);
    } catch {
      setError(tc("genericError"));
    } finally {
      setBusy(false);
    }
  }

  /** Sets a calendar sync up: a server action, as nothing is uploaded. */
  async function submitIcal() {
    if (!ical) return;
    setBusy(true);
    try {
      const response = await createIcalSyncAction({
        ...ical,
        workspaceId,
        parentId: destination || null,
        teamspaceId: teamspaceId === undefined ? undefined : (teamspaceId ?? "private"),
      });
      if (!response.ok) setError(response.error);
      else setResult(response.data);
    } catch {
      setError(tc("genericError"));
    } finally {
      setBusy(false);
    }
  }

  /** Sets a PostgreSQL table sync up: a server action, as nothing is uploaded. */
  async function submitPostgres() {
    if (!postgresSetup) return;
    setBusy(true);
    try {
      const response = await createPostgresSyncAction({
        ...postgresSetup,
        workspaceId,
        parentId: destination || null,
        teamspaceId: teamspaceId === undefined ? undefined : (teamspaceId ?? "private"),
      });
      if (!response.ok) setError(response.error);
      else setResult(response.data);
    } catch {
      setError(tc("genericError"));
    } finally {
      setBusy(false);
    }
  }

  /** Imports Google documents through a connection: a server action, as nothing is uploaded. */
  async function submitGoogleDocs() {
    if (!googleDocs) return;
    setBusy(true);
    try {
      const response = await importGoogleDocsAction({
        ...googleDocs,
        workspaceId,
        parentId: destination || null,
        teamspaceId: teamspaceId === undefined ? undefined : (teamspaceId ?? "private"),
      });
      if (!response.ok) setError(response.error);
      else setResult(response.data);
    } catch {
      setError(tc("genericError"));
    } finally {
      setBusy(false);
    }
  }

  /** Saves a web page: a server action, as nothing is uploaded. */
  async function submitWeb() {
    if (!web) return;
    setBusy(true);
    try {
      const response = await saveWebPageAction({ workspaceId, url: web.url, targetId: web.targetId });
      if (!response.ok) setError(response.error);
      else setResult(response.data);
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
      case "leftOutColumn":
        return t("warnings.leftOutColumn", { column: w.column });
      case "missingFile":
        return t("warnings.missingFile", { path: w.path, page: w.page });
      case "unresolvedLink":
        return t("warnings.unresolvedLink", { target: w.target, page: w.page });
      case "encryptedText":
        return t("warnings.encryptedText", { page: w.page });
      case "tooManyImages":
        return t("warnings.tooManyImages", { count: w.count, limit: w.limit });
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
        : tab === "googleDocs"
          ? googleDocs !== null && destinationValid
        : tab === "web"
          ? web !== null
        : tab === "pdf"
          ? pdfs.length > 0 && destinationValid
        : tab === "evernote"
          ? notebooks.length > 0 && destinationValid
        : tab === "onenote"
          ? archives.length > 0 && destinationValid
        : tab === "confluence"
          ? confluence !== null && destinationValid
        : tab === "trello"
          ? trello !== null && destinationValid
          : tab === "asana" || tab === "monday"
            ? board?.board.source === tab && destinationValid
            : tab === "jira"
              ? jira !== null && destinationValid
              : tab === "github"
                ? github !== null && destinationValid
              : tab === "ical"
                ? ical !== null && destinationValid
              : tab === "postgres"
                ? postgresSetup !== null && destinationValid
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
      {destinations.length === 0 && !topLevel && !filePage ? (
        <p className="text-sm text-fg-muted">{t("noDestination")}</p>
      ) : (
        <select className={selectClass} value={destination} disabled={busy} onChange={(e) => setDestination(e.target.value)}>
          {topLevel && <option value="">{t("topLevel")}</option>}
          {filePage && <option value={filePage}>{t("filePage")}</option>}
          {destinations.map(({ node, depth }) => (
            <option key={node.id} value={node.id}>
              {`${"  ".repeat(depth)}${iconPrefix(node.icon)}${pageLabel(node.title, tc("untitled"))}`}
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
          <h2 className="text-sm font-medium">{result ? t("done.title") : tab === "web" ? t("web.title") : t("title")}</h2>
          {!result && <p className="mt-0.5 text-xs text-fg-muted">{tab === "web" ? t("web.description") : t("description")}</p>}
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
            setPdfs([]);
            setNotebooks([]);
            setConfluence(null);
            setArchives([]);
            setCsv(null);
            setTrello(null);
            setBoard(null);
          }}
        />
      ) : (
        <div className="max-h-[70vh] space-y-4 overflow-y-auto p-4" aria-busy={busy}>
          <div role="tablist" aria-label={t("title")} className="inline-flex flex-wrap gap-0.5 rounded-lg bg-bg-hover p-0.5">
            {(["pages", "docx", "googleDocs", "pdf", "evernote", "onenote", "confluence", "csv", "trello", "asana", "monday", "jira", "github", "ical", "postgres", "web"] as const).map((key) => (
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
              <p className="text-sm text-fg-muted">{t("pages.textbundle")}</p>
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
          ) : tab === "pdf" ? (
            <>
              <p className="text-sm text-fg-muted">{t("pdf.help")}</p>
              <p className="text-sm text-fg-muted">{t("pdf.scans")}</p>
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  addPdfs(e.dataTransfer.files);
                }}
                className={cn(
                  "flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border px-3 py-3",
                  dragOver && "border-accent bg-accent/5",
                )}
              >
                <Button disabled={busy} onClick={() => pdfInput.current?.click()}>
                  <FileUp className="h-4 w-4" />
                  {t("pdf.choose")}
                </Button>
                <span className="text-xs text-fg-faint">{t("pages.drop")}</span>
                <input
                  ref={pdfInput}
                  type="file"
                  multiple
                  hidden
                  accept={PDF_ACCEPT}
                  data-import="pdf"
                  onChange={(e) => {
                    addPdfs(e.target.files);
                    e.target.value = "";
                  }}
                />
              </div>
              {pdfs.length > 0 && (
                <div className="rounded-lg border border-border">
                  <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-xs text-fg-muted">
                    <span>{t("pages.selected", { count: pdfs.length, size: formatBytes(pdfsSize) })}</span>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPdfs([])}>
                      {t("pages.clear")}
                    </Button>
                  </div>
                  <ul className="max-h-32 overflow-y-auto px-3 py-1.5 text-xs text-fg-muted">
                    {pdfs.slice(0, 50).map((file) => (
                      <li key={file.name} className="truncate">
                        {file.name}
                      </li>
                    ))}
                    {pdfs.length > 50 && <li>…</li>}
                  </ul>
                </div>
              )}
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={attachPdf}
                  disabled={busy}
                  onChange={(e) => setAttachPdf(e.target.checked)}
                />
                <span>{t("pdf.attach")}</span>
              </label>
              {destinationPicker}
            </>
          ) : tab === "evernote" ? (
            <>
              <p className="text-sm text-fg-muted">{t("evernote.help")}</p>
              <p className="text-sm text-fg-muted">{t("evernote.export")}</p>
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  addNotebooks(e.dataTransfer.files);
                }}
                className={cn(
                  "flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border px-3 py-3",
                  dragOver && "border-accent bg-accent/5",
                )}
              >
                <Button disabled={busy} onClick={() => enexInput.current?.click()}>
                  <FileUp className="h-4 w-4" />
                  {t("evernote.choose")}
                </Button>
                <span className="text-xs text-fg-faint">{t("pages.drop")}</span>
                <input
                  ref={enexInput}
                  type="file"
                  multiple
                  hidden
                  accept={ENEX_ACCEPT}
                  data-import="enex"
                  onChange={(e) => {
                    addNotebooks(e.target.files);
                    e.target.value = "";
                  }}
                />
              </div>
              {notebooks.length > 0 && (
                <div className="rounded-lg border border-border">
                  <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-xs text-fg-muted">
                    <span>{t("pages.selected", { count: notebooks.length, size: formatBytes(notebooksSize) })}</span>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setNotebooks([])}>
                      {t("pages.clear")}
                    </Button>
                  </div>
                  <ul className="max-h-32 overflow-y-auto px-3 py-1.5 text-xs text-fg-muted">
                    {notebooks.slice(0, 50).map((file) => (
                      <li key={file.name} className="truncate">
                        {file.name}
                      </li>
                    ))}
                    {notebooks.length > 50 && <li>…</li>}
                  </ul>
                </div>
              )}
              {destinationPicker}
            </>
          ) : tab === "confluence" ? (
            <>
              <p className="text-sm text-fg-muted">{t("confluence.help")}</p>
              <p className="text-sm text-fg-muted">{t("confluence.export")}</p>
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  const file = [...e.dataTransfer.files].find((f) => /\.zip$/i.test(f.name));
                  if (file) setConfluence(file);
                  setError(null);
                }}
                className={cn(
                  "flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border px-3 py-3",
                  dragOver && "border-accent bg-accent/5",
                )}
              >
                <Button disabled={busy} onClick={() => confluenceInput.current?.click()}>
                  <FileUp className="h-4 w-4" />
                  {t("confluence.choose")}
                </Button>
                <span className="text-xs text-fg-faint">{confluence ? `${confluence.name}, ${formatBytes(confluence.size)}` : t("pages.drop")}</span>
                <input
                  ref={confluenceInput}
                  type="file"
                  hidden
                  accept={CONFLUENCE_ACCEPT}
                  data-import="confluence"
                  onChange={(e) => {
                    setConfluence(e.target.files?.[0] ?? null);
                    setError(null);
                    e.target.value = "";
                  }}
                />
              </div>
              {destinationPicker}
            </>
          ) : tab === "onenote" ? (
            <>
              <p className="text-sm text-fg-muted">{t("onenote.help")}</p>
              <p className="text-sm text-fg-muted">{t("onenote.export")}</p>
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  addArchives(e.dataTransfer.files);
                }}
                className={cn(
                  "flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border px-3 py-3",
                  dragOver && "border-accent bg-accent/5",
                )}
              >
                <Button disabled={busy} onClick={() => mhtmlInput.current?.click()}>
                  <FileUp className="h-4 w-4" />
                  {t("onenote.choose")}
                </Button>
                <span className="text-xs text-fg-faint">{t("pages.drop")}</span>
                <input
                  ref={mhtmlInput}
                  type="file"
                  multiple
                  hidden
                  accept={MHTML_ACCEPT}
                  data-import="mhtml"
                  onChange={(e) => {
                    addArchives(e.target.files);
                    e.target.value = "";
                  }}
                />
              </div>
              {archives.length > 0 && (
                <div className="rounded-lg border border-border">
                  <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-xs text-fg-muted">
                    <span>{t("pages.selected", { count: archives.length, size: formatBytes(archivesSize) })}</span>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setArchives([])}>
                      {t("pages.clear")}
                    </Button>
                  </div>
                  <ul className="max-h-32 overflow-y-auto px-3 py-1.5 text-xs text-fg-muted">
                    {archives.slice(0, 50).map((file) => (
                      <li key={file.name} className="truncate">
                        {file.name}
                      </li>
                    ))}
                    {archives.length > 50 && <li>…</li>}
                  </ul>
                </div>
              )}
              {destinationPicker}
            </>
          ) : tab === "trello" ? (
            <>
              <p className="text-sm text-fg-muted">{t("trello.help")}</p>
              <p className="text-sm text-fg-muted">{t("trello.attachments")}</p>
              <div className="flex flex-wrap items-center gap-2">
                <Button disabled={busy} onClick={() => trelloInput.current?.click()}>
                  <FileUp className="h-4 w-4" />
                  {t("trello.choose")}
                </Button>
                {trello && (
                  <span className="text-xs text-fg-muted">
                    {t("trello.summary", { name: trello.file.name, lists: trello.board.lists.length, cards: trello.board.cards.length })}
                  </span>
                )}
                <input
                  ref={trelloInput}
                  type="file"
                  accept={TRELLO_ACCEPT}
                  hidden
                  data-import="trello"
                  onChange={(e) => {
                    void chooseTrello(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
              </div>
              {trello && trello.board.archived.lists + trello.board.archived.cards > 0 && (
                <p className="text-xs text-fg-muted">
                  {t("trello.archived", { lists: trello.board.archived.lists, cards: trello.board.archived.cards })}
                </p>
              )}
              {trello && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className={labelClass}>{t("csv.name")}</span>
                    <Input value={boardName} maxLength={200} disabled={busy} onChange={(e) => setBoardName(e.target.value)} />
                  </label>
                  {destinationPicker}
                </div>
              )}
            </>
          ) : tab === "googleDocs" ? (
            <GoogleDocsTab workspaceId={workspaceId} busy={busy} destinationPicker={destinationPicker} onSetup={setGoogleDocs} />
          ) : tab === "web" ? (
            <WebClipTab workspaceId={workspaceId} tree={tree} busy={busy} onSetup={setWeb} />
          ) : tab === "jira" ? (
            <JiraTab busy={busy} destinationPicker={destinationPicker} onSetup={setJira} />
          ) : tab === "github" ? (
            <GithubPullsTab busy={busy} destinationPicker={destinationPicker} onSetup={setGithub} />
          ) : tab === "ical" ? (
            <IcalTab busy={busy} destinationPicker={destinationPicker} onSetup={setIcal} />
          ) : tab === "postgres" ? (
            <PostgresTab busy={busy} destinationPicker={destinationPicker} onSetup={setPostgresSetup} />
          ) : tab === "asana" || tab === "monday" ? (
            <BoardTab
              source={tab}
              board={board?.board.source === tab ? board : null}
              types={boardTypes}
              onTypes={setBoardTypes}
              name={boardName}
              onName={setBoardName}
              busy={busy}
              locale={locale}
              typeLabel={typeLabel}
              destinationPicker={destinationPicker}
              onChoose={() => boardInput.current?.click()}
              input={
                <input
                  ref={boardInput}
                  key={tab}
                  type="file"
                  accept={BOARD_ACCEPT[tab]}
                  hidden
                  data-import={tab}
                  onChange={(e) => {
                    void chooseBoard(tab, e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
              }
            />
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
                                {`${"  ".repeat(depth)}${iconPrefix(node.icon)}${pageLabel(node.title, tc("untitled"))}`}
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
              {tab === "jira" || tab === "github" || tab === "ical" || tab === "postgres"
                ? busy
                  ? t("jira.submitting")
                  : t("jira.submit")
                : tab === "web"
                  ? busy
                    ? t("web.saving")
                    : t("web.save")
                  : busy
                    ? t("importing")
                    : t("import")}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** An Asana or Monday.com export the person chose, read, with a few values of each column to show. */
type ChosenBoard = { file: File; board: Board; samples: string[] };

/**
 * The Asana and Monday.com tabs: the file picker, what the export holds, the database's name and
 * place, and a table of the export's own columns with what each becomes (the export doesn't say
 * what kind a column is, so it was guessed).
 */
function BoardTab({
  source,
  board,
  types,
  onTypes,
  name,
  onName,
  busy,
  locale,
  typeLabel,
  destinationPicker,
  onChoose,
  input,
}: {
  source: BoardSource;
  board: ChosenBoard | null;
  types: (BoardColumnType | null)[];
  onTypes: (types: (BoardColumnType | null)[]) => void;
  name: string;
  onName: (name: string) => void;
  busy: boolean;
  locale: string;
  typeLabel: (type: BoardColumnType) => string;
  destinationPicker: React.ReactNode;
  onChoose: () => void;
  input: React.ReactNode;
}) {
  const t = useTranslations("import");
  const b = board?.board;
  // Columns every export of the app has keep their kind; the others can be changed.
  const custom = b ? b.columns.flatMap((c, i) => (c.role ? [] : [i])) : [];
  const subitems = b ? b.items.filter((i) => i.parent !== null).length : 0;
  const comments = b ? b.items.reduce((n, i) => n + i.comments.length, 0) : 0;
  const leftOut = b ? [...b.leftOut, ...b.otherSheets] : [];
  return (
    <>
      <p className="text-sm text-fg-muted">{t(`${source}.help`)}</p>
      <p className="text-sm text-fg-muted">{t("board.links")}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={busy} onClick={onChoose}>
          <FileUp className="h-4 w-4" />
          {t(`${source}.choose`)}
        </Button>
        {b && board && (
          <span className="text-xs text-fg-muted">
            {t(`${source}.summary`, { name: board.file.name, groups: b.groups.length, items: b.items.length - subitems, subitems })}
          </span>
        )}
        {input}
      </div>
      {b && comments > 0 && <p className="text-xs text-fg-muted">{t("board.comments", { count: comments })}</p>}
      {leftOut.length > 0 && (
        <p className="text-xs text-fg-muted">{t("board.leftOut", { list: new Intl.ListFormat(locale).format(leftOut) })}</p>
      )}
      {b && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className={labelClass}>{t("csv.name")}</span>
              <Input value={name} maxLength={200} disabled={busy} onChange={(e) => onName(e.target.value)} />
            </label>
            {destinationPicker}
          </div>
          {custom.length > 0 && (
            <>
              <p className="text-xs text-fg-muted">{t("board.types")}</p>
              <ColumnTable
                headers={custom.map((i) => b.columns[i].name)}
                sample={(row) => board?.samples[custom[row]] ?? ""}
                heading={t("csv.type")}
                labels={{ column: t("csv.column"), values: t("csv.values") }}
                render={(row) => {
                  const i = custom[row];
                  return (
                    <select
                      className={selectClass}
                      aria-label={`${t("csv.type")}: ${b.columns[i].name}`}
                      value={types[i] ?? ""}
                      disabled={busy}
                      onChange={(e) => onTypes(types.map((v, j) => (j === i ? ((e.target.value || null) as BoardColumnType | null) : v)))}
                    >
                      {BOARD_COLUMN_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {typeLabel(type)}
                        </option>
                      ))}
                      <option value="">{t("csv.leaveOut")}</option>
                    </select>
                  );
                }}
              />
            </>
          )}
        </>
      )}
    </>
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
          <tr className="border-b border-border text-start text-xs text-fg-muted">
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
          <ul className="list-disc space-y-0.5 ps-5 text-sm text-fg-muted">
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
