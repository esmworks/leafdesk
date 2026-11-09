/**
 * End-to-end check of quizzes on pages against the database: an editor sets up a quiz; readers
 * read it without the right answers or explanations, submit wrong and then right answers, are held
 * to the attempts allowed and get the answers only once they passed or ran out; only editors see
 * everyone's results and ask people to take it; asking tells people in their inbox and finishing
 * tells whoever asked; someone without access is refused everything; a duplicated page gets its
 * own quiz; published HTML and exported Markdown carry no answers. Creates its own users and
 * workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/quizzes-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Needs no server.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { eq, inArray } = await import("drizzle-orm");
const Y = await import("yjs");
const { db } = await import("@/db");
const { notification, page, quiz, quizAttempt, user, workspace, workspaceMember } = await import("@/db/schema");
const { getCollab, registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createPage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { addTeamspaceMembers, createTeamspace } = await import("@/server/teamspaces");
const { listInbox } = await import("@/server/notifications");
const { duplicatePage } = await import("@/server/duplicate");
const { pageMarkdown } = await import("@/server/export");
const { bodySegmentsFromYdoc } = await import("@/server/published-body");
const { AccessError } = await import("@/server/access");
const { quizLine } = await import("@/lib/quiz-block");
const quizzes = await import("@/server/quizzes");

const RUN = `quiz-e2e-${Date.now().toString(36)}`;
// What no one but editors, and readers who are done, may ever be sent.
const SECRET = `QUIZ-SECRET-${Date.now()}`;

const { hocuspocus, service } = createCollab();
registerCollab(service);

let passed = 0;
function check(condition: unknown, label: string, detail?: unknown): asserts condition {
  if (!condition) {
    console.error(`FAIL  ${label}`);
    if (detail !== undefined) console.error(JSON.stringify(detail, null, 2));
    throw new Error(`Check failed: ${label}`);
  }
  passed++;
  console.log(`ok    ${label}`);
}

/** The error `run` throws: an AccessError, a QuizError's code, or "none". */
async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "none";
  } catch (error) {
    if (error instanceof AccessError) return "access";
    if (error instanceof quizzes.QuizError) return error.code;
    throw error;
  }
}

const ids = {
  owner: `${RUN}-owner`,
  editor: `${RUN}-editor`,
  reader: `${RUN}-reader`,
  tries: `${RUN}-tries`,
  asked: `${RUN}-asked`,
  failer: `${RUN}-failer`,
  outsider: `${RUN}-outsider`,
};
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;

/** Waits until the page's stored Markdown holds `text` (document saves are asynchronous). */
async function waitForMarkdown(pageId: string, text: string) {
  for (let i = 0; i < 200; i++) {
    const [row] = await db.select({ markdown: page.contentMarkdown }).from(page).where(eq(page.id, pageId));
    if (row?.markdown.includes(text)) return row.markdown;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("the page's body wasn't saved");
}

const questions = [
  {
    id: "q1",
    text: "Where is the fire exit?",
    kind: "single",
    options: [
      { id: "a", text: "Behind the kitchen" },
      { id: "b", text: "At the end of the hall" },
    ],
    correct: ["b"],
    explanation: `The signs point down the hall. ${SECRET}`,
  },
  {
    id: "q2",
    text: "What do you wear on site?",
    kind: "multiple",
    options: [
      { id: "a", text: "A helmet" },
      { id: "b", text: "Gloves" },
      { id: "c", text: "Sandals" },
    ],
    correct: ["a", "b"],
    explanation: "",
  },
];
const right = { q1: ["b"], q2: ["a", "b"] };
const wrong = { q1: ["a"], q2: ["a"] };
const half = { q1: ["b"], q2: ["a", "b", "c"] };

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id.split("-").at(-1)!, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values(userIds.map((userId) => ({ workspaceId, userId, role: userId === ids.owner ? ("owner" as const) : ("member" as const) })));
  const space = await createTeamspace(ids.owner, workspaceId, { name: "Training", access: "private", memberLevel: "view" });
  // Everyone but the outsider joins; the outsider is a member of the workspace who can't open the page.
  await addTeamspaceMembers(ids.owner, space.id, userIds.filter((u) => u !== ids.owner && u !== ids.outsider));
  const rules = await createPage({ userId: ids.owner }, { workspaceId, teamspaceId: space.id, title: "Safety rules", markdown: "Read this first." });
  await setPagePermission(ids.owner, rules.id, ids.editor, "content");

  // Setting it up
  check((await refusal(() => quizzes.createQuiz(ids.reader, rules.id))) === "access", "a reader can't add a quiz");
  const quizId = await quizzes.createQuiz(ids.editor, rules.id);
  const empty = await quizzes.readQuiz(ids.reader, quizId, rules.id);
  check(!empty.foreign && empty.questions.length === 0 && !empty.canEdit, "a new quiz is empty, and readers can't edit it");
  check((await refusal(() => quizzes.submitQuiz(ids.reader, quizId, {}))) === "empty", "a quiz without questions can't be taken");
  const bad = await refusal(() => quizzes.saveQuiz(ids.editor, quizId, { questions: [{ ...questions[0], correct: [] }], passMark: 80, maxAttempts: 2 }));
  check(bad === "settings", "a question without a right answer isn't saved");
  check((await refusal(() => quizzes.saveQuiz(ids.reader, quizId, { questions, passMark: 80, maxAttempts: 2 }))) === "access", "a reader can't change the questions");
  const saved = await quizzes.saveQuiz(ids.editor, quizId, { questions, passMark: 80, maxAttempts: 2 });
  check(!saved.foreign && saved.canEdit && saved.questions.length === 2 && saved.questions[0].correct?.join() === "b", "an editor saves the questions and sees the answers");
  check(JSON.stringify(saved).includes(SECRET), "…explanations included");

  await getCollab().replaceContent(rules.id, `Read this first.\n\n${quizLine(quizId)}\n\nThanks.`, { userId: ids.editor });
  const stored = await waitForMarkdown(rules.id, quizLine(quizId));
  check(!stored.includes(SECRET) && !stored.includes("Behind the kitchen"), "the page's stored Markdown holds only the quiz's id");

  // Reading it without the answers
  const asReader = await quizzes.readQuiz(ids.reader, quizId, rules.id);
  check(!asReader.foreign && asReader.questions.length === 2, "a reader reads the questions");
  check(!JSON.stringify(asReader).includes(SECRET) && asReader.questions.every((q) => q.correct === undefined && q.explanation === undefined), "…without right answers or explanations", asReader);
  check((await refusal(() => quizzes.readQuiz(ids.outsider, quizId, rules.id))) === "access", "someone who can't open the page can't read its quiz");
  check((await refusal(() => quizzes.readQuiz(ids.outsider, quizId, "any-page"))) === "access", "…not even through a block on another page");
  check((await refusal(() => quizzes.submitQuiz(ids.outsider, quizId, right))) === "access", "…nor take it");
  check((await refusal(() => quizzes.quizResults(ids.outsider, quizId))) === "access", "…nor see results");

  // Wrong, then right
  const first = await quizzes.submitQuiz(ids.reader, quizId, wrong);
  check(!first.foreign && first.mine.last?.score === 0 && !first.mine.last.passed && first.mine.left === 1, "wrong answers score 0 and leave one attempt", first);
  check(!JSON.stringify(first).includes(SECRET) && first.questions.every((q) => q.correct === undefined), "a failed attempt shows no answers yet");
  const second = await quizzes.submitQuiz(ids.reader, quizId, right);
  check(!second.foreign && second.mine.passed && second.mine.last?.score === 100 && second.mine.last.right.join() === "q1,q2", "right answers pass", second);
  check(second.revealed && JSON.stringify(second).includes(SECRET) && second.questions[1].correct?.join() === "a,b", "passing shows the answers and explanations");
  check((await refusal(() => quizzes.submitQuiz(ids.reader, quizId, right))) === "alreadyPassed", "a quiz passed isn't taken again");
  const reread = await quizzes.readQuiz(ids.reader, quizId, rules.id);
  check(!reread.foreign && reread.revealed && reread.mine.passedAt !== null, "reading it later still shows the answers to who passed");

  // Out of attempts
  const one = await quizzes.submitQuiz(ids.tries, quizId, half);
  check(!one.foreign && one.mine.last?.score === 50 && !one.revealed, "a multiple-choice question with an extra pick counts as wrong");
  const two = await quizzes.submitQuiz(ids.tries, quizId, wrong);
  check(!two.foreign && two.mine.left === 0 && two.revealed && JSON.stringify(two).includes(SECRET), "out of attempts, the answers are shown");
  check((await refusal(() => quizzes.submitQuiz(ids.tries, quizId, right))) === "noAttemptsLeft", "no more attempts than allowed");

  // Results and asking people
  check((await refusal(() => quizzes.quizResults(ids.reader, quizId))) === "access", "a reader can't see everyone's results");
  check((await refusal(() => quizzes.quizPeople(ids.reader, quizId))) === "access", "…nor whom to ask");
  check((await refusal(() => quizzes.assignQuiz(ids.reader, quizId, [ids.asked], null))) === "access", "…nor ask anyone");
  const people = await quizzes.quizPeople(ids.editor, quizId);
  check(people.some((p) => p.id === ids.asked) && !people.some((p) => p.id === ids.outsider), "only people who can open the page may be asked", people);
  check((await refusal(() => quizzes.assignQuiz(ids.editor, quizId, [ids.outsider], null))) === "people", "someone who can't open the page can't be asked");
  const assigned = await quizzes.assignQuiz(ids.editor, quizId, [ids.asked, ids.failer], "2026-12-01");
  check(assigned.added === 2, "an editor asks two people");
  const askedInbox = (await listInbox(ids.asked, workspaceId)).filter((n) => n.kind === "quiz_assigned");
  check(askedInbox.length === 1 && askedInbox[0].pageId === rules.id && askedInbox[0].reminderDate === "2026-12-01" && askedInbox[0].actorId === ids.editor, "the person asked finds it in their inbox", askedInbox);
  check((await quizzes.assignQuiz(ids.editor, quizId, [ids.asked], "2026-12-05")).added === 0, "asking again changes the day without a second notice");
  check((await listInbox(ids.asked, workspaceId)).filter((n) => n.kind === "quiz_assigned").length === 1, "…one notice still");
  const mine = await quizzes.readQuiz(ids.asked, quizId, rules.id);
  check(!mine.foreign && mine.mine.assigned?.due === "2026-12-05", "the person asked sees by when");

  await quizzes.submitQuiz(ids.asked, quizId, right);
  let finished = (await listInbox(ids.editor, workspaceId)).filter((n) => n.kind === "quiz_finished");
  check(finished.length === 1 && finished[0].actorId === ids.asked && finished[0].automationMessage === "passed:100", "passing tells whoever asked", finished);
  await quizzes.submitQuiz(ids.failer, quizId, wrong);
  check((await listInbox(ids.editor, workspaceId)).filter((n) => n.kind === "quiz_finished").length === 1, "a failed attempt with attempts left tells no one");
  await quizzes.submitQuiz(ids.failer, quizId, wrong);
  finished = (await listInbox(ids.editor, workspaceId)).filter((n) => n.kind === "quiz_finished" && n.actorId === ids.failer);
  check(finished.length === 1 && finished[0].automationMessage === "failed:0", "running out of attempts tells whoever asked", finished);

  const results = await quizzes.quizResults(ids.editor, quizId);
  const row = (id: string) => results.find((r) => r.userId === id);
  check(row(ids.reader)?.passed && row(ids.reader)?.attempts === 2 && row(ids.reader)?.best === 100 && !row(ids.reader)?.assigned, "results show a reader's best and attempts", results);
  check(row(ids.failer)?.assigned && row(ids.failer)?.due === "2026-12-01" && !row(ids.failer)?.passed, "…and who was asked, by when", results);
  check(!results.some((r) => r.userId === ids.outsider), "…and nobody else");
  await quizzes.unassignQuiz(ids.editor, quizId, ids.failer);
  check(!(await quizzes.quizResults(ids.editor, quizId)).find((r) => r.userId === ids.failer)?.assigned, "an editor stops asking someone; their attempts stay");

  // Published and exported
  const [body] = await db.select({ ydoc: page.ydoc, markdown: page.contentMarkdown }).from(page).where(eq(page.id, rules.id));
  const segments = await bodySegmentsFromYdoc(body.ydoc);
  const published = JSON.stringify(segments);
  check(published.includes("Read this first") && !published.includes(SECRET) && !published.includes(quizId) && !published.includes("Behind the kitchen"), "the published page leaves the quiz out", segments);
  const exported = await pageMarkdown(ids.owner, rules.id);
  check(exported.body.includes("*Quiz (2 questions)*") && !exported.body.includes(SECRET) && !exported.body.includes("Behind the kitchen") && !exported.body.includes(quizId), "exported Markdown says only that a quiz is there", exported.body);

  // A copy of the page
  const copy = await duplicatePage({ userId: ids.owner }, rules.id);
  const copied = await quizzes.pageQuizzes(copy.id);
  check(copied.length === 1 && copied[0].id !== quizId && JSON.stringify(copied[0].questions) === JSON.stringify((await quizzes.pageQuizzes(rules.id))[0].questions), "a duplicated page gets its own quiz with the same questions", copied);
  check((await db.select().from(quizAttempt).where(eq(quizAttempt.quizId, copied[0].id))).length === 0, "…and no one's attempts");
  const [copyBody] = await db.select({ ydoc: page.ydoc, markdown: page.contentMarkdown }).from(page).where(eq(page.id, copy.id));
  check(copyBody.markdown.includes(quizLine(copied[0].id)) && !copyBody.markdown.includes(quizLine(quizId)), "the copy's Markdown names its own quiz", copyBody.markdown);
  const copyDoc = new Y.Doc();
  Y.applyUpdate(copyDoc, copyBody.ydoc!);
  check(quizzes.quizIdsIn(copyDoc).join() === copied[0].id, "…and so does its document");
  copyDoc.destroy();
  const fresh = await quizzes.readQuiz(ids.reader, copied[0].id, copy.id);
  check(!fresh.foreign && fresh.mine.attempts === 0, "the copy starts afresh for everyone");

  // A block naming another page's quiz
  const foreign = await quizzes.readQuiz(ids.editor, quizId, copy.id);
  check(foreign.foreign && foreign.count === 2 && !JSON.stringify(foreign).includes(SECRET), "a block naming another page's quiz says only that", foreign);
  check(foreign.foreign && foreign.canCopy, "…and its editors may copy it there");
  check((await refusal(() => quizzes.copyQuizToPage(ids.reader, quizId, copy.id))) === "access", "a reader can't copy it");
  const madeHere = await quizzes.copyQuizToPage(ids.editor, quizId, copy.id);
  check((await quizzes.readQuiz(ids.editor, madeHere, copy.id)).foreign === false, "the copy made there is that page's");

  // Deleting the page for good deletes its quizzes and attempts
  await db.delete(page).where(eq(page.id, rules.id));
  check((await db.select().from(quiz).where(eq(quiz.id, quizId))).length === 0, "deleting the page deletes its quiz");
  check((await db.select().from(quizAttempt).where(eq(quizAttempt.quizId, quizId))).length === 0, "…and its attempts");
  check((await db.select().from(notification).where(eq(notification.pageId, rules.id))).length === 0, "…and the notices about it");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
