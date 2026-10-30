import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "@/db";
import { automationRun, databaseAutomation, page } from "@/db/schema";
import type { MeetingTriggerData } from "@/lib/automations";
import { MEETING_BLOCK, meetingProps, parseAttendees, type MeetingProps } from "@/lib/meetings";
import { kickAutomations } from "@/server/automations/queue";
import { getCollab } from "@/server/collab/bridge";

/**
 * Meetings starting automations (trigger `meeting_summarized`, lib/automations.ts): when the AI
 * has written up a meeting recorded on a database row's page (server/meetings.ts), each of the
 * database's published, turned-on automations made for it gets a run about that row, with whoever
 * ended the recording (or asked for the write-up again) as its actor. The runs go as the
 * automation's person, as row triggers' do, and the worker is woken at once.
 *
 * A run carries the write-up as it was written (`trigger_data.meeting`), so later edits to the
 * block don't change what it acts on; the transcript stays out, as steps send their texts to other
 * places (webhooks, Slack, mail).
 */

/** What a run's `{{trigger.meeting}}` is for a meeting block's props. */
export function meetingTriggerData(props: MeetingProps, regenerated: boolean): MeetingTriggerData {
  return {
    id: props.meetingId,
    title: props.title,
    summary: props.summary,
    decisions: props.decisions,
    actions: props.actions,
    attendees: parseAttendees(props.attendees).map((a) => a.name),
    seconds: props.seconds,
    startedAt: props.startedAt || null,
    endedAt: props.endedAt || null,
    regenerated,
  };
}

/**
 * Queues the runs a written-up meeting on page `pageId` starts, as `userId` did it: none when the
 * page isn't a live row of a database. Returns how many it queued.
 */
export async function meetingSummarized(userId: string, pageId: string, meeting: MeetingTriggerData): Promise<number> {
  const [row] = await db
    .select({ parentId: page.parentId, archivedAt: page.archivedAt, isTemplate: page.isTemplate, inTemplate: page.inTemplate })
    .from(page)
    .where(eq(page.id, pageId));
  if (!row?.parentId || row.archivedAt || row.isTemplate || row.inTemplate) return 0;
  const automations = await db
    .select({ id: databaseAutomation.id, version: databaseAutomation.version })
    .from(databaseAutomation)
    .where(
      and(
        eq(databaseAutomation.databaseId, row.parentId),
        eq(databaseAutomation.enabled, true),
        // A draft (version 0) waits until it is published.
        gt(databaseAutomation.version, 0),
        sql`${databaseAutomation.trigger}->>'type' = 'meeting_summarized'`,
      ),
    );
  if (!automations.length) return 0;
  await db.insert(automationRun).values(
    automations.map((a) => ({
      automationId: a.id,
      rowId: pageId,
      actorId: userId,
      created: false,
      changed: [],
      origin: "meeting" as const,
      version: a.version,
      triggerData: { meeting },
    })),
  );
  kickAutomations();
  return automations.length;
}

/**
 * The meeting a test run of a `meeting_summarized` automation acts on: the last written-up one on
 * the row's page, or an empty one when it has none.
 */
export async function latestMeeting(rowId: string): Promise<MeetingTriggerData> {
  const { blocks } = await getCollab().readBlocks(rowId);
  let found: MeetingProps | null = null;
  const walk = (list: unknown[]) => {
    for (const block of list as { type?: string; props?: Record<string, unknown>; children?: unknown[] }[]) {
      if (block.type === MEETING_BLOCK) {
        const props = meetingProps(block.props ?? {});
        if (props.status === "done" && (props.summary || props.decisions || props.actions)) found = props;
      }
      if (block.children?.length) walk(block.children);
    }
  };
  walk(blocks);
  return meetingTriggerData(found ?? meetingProps({}), false);
}
