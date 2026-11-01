/**
 * Files an agent attaches to its answer in a person's chat (lib/agent-chat-files.ts): its
 * `attach_file` tool, on chat runs only, writes a text file (CSV, Markdown, text, JSON) that is
 * stored as an upload of the workspace on no page (files.ts storeFile, counted against its
 * storage) and tied to the person and the conversation (`agent_chat_file`). Only that person opens
 * it (`chatFileOfPerson`, served by /api/agents/chat/files/[id]); the answer shows it, and the
 * Telegram bot sends it after an answer it follows. It counts as one of the run's changes and the
 * agent's daily ones (run.ts `change`), but changes nothing anyone else sees: no one approves it.
 */
import { Readable } from "node:stream";
import { and, count, eq } from "drizzle-orm";
import { db } from "@/db";
import { agentChatFile, file } from "@/db/schema";
import { ANSWER_FILE_LIMITS, answerFile } from "@/lib/agent-chat-files";
import { formatBytes } from "@/lib/files";
import type { AgentToolRecord } from "@/lib/agents";
import type { AiTool, AiToolCall } from "@/server/ai";
import { FileError, storeFile, type FileRow } from "@/server/files";

export const ATTACH_FILE = "attach_file";

export const ATTACH_FILE_TOOL: AiTool = {
  name: ATTACH_FILE,
  description: `Attaches a text file you write to your answer, for the person you are chatting with to download (no one else can): a CSV table, a Markdown or plain text document, or JSON. At most ${formatBytes(ANSWER_FILE_LIMITS.bytes)} each, ${ANSWER_FILE_LIMITS.perRun} files per answer.`,
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: 'The file\'s name with its extension: .csv, .tsv, .md, .txt or .json ("Late orders.csv").' },
      content: { type: "string", description: "The file's whole text, as it should be saved (CSV with a header row; Markdown as written)." },
    },
    required: ["name", "content"],
    additionalProperties: false,
  },
};

type Outcome = { content: string; isError?: boolean; step?: AgentToolRecord };

/** Attaches a file a chat run's call writes to its answer, for the person the run answers. */
export async function attachChatFile(
  run: { id: string; workspaceId: string; source: { kind: string; userId?: string; conversationId?: string } },
  agentUserId: string,
  call: AiToolCall,
): Promise<Outcome> {
  if (run.source.kind !== "chat" || !run.source.userId || !run.source.conversationId) return { content: `There is no tool "${ATTACH_FILE}" in this run.`, isError: true };
  const { userId, conversationId } = run.source;
  const name = typeof call.arguments.name === "string" ? call.arguments.name : "";
  const content = typeof call.arguments.content === "string" ? call.arguments.content : "";
  const checked = answerFile(name, content);
  if (!checked.ok) {
    return {
      content:
        checked.problem === "type"
          ? "Only CSV, TSV, Markdown, plain text and JSON files can be attached: give the name one of those extensions. Nothing was attached."
          : checked.problem === "empty"
            ? "The file has no content. Nothing was attached."
            : `The file is larger than ${formatBytes(ANSWER_FILE_LIMITS.bytes)}. Nothing was attached; make it shorter.`,
      isError: true,
    };
  }
  const [{ attached }] = await db.select({ attached: count() }).from(agentChatFile).where(eq(agentChatFile.runId, run.id));
  if (attached >= ANSWER_FILE_LIMITS.perRun) return { content: `You have attached ${ANSWER_FILE_LIMITS.perRun} files, the most one answer may have.`, isError: true };
  const step = (outcome: AgentToolRecord["outcome"]): AgentToolRecord => ({ kind: "tool", connectionId: null, tool: ATTACH_FILE, input: checked.name, outcome });
  try {
    await storeFile(
      {
        workspaceId: run.workspaceId,
        pageId: null,
        uploadedBy: agentUserId,
        record: async (tx, fileId) => void (await tx.insert(agentChatFile).values({ fileId, userId, workspaceId: run.workspaceId, conversationId, runId: run.id })),
      },
      { name: checked.name, contentType: checked.contentType, body: Readable.from([Buffer.from(content, "utf8")]), declaredSize: checked.size },
      { maxBytes: ANSWER_FILE_LIMITS.bytes },
    );
  } catch (error) {
    if (!(error instanceof FileError)) throw error;
    return {
      content: error.code === "quotaExceeded" ? "The workspace has no file storage left. Nothing was attached; say so in your answer." : `The file couldn't be attached (${error.message}).`,
      isError: true,
      step: step("failed"),
    };
  }
  return { content: `Attached "${checked.name}" (${formatBytes(checked.size)}) to your answer.`, step: step("done") };
}

/** A file an agent attached to `userId`'s chat; null otherwise, the same way whether it is missing or someone else's. */
export async function chatFileOfPerson(userId: string, fileId: string): Promise<FileRow | null> {
  const [found] = await db
    .select({ file })
    .from(file)
    .innerJoin(agentChatFile, eq(agentChatFile.fileId, file.id))
    .where(and(eq(file.id, fileId), eq(agentChatFile.userId, userId)))
    .limit(1);
  return found?.file ?? null;
}
