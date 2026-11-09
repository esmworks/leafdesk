import { redirect } from "next/navigation";
import { memoryPagePath } from "@/lib/ai-chat";

/** The Memory page's old address, under the chat: it has a place of its own now. */
export default async function OldMemoryRoute({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspaceId }, query] = await Promise.all([params, searchParams]);
  redirect(memoryPagePath(workspaceId, typeof query.section === "string" ? query.section : undefined));
}
