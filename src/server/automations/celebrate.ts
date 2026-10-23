/**
 * The "celebrate" step: confetti for whoever made the change that started the run. The server
 * tells only that person's open windows, over the workspace's signal channel (CELEBRATE_EVENT; see
 * components/celebrate.tsx), and nothing is stored. A run nobody started (a schedule, a date
 * passing, an incoming webhook, an anonymous form answer) has nobody to celebrate with, and a step
 * reached long after the change (CELEBRATE_WITHIN_MS) would come out of nowhere: both skip it.
 */
import { CELEBRATE_WITHIN_MS } from "@/lib/automations";
import { CELEBRATE_EVENT } from "@/lib/celebrate-event";
import { getCollab } from "@/server/collab/bridge";

export type CelebrateOutcome =
  | { status: "done"; output: { windows: number } }
  | { status: "skipped"; code: "noPerson" | "tooLate" };

export function celebrate(workspaceId: string, run: { actorId: string | null; createdAt: Date }, now = Date.now()): CelebrateOutcome {
  if (!run.actorId) return { status: "skipped", code: "noPerson" };
  if (now - run.createdAt.getTime() > CELEBRATE_WITHIN_MS) return { status: "skipped", code: "tooLate" };
  // Windows the person doesn't have open just miss it; the step still did what it could.
  const windows = getCollab().sendTo(`ws:${workspaceId}`, run.actorId, CELEBRATE_EVENT);
  return { status: "done", output: { windows } };
}
