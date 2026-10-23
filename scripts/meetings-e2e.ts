/**
 * End-to-end check of meeting notes (server/meetings.ts) against the database, with the fake
 * OpenAI-compatible server standing in for speech to text and the chat model (no network): a
 * "New meeting note" page, recording refused without speech to text, two pieces of audio
 * transcribed into the block at their times (sent out of order), a gap, who may record, the
 * three-hour limit, the summary with its timestamps and assignees written in when the recording
 * ends, Regenerate summary, the page's Markdown and search text, and the Meetings list (people who
 * can't see the page, and the trash). Creates its own users and workspace and deletes them after.
 *
 *   pnpm tsx scripts/meetings-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Needs no server.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { meetingNote, page, user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab, getCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { archivePage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const meetings = await import("@/server/meetings");
const { disableAi, resetAi, setAiEnv } = await import("@/server/ai/testing");
const { startFakeOpenAi, textOf } = await import("@/server/ai/fake-openai");
const { MEETING_BLOCK, meetingProps, parseTranscript, serializeAttendees, MAX_MEETING_SECONDS } = await import("@/lib/meetings");

const RUN = `meetings-e2e-${Date.now().toString(36)}`;
const { hocuspocus, service } = createCollab();
registerCollab(service);

let passed = 0;
function check(condition: unknown, label: string, detail?: unknown): asserts condition {
  if (!condition) {
    console.error(`FAIL  ${label}`);
    if (detail !== undefined) console.error(typeof detail === "string" ? detail : JSON.stringify(detail, null, 2));
    throw new Error(`Check failed: ${label}`);
  }
  passed++;
  console.log(`ok    ${label}`);
}

async function refused(run: () => Promise<unknown>, code: string, label: string) {
  try {
    await run();
  } catch (error) {
    check((error as { code?: string }).code === code, label, String(error));
    return;
  }
  check(false, `${label} (no error)`);
}

// Each "recording" is its own size, which says what was said in it.
const SAID: Record<number, string> = {
  1000: "Okay everyone, the launch moves to May.",
  2000: "Ayşe will tell the customer by Friday.",
};
const audio = (size: number) => ({ bytes: new Blob([new Uint8Array(size)], { type: "audio/webm" }), type: "audio/webm" });

const fake = await startFakeOpenAi();
fake.setTranscript(({ size }) => SAID[size] ?? "");
let summaries = 0;
fake.setChat((request) => {
  const prompt = textOf(request.messages.at(-1)?.content ?? "");
  if (!prompt.includes("<transcript>")) return { text: "ok" };
  summaries++;
  return {
    text: [
      "## Summary",
      `- The launch moves to May [00:00]${summaries > 1 ? " (again)" : ""}`,
      "## Decisions",
      "- Launch in May [00:00]",
      "## Action items",
      "- [ ] @Ayşe: Tell the customer by Friday [00:30]",
    ].join("\n"),
  };
});
const AI_ENV = {
  AI_PROVIDER: "openai-compatible",
  AI_MODEL: "fake-chat",
  AI_BASE_URL: fake.baseUrl,
  AI_WORKSPACE_RATE_LIMIT: "1000",
  AI_RATE_LIMIT: "1000",
  STT_PROVIDER: "openai-compatible",
  STT_MODEL: "fake-whisper",
  STT_BASE_URL: fake.baseUrl,
};

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member`, viewer: `${RUN}-viewer` };
const userIds = Object.values(ids);
const ws = `${RUN}-ws`;

async function meetingOn(pageId: string) {
  const { blocks } = await getCollab().readBlocks(pageId);
  const found = (blocks as { type: string; props: Record<string, unknown> }[]).find((b) => b.type === MEETING_BLOCK);
  return found ? meetingProps(found.props) : null;
}

async function waitFor<T>(read: () => Promise<T>, ok: (value: T) => boolean, label: string): Promise<T> {
  const until = Date.now() + 15_000;
  let value = await read();
  while (!ok(value) && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    value = await read();
  }
  check(ok(value), label, value);
  return value;
}

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id === ids.owner ? "Owner" : id === ids.member ? "Ayşe" : "Viewer", email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: ws, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId: ws, userId: ids.owner, role: "owner" },
    { workspaceId: ws, userId: ids.member, role: "member" },
    { workspaceId: ws, userId: ids.viewer, role: "member" },
  ]);

  // ------------------------------------------------------------------ a new meeting note
  const { id: pageId } = await meetings.createMeetingNote(ids.owner, ws, "Meeting notes, today");
  const [created] = await db.select().from(page).where(eq(page.id, pageId));
  check(created.teamspaceId === null && created.title === "Meeting notes, today", "New meeting note makes a private page", created);
  const first = await meetingOn(pageId);
  check(first?.meetingId && first.status === "" && first.scheduledAt, "…holding a meeting block planned for now", first);
  const meetingId = first.meetingId;
  // The browser fills in the title and attendees (as the block does through the editor).
  await getCollab().updateBlockAttributes(
    pageId,
    MEETING_BLOCK,
    (p) => p.meetingId === meetingId,
    () => ({ title: "Launch sync", attendees: serializeAttendees([{ id: ids.member, name: "Ayşe" }]) }),
    { userId: ids.owner },
  );

  // ------------------------------------------------------------------ without speech to text
  disableAi();
  await refused(() => meetings.startMeeting(ids.owner, pageId, meetingId), "disabled", "recording is refused without speech to text");
  setAiEnv(AI_ENV);

  // ------------------------------------------------------------------ who may record
  await refused(() => meetings.startMeeting(ids.member, pageId, meetingId), "noAccess", "someone who can't edit the page can't record it");
  await setPagePermission(ids.owner, pageId, ids.member, "edit");
  const started = await meetings.startMeeting(ids.owner, pageId, meetingId, "Owner");
  check(started.seconds === 0 && started.nextChunk === 0, "the owner starts recording from the beginning", started);
  await refused(() => meetings.startMeeting(ids.member, pageId, meetingId), "busy", "nobody else starts it while it is being recorded");
  const place = (chunk: number, offset: number) => ({ pageId, meetingId, chunk, offset, duration: 30 });
  await refused(() => meetings.addMeetingChunk(ids.member, place(0, 0), audio(1000)), "notRecording", "someone else's pieces aren't taken");
  await refused(() => meetings.addMeetingChunk(ids.owner, place(9, MAX_MEETING_SECONDS + 100), audio(1000)), "tooLong", "pieces past three hours are refused");

  // ------------------------------------------------------------------ pieces of the recording
  const second = await meetings.addMeetingChunk(ids.owner, place(1, 30), audio(2000));
  check(second.text === SAID[2000], "the second piece is transcribed (it arrived first)", second);
  await meetings.addMeetingChunk(ids.owner, place(0, 0), audio(1000));
  await meetings.markMeetingGap(ids.owner, place(2, 60));
  const recorded = await meetingOn(pageId);
  const chunks = parseTranscript(recorded?.transcript);
  check(
    JSON.stringify(chunks.map((c) => ("gap" in c ? ["gap", c.t] : [c.x, c.t]))) === JSON.stringify([[SAID[1000], 0], [SAID[2000], 30], ["gap", 60]]),
    "the transcript has both pieces in time order and the gap at its time",
    chunks,
  );
  check(recorded?.seconds === 90 && recorded.status === "recording" && recorded.recorderName === "Owner", "…and counts the seconds recorded", recorded);
  check(fake.transcribed.length === 2 && fake.transcribed.every((t) => t.model === "fake-whisper"), "each piece went to speech to text once", fake.transcribed);

  // ------------------------------------------------------------------ the summary
  await meetings.finishMeeting(ids.owner, pageId, meetingId, 90);
  const done = await waitFor(() => meetingOn(pageId), (m) => m?.status === "done", "stopping writes the summary in the background");
  check(done?.summary === "- The launch moves to May [00:00]" && done.decisions === "- Launch in May [00:00]", "…summary and decisions with their moments", done);
  check(done?.actions === "- [ ] @Ayşe: Tell the customer by Friday [00:30]" && done.notice === "", "…and the action item for the attendee", done);
  const summaryPrompt = textOf(fake.chats.at(-1)?.messages.at(-1)?.content ?? "");
  check(summaryPrompt.includes(`[00:30] ${SAID[2000]}`) && summaryPrompt.includes("Ayşe") && summaryPrompt.includes("[01:00] (not transcribed)"), "the AI read the transcript with its timestamps and the attendees", summaryPrompt);
  await refused(() => meetings.addMeetingChunk(ids.owner, place(3, 90), audio(1000)), "notRecording", "an ended meeting takes no more pieces");

  await meetings.regenerateMeetingSummary(ids.member, pageId, meetingId);
  await waitFor(() => meetingOn(pageId), (m) => m?.status === "done" && m.summary.includes("(again)"), "Regenerate summary writes it again");

  // ------------------------------------------------------------------ Markdown and search
  const [saved] = await db.select({ markdown: page.contentMarkdown, text: page.contentText }).from(page).where(eq(page.id, pageId));
  check(saved.markdown.includes(`<!-- leafdesk:meeting ${meetingId} -->`) && saved.markdown.includes("### Launch sync"), "the page's Markdown has the meeting's region", saved.markdown);
  check(saved.markdown.includes(`- [00:30] ${SAID[2000]}`) && saved.markdown.includes("- [ ] @Ayşe: Tell the customer by Friday [00:30]"), "…with the transcript and the action items", saved.markdown);
  check(saved.text.includes(SAID[1000]) && saved.text.includes("Tell the customer"), "search text holds the transcript and the takeaways", saved.text);

  // A rewrite of the body through Markdown (MCP, the source view) keeps the block whole.
  await getCollab().replaceContent(pageId, `${saved.markdown}\n\nAfter the meeting.`, { userId: ids.owner });
  const kept = await meetingOn(pageId);
  check(kept?.meetingId === meetingId && parseTranscript(kept.transcript).length === 3 && kept.summary.includes("(again)"), "a Markdown rewrite keeps the meeting block as it was", kept);

  // ------------------------------------------------------------------ the Meetings list
  const listed = await meetings.listMeetings(ids.owner, ws);
  check(listed.length === 1 && listed[0].title === "Launch sync" && listed[0].seconds === 90, "the Meetings page lists it", listed);
  check(listed[0].attendees[0]?.name === "Ayşe" && listed[0].status === "done" && listed[0].preview.startsWith("The launch moves to May"), "…with attendees, status and the summary's first point", listed[0]);
  check((await meetings.listMeetings(ids.member, ws)).length === 1, "…for someone it was shared with");
  check((await meetings.listMeetings(ids.viewer, ws)).length === 0, "…but not for someone who can't see the private page");
  await archivePage(ids.owner, pageId);
  check((await meetings.listMeetings(ids.owner, ws)).length === 0, "a meeting in the trash isn't listed");
  check((await db.select().from(meetingNote).where(eq(meetingNote.pageId, pageId))).length === 1, "…though its row stays, for a restore");

  console.log(`\n${passed} checks passed`);
} finally {
  resetAi();
  await fake.close();
  await db.delete(workspace).where(eq(workspace.id, ws));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
