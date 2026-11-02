"use client";

/**
 * Text files in the agent chat (lib/agent-chat-files.ts): what the box reads from the files the
 * person picks (in the browser, before sending), the chips that show them under the box and on
 * their question, and the files the agent attached to its answer, to download.
 */
import { Download, FileText, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { AGENT_CHAT_FILE_LIMITS, agentChatFileType, agentChatFileUrl, checkChatFiles, type ChatFileProblem } from "@/lib/agent-chat-files";
import type { AgentChatAnswerFile, AgentChatFileIn, AgentChatFileRef } from "@/lib/agent-chat";
import { formatBytes } from "@/lib/files";

/** The files picked, read as text and added to those already there; or why they can't be. */
export async function readChatFiles(
  picked: readonly File[],
  already: AgentChatFileIn[],
): Promise<{ ok: true; files: AgentChatFileIn[] } | { ok: false; problem: ChatFileProblem; name?: string }> {
  if (already.length + picked.length > AGENT_CHAT_FILE_LIMITS.perMessage) return { ok: false, problem: "tooMany" };
  for (const file of picked) {
    if (!agentChatFileType(file.name, file.type)) return { ok: false, problem: "type", name: file.name };
    // Bytes on disk: a file far above the limit isn't read at all.
    if (file.size > AGENT_CHAT_FILE_LIMITS.bytes * 2) return { ok: false, problem: "tooLarge", name: file.name };
  }
  const read = await Promise.all(picked.map(async (file) => ({ name: file.name, text: await file.text() })));
  const checked = checkChatFiles(read, already.map((f) => f.name));
  return checked.ok ? { ok: true, files: [...already, ...checked.files] } : checked;
}

/** What to say about files that can't be attached. */
export function useFileProblem() {
  const t = useTranslations("page.agentChat.files");
  return (problem: ChatFileProblem, name = "") =>
    problem === "tooMany"
      ? t("tooMany", { max: AGENT_CHAT_FILE_LIMITS.perMessage })
      : problem === "tooLarge"
        ? t("tooLarge", { name, size: formatBytes(AGENT_CHAT_FILE_LIMITS.bytes) })
        : t(problem, { name });
}

/** The files of a message (or the box's, removable): their names and sizes. */
export function FileChips({ files, onRemove, className }: { files: AgentChatFileRef[]; onRemove?: (name: string) => void; className?: string }) {
  const t = useTranslations("page.agentChat.files");
  if (!files.length) return null;
  return (
    <ul className={className ?? "flex flex-wrap gap-1.5"}>
      {files.map((f) => (
        <li key={f.name} className="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-md border border-border bg-bg px-2 py-1 text-xs">
          <FileText className="h-3.5 w-3.5 shrink-0 text-fg-muted" aria-hidden />
          <span className="min-w-0 truncate">{f.name}</span>
          <span className="shrink-0 text-fg-faint">{formatBytes(f.size)}</span>
          {onRemove && (
            <button type="button" aria-label={t("remove", { name: f.name })} title={t("remove", { name: f.name })} className="-me-1 rounded p-0.5 text-fg-faint hover:bg-bg-hover hover:text-fg" onClick={() => onRemove(f.name)}>
              <X className="h-3 w-3" />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The files the agent attached to its answer, each a download only the person can open. */
export function AnswerFiles({ files }: { files: AgentChatAnswerFile[] }) {
  const t = useTranslations("page.agentChat.files");
  if (!files.length) return null;
  return (
    <ul className="mt-2 flex flex-wrap gap-1.5">
      {files.map((f) => (
        <li key={f.id}>
          <a
            href={agentChatFileUrl(f.id)}
            download={f.name}
            title={t("download", { name: f.name })}
            className="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-bg-hover"
          >
            <Download className="h-3.5 w-3.5 shrink-0 text-fg-muted" aria-hidden />
            <span className="min-w-0 truncate">{f.name}</span>
            <span className="shrink-0 text-fg-faint">{formatBytes(f.size)}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}
