"use client";

import { FileText, Paperclip, Upload, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { cn } from "@/components/ui";
import { asFiles, formatBytes, isImageFile, type FileValue } from "@/lib/files";

/**
 * Files properties: small thumbnails for images and a name for other files wherever values show,
 * and an editor to add (upload) and remove them.
 *
 * Uploads go wherever the caller says (a row's own page, or a form's database while the answer is
 * being written, see UploadFile); the value then refers to the stored file by its path. Removing a
 * file from the value never deletes it: it stays with the row it was uploaded to (see server/files).
 */

/** Stores one file and returns it as a value entry; throws an UploadError when it can't. */
export type UploadFile = (file: File) => Promise<FileValue>;

export class UploadError extends Error {
  constructor(
    readonly code: "tooLarge" | "quotaExceeded" | "rateLimited" | "failed",
    readonly fileName: string,
    readonly limit?: number,
  ) {
    super(`Upload of ${fileName} failed (${code})`);
    this.name = "UploadError";
  }
}

/**
 * POSTs a file the way the file route takes it (raw body, X-File-Name) to `endpoint`, which answers
 * with the stored file. Extra headers ride along (a public form's ticket).
 */
export async function postFile(endpoint: string, file: File, headers: Record<string, string> = {}): Promise<FileValue> {
  const name = file.name || "file";
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      body: file,
      headers: { ...headers, "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(name) },
    });
  } catch {
    throw new UploadError("failed", name);
  }
  const data = (await res.json().catch(() => null)) as
    | { url?: string; name?: string; contentType?: string; code?: string; limit?: number }
    | null;
  if (!res.ok || !data?.url) {
    const code = data?.code === "tooLarge" || data?.code === "quotaExceeded" || data?.code === "rateLimited" ? data.code : "failed";
    throw new UploadError(code, name, data?.limit);
  }
  return { url: data.url, name: data.name ?? name, type: data.contentType ?? "application/octet-stream" };
}

/** Uploads to a page or row: the file then belongs to it (see api/files). */
export const uploadToPage = (pageId: string): UploadFile => (file) => postFile(`/api/files?pageId=${encodeURIComponent(pageId)}`, file);

/** A translated message for a failed upload. */
export function useUploadErrorMessage() {
  const t = useTranslations("page.upload");
  const tf = useTranslations("database.files");
  return (error: unknown) => {
    if (!(error instanceof UploadError)) return t("failed", { name: "" });
    const limit = error.limit ? formatBytes(error.limit) : "";
    if (error.code === "tooLarge") return t("tooLarge", { name: error.fileName, limit });
    if (error.code === "quotaExceeded") return t("quotaExceeded", { name: error.fileName, limit });
    if (error.code === "rateLimited") return tf("rateLimited");
    return t("failed", { name: error.fileName });
  };
}

/** An image's thumbnail, or a file icon for anything else. */
function Thumb({ file, size = "sm", src }: { file: FileValue; size?: "sm" | "md"; src?: string }) {
  const [failed, setFailed] = useState(false);
  const box = size === "md" ? "h-8 w-8" : "h-5 w-5";
  if (isImageFile(file.type) && !failed) {
    return (
      // Same-origin files, served only to people who may see them: a plain img, no optimizer.
      <img
        src={src ?? file.url}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        className={cn(box, "shrink-0 rounded border border-border bg-bg-subtle object-cover")}
      />
    );
  }
  return (
    <span className={cn(box, "inline-flex shrink-0 items-center justify-center rounded border border-border bg-bg-subtle text-fg-muted")}>
      <FileText className={size === "md" ? "h-4 w-4" : "h-3 w-3"} aria-hidden />
    </span>
  );
}

/**
 * A files value, read-only: in cells and on cards a line of thumbnails (images) and names (other
 * files); wrapped (row panels, published rows) every file with its name. Each opens the file.
 */
export function FilesDisplay({ value, wrap }: { value: unknown; wrap?: boolean }) {
  const files = asFiles(value);
  if (!files.length) return null;
  return (
    <span className={cn("flex min-w-0 items-center gap-1", wrap ? "flex-wrap py-0.5" : "overflow-hidden")}>
      {files.map((file) => {
        const image = isImageFile(file.type);
        return (
          <a
            key={file.url}
            href={file.url}
            target="_blank"
            rel="noopener"
            title={file.name}
            aria-label={file.name}
            onClick={(e) => e.stopPropagation()}
            className={cn(
              "inline-flex min-w-0 shrink-0 items-center gap-1 rounded text-xs text-fg no-underline hover:underline",
              (!image || wrap) && "max-w-48",
            )}
          >
            <Thumb file={file} size={wrap && image ? "md" : "sm"} />
            {(!image || wrap) && <span className="truncate">{file.name}</span>}
          </a>
        );
      })}
    </span>
  );
}

/**
 * Edits a files value: the files it holds (each can be opened or removed) and, when the caller can
 * store files (`upload`), a button and a drop zone that add more. Uploads run one after another and
 * each lands in the value as soon as it is stored.
 *
 * In a form (`answer`) there is no header, and files show from the browser's copy: someone answering
 * can't open what they uploaded, since it belongs to the database until their answer arrives.
 */
export function FilesEditor({
  name,
  value,
  onChange,
  upload,
  answer,
}: {
  name: string;
  value: unknown;
  onChange: (value: unknown) => void;
  upload?: UploadFile;
  answer?: { id: string; disabled?: boolean; invalid?: boolean; describedBy?: string };
}) {
  const t = useTranslations("database.files");
  const errorMessage = useUploadErrorMessage();
  // Local list, so uploads finishing one after another build on each other.
  const [files, setFiles] = useState<FileValue[]>(() => asFiles(value));
  const latest = useRef(files);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  // Previews of files uploaded here, from the browser's copy.
  const local = useRef(new Map<string, string>());
  useEffect(() => {
    const previews = local.current;
    return () => previews.forEach((u) => URL.revokeObjectURL(u));
  }, []);
  const disabled = Boolean(answer?.disabled);

  const commit = (next: FileValue[]) => {
    latest.current = next;
    setFiles(next);
    onChange(next.length ? next : null);
  };

  const add = async (list: FileList | File[]) => {
    if (!upload) return;
    setError(null);
    for (const file of Array.from(list)) {
      setBusy(file.name || "file");
      try {
        const stored = await upload(file);
        if (answer && isImageFile(stored.type) && !local.current.has(stored.url)) {
          local.current.set(stored.url, URL.createObjectURL(file));
        }
        if (!latest.current.some((f) => f.url === stored.url)) commit([...latest.current, stored]);
      } catch (e) {
        setError(errorMessage(e));
      }
    }
    setBusy(null);
  };

  const onDrop = (e: DragEvent) => {
    if (!upload || disabled || !e.dataTransfer.files.length) return;
    e.preventDefault();
    setOver(false);
    void add(e.dataTransfer.files);
  };

  return (
    <div
      onDragOver={(e) => {
        if (!upload || disabled || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={cn("relative", over && "bg-accent/5")}
    >
      {!answer && (
        <div className="flex items-center justify-between gap-2 border-b border-border bg-bg-subtle px-2 py-1.5">
          <span className="truncate text-xs font-medium text-fg-muted">{name}</span>
          {files.length > 0 && <span className="text-xs text-fg-muted tabular-nums">{t("count", { count: files.length })}</span>}
        </div>
      )}
      <div className="max-h-72 overflow-y-auto p-1">
        {!files.length && !busy && <div className="px-2 py-1.5 text-xs text-fg-faint">{upload ? t("emptyUpload") : t("empty")}</div>}
        {files.map((file) => (
          <div key={file.url} className="group flex items-center gap-2 rounded px-1.5 py-1 hover:bg-bg-hover">
            <Thumb file={file} size="md" src={local.current.get(file.url)} />
            {answer ? (
              <span className="min-w-0 flex-1 truncate text-sm text-fg">{file.name}</span>
            ) : (
              <a
                href={file.url}
                target="_blank"
                rel="noopener"
                className="min-w-0 flex-1 truncate text-sm text-fg no-underline hover:underline"
                title={t("open", { name: file.name })}
              >
                {file.name}
              </a>
            )}
            <button
              type="button"
              disabled={disabled}
              aria-label={t("remove", { name: file.name })}
              title={t("remove", { name: file.name })}
              onClick={() => commit(latest.current.filter((f) => f.url !== file.url))}
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-muted opacity-0 group-hover:opacity-100 hover:text-danger focus:opacity-100 pointer-coarse:opacity-100"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        {busy && (
          <div className="flex items-center gap-2 px-1.5 py-1 text-sm text-fg-muted" role="status">
            <span className="inline-flex h-8 w-8 shrink-0 animate-pulse items-center justify-center rounded border border-border bg-bg-subtle">
              <Paperclip className="h-4 w-4" aria-hidden />
            </span>
            <span className="truncate">{t("uploading", { name: busy })}</span>
          </div>
        )}
      </div>
      {error && <div className="border-t border-border px-2.5 py-1.5 text-xs text-danger">{error}</div>}
      {upload && (
        <div className="border-t border-border p-1">
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            tabIndex={-1}
            onChange={(e) => {
              const picked = e.target.files ? Array.from(e.target.files) : [];
              e.target.value = "";
              if (picked.length) void add(picked);
            }}
          />
          <button
            id={answer?.id}
            type="button"
            disabled={Boolean(busy) || disabled}
            // The button can't carry aria-invalid; the error it describes says what is wrong.
            aria-describedby={answer?.describedBy}
            onClick={() => picker.current?.click()}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm text-fg-muted hover:bg-bg-hover hover:text-fg disabled:opacity-60"
          >
            <Upload className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{t("upload")}</span>
          </button>
        </div>
      )}
    </div>
  );
}
