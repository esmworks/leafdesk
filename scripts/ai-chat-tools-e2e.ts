/**
 * End-to-end check of the AI chat's tools for comments, history, CSV files, new databases and
 * forms, against the database, with a fake OpenAI-compatible server (src/server/ai/fake-openai.ts)
 * scripted per question: list_comments, page_history and page_version read as the person (a page
 * they can't open stays out); add_comment, create_database, create_database_from_csv and
 * create_form ask first and are made as the person once approved, refused where the person may
 * only read; a CSV file attached to a question (uploaded as the chat box does, ai-chat-files.ts)
 * goes to the model with the question, stays with the conversation for the questions after it, is
 * read further with read_attachment and becomes a database with its rows; CSV files too long or
 * empty are refused when uploaded, too many files before anything is sent.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/ai-chat-tools-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Needs no server.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray, isNull } = await import("drizzle-orm");
const { db } = await import("@/db");
const { databaseProperty, databaseView, formPublication, page, teamspace, user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createPage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const ops = await import("@/server/operations");
const { changeComments } = await import("@/server/comments");
const { isAiError } = await import("@/server/ai");
const { resetAi, setAiEnv } = await import("@/server/ai/testing");
const { startFakeOpenAi, textOf } = await import("@/server/ai/fake-openai");
type FakeChatRequest = import("@/server/ai/fake-openai").FakeChatRequest;
type FakeReply = import("@/server/ai/fake-openai").FakeReply;
const { getConversation, startChat } = await import("@/server/ai-chat");
const { decideChange } = await import("@/server/ai-chat-approvals");
const { ChatFileError, uploadChatFile } = await import("@/server/ai-chat-files");
const { Readable } = await import("node:stream");
type ChatEvent = import("@/lib/ai-chat").ChatEvent;
type ChatInput = import("@/server/ai-chat").ChatInput;
type ChatActionView = import("@/lib/ai-chat").ChatActionView;
type FormConfig = import("@/db/schema/app").FormConfig;

const RUN = `aichat-tools-e2e-${Date.now().toString(36)}`;

const { hocuspocus, service } = createCollab();
registerCollab(service);
const fake = await startFakeOpenAi();
const AI = {
  AI_PROVIDER: "openai-compatible",
  AI_MODEL: "fake-chat",
  AI_BASE_URL: fake.baseUrl,
  AI_WORKSPACE_RATE_LIMIT: "1000",
  AI_RATE_LIMIT: "1000",
};
setAiEnv(AI);

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

const everything = (request: FakeChatRequest) => request.messages.map((m) => textOf(m.content)).join("\n");
const toolResults = (request: FakeChatRequest) => request.messages.filter((m) => m.role === "tool").map((m) => textOf(m.content));
const lastResults = () => toolResults(fake.chats.at(-1)!);
const toolNames = (request: FakeChatRequest) => (request.tools ?? []).map((t) => t.function.name);

type Call = { name: string; arguments: Record<string, unknown> };
/** A model that makes these tool calls, one per turn (each may be worked out from the results so far), then answers. */
function caller(calls: (Call | ((results: string[]) => Call))[]) {
  return (request: FakeChatRequest): FakeReply => {
    const made = request.messages.filter((m) => m.role === "assistant" && m.tool_calls?.length).length;
    const next = calls[made];
    if (next) return { toolCalls: [typeof next === "function" ? next(toolResults(request)) : next] };
    return { text: "Done." };
  };
}

type Decision = "approve" | "decline" | null;
/** Runs a question to the end, deciding each approval it asks for; returns its events and steps. */
async function ask(userId: string, input: ChatInput, decide: Decision = "approve") {
  const events: ChatEvent[] = [];
  const asked: ChatActionView[] = [];
  for await (const event of await startChat(userId, input)) {
    events.push(event);
    if (event.type === "approval") {
      asked.push(event.action);
      if (decide) decideChange(userId, event.id, decide);
    }
  }
  const conversation = events.find((e) => e.type === "conversation");
  const end = events.at(-1);
  return {
    events,
    asked,
    done: end?.type === "done",
    conversationId: conversation?.type === "conversation" ? conversation.id : null,
    steps: events.flatMap((e) =>
      e.type !== "step" ? [] : e.step.kind === "write" ? [`write:${e.step.action}:${e.step.outcome}`] : e.step.kind === "read" ? [`read:${e.step.page?.title ?? "gone"}`] : [e.step.kind],
    ),
  };
}

async function refusal(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    return isAiError(error) ? error.code : `other: ${String(error)}`;
  }
}

const ids = { owner: `${RUN}-owner`, alice: `${RUN}-alice` };
const userIds = Object.values(ids);
const { owner, alice } = ids;
const workspaceId = `${RUN}-ws`;

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: owner, role: "owner" },
    { workspaceId, userId: alice, role: "member" },
  ]);
  const [general] = await db.select({ id: teamspace.id }).from(teamspace).where(eq(teamspace.workspaceId, workspaceId));
  const ownerCtx = { userId: owner, actor: { userId: owner } };
  const plan = await createPage(ownerCtx.actor, { workspaceId, teamspaceId: general.id, title: "Launch plan", markdown: "We launch in March.\n\nThe budget is tight." });
  // Two saves make two versions: the body before each.
  await ops.updatePage(ownerCtx, { page_id: plan.id, markdown: "We launch in April.\n\nThe budget is tight.", mode: "replace" });
  await ops.updatePage(ownerCtx, { page_id: plan.id, markdown: "We launch in April.\n\nThe budget is tight. Marketing gets more.", mode: "replace" });
  const open = await ops.addComment(ownerCtx, { page_id: plan.id, text: "Can we move this to May?", quote: "We launch in April." });
  await ops.addComment(ownerCtx, { page_id: plan.id, text: "Fine by me.", thread_id: open.thread_id });
  const closed = await ops.addComment(ownerCtx, { page_id: plan.id, text: "Settled last week.", quote: "The budget is tight." });
  await changeComments(owner, plan.id, { type: "resolveThread", threadId: closed.thread_id! });

  const diary = await createPage(ownerCtx.actor, { workspaceId, teamspaceId: null, title: "Owner diary", markdown: "Private thoughts." });
  await ops.addComment(ownerCtx, { page_id: diary.id, text: "SECRET-COMMENT about the diary", quote: "Private thoughts." });

  // A page Alice may only read, with a database under it.
  const handbook = await createPage(ownerCtx.actor, { workspaceId, teamspaceId: null, title: "Handbook", markdown: "Rules." });
  const readOnlyDb = await createPage(ownerCtx.actor, { workspaceId, parentId: handbook.id, kind: "database", title: "Read-only list" });
  await setPagePermission(owner, handbook.id, alice, "view");

  // ── Comments ──────────────────────────────────────────────────────────────────────────────
  fake.setChat(caller([{ name: "list_comments", arguments: { page_id: plan.id } }]));
  fake.chats.length = 0;
  const comments = await ask(alice, { workspaceId, message: "What do people say about the launch plan?" });
  const listed = lastResults()[0] ?? "";
  check(comments.done && comments.steps.includes("read:Launch plan"), "list_comments reads a page's comments as a step on the page", comments.steps);
  check(
    /2 comment threads \(1 open, 1 resolved\)/.test(listed) && listed.includes('on the text "We launch in April."') && listed.includes("Can we move this to May?") && listed.includes("Fine by me.") && listed.includes(`${owner}`),
    "…open and resolved threads, with their quote, replies and authors, as a source to cite",
    listed,
  );
  check(listed.includes("<source"), "…registered as a numbered source", listed);

  fake.setChat(caller([{ name: "list_comments", arguments: { page_id: diary.id } }]));
  fake.chats.length = 0;
  await ask(alice, { workspaceId, message: "Comments on the diary?" });
  check(lastResults()[0]?.startsWith("No page or version with that id can be read") && fake.chats.every((r) => !everything(r).includes("SECRET-COMMENT")), "a page the person can't open: its comments never reach the model", lastResults());

  // ── History ───────────────────────────────────────────────────────────────────────────────
  const versionOf = (results: string[]) => /version_id (\S+)/.exec(results.at(-1) ?? "")?.[1] ?? "";
  fake.setChat(
    caller([
      { name: "page_history", arguments: { page_id: plan.id } },
      (results) => ({ name: "page_version", arguments: { version_id: versionOf(results), compare: "previous" } }),
      (results) => ({ name: "page_version", arguments: { version_id: /version_id (\S+)\s·[^\n]*\n- version_id (\S+)/.exec(results[0])?.[2] ?? "", compare: "current" } }),
    ]),
  );
  fake.chats.length = 0;
  const history = await ask(alice, { workspaceId, message: "What changed on the launch plan?" });
  const [versions, previous, sinceOldest] = lastResults();
  check(history.done && /Saved versions of "Launch plan"/.test(versions) && (versions.match(/- version_id /g) ?? []).length >= 2, "page_history lists the page's saved versions, newest first", versions);
  check(/What changed by the version saved/.test(previous) && previous.includes("<source"), "page_version compares a version with the one before it, as a source", previous);
  check(/What changed from the version saved .* to the page now/.test(sinceOldest) && /March|April/.test(sinceOldest) && sinceOldest.includes("Marketing"), "…or with the page now, word by word", sinceOldest);

  fake.setChat(caller([{ name: "page_version", arguments: { version_id: "not-a-version" } }]));
  await ask(alice, { workspaceId, message: "Read that version" });
  check(lastResults()[0]?.startsWith("No page or version with that id can be read"), "an unknown version is refused", lastResults());

  // ── Adding a comment, asked first ─────────────────────────────────────────────────────────
  fake.setChat(caller([{ name: "add_comment", arguments: { page_id: plan.id, text: "Agreed, May works.", thread_id: open.thread_id } }]));
  fake.chats.length = 0;
  const reply = await ask(alice, { workspaceId, message: "Reply that May works" });
  const afterReply = await ops.listComments({ userId: alice, actor: { userId: alice } }, { page_id: plan.id, include_resolved: true });
  const thread = afterReply.threads.find((t) => t.id === open.thread_id);
  check(reply.asked[0]?.action === "addComment" && reply.asked[0].content === "Agreed, May works." && reply.asked[0].title === "We launch in April.", "add_comment asks first, showing the comment and the text it is about", reply.asked);
  check(reply.steps.includes("write:addComment:done") && thread?.comments.at(-1)?.text === "Agreed, May works." && thread.comments.at(-1)?.author_id === alice, "…and once approved replies in the thread as the person", { steps: reply.steps, thread });

  fake.setChat(caller([{ name: "add_comment", arguments: { page_id: plan.id, text: "Nice", quote: "This sentence is not there" } }]));
  fake.chats.length = 0;
  const noQuote = await ask(alice, { workspaceId, message: "Comment on it" });
  check(noQuote.asked.length === 0 && lastResults()[0]?.includes("the page has no such text"), "a quote that isn't on the page is refused before asking", lastResults());

  fake.setChat(caller([{ name: "add_comment", arguments: { page_id: plan.id, text: "Declined one", quote: "Marketing gets more." } }]));
  const declinedComment = await ask(alice, { workspaceId, message: "Comment on marketing" }, "decline");
  const afterDecline = await ops.listComments(ownerCtx, { page_id: plan.id, include_resolved: true });
  check(declinedComment.steps.includes("write:addComment:declined") && !afterDecline.threads.some((t) => t.comments.some((c) => c.text === "Declined one")), "a declined comment isn't added");

  fake.setChat(caller([{ name: "add_comment", arguments: { page_id: plan.id, text: "Auto", quote: "Marketing gets more." } }]));
  const readMode = await ask(alice, { workspaceId, message: "Comment", mode: "read" });
  check(readMode.done && !toolNames(fake.chats.at(-1)!).includes("add_comment") && !toolNames(fake.chats.at(-1)!).includes("create_database"), "with changes off, the write tools aren't offered", toolNames(fake.chats.at(-1)!));
  check(toolNames(fake.chats.at(-1)!).includes("list_comments") && toolNames(fake.chats.at(-1)!).includes("page_history"), "…the read tools are");

  // ── A new database ────────────────────────────────────────────────────────────────────────
  const properties = [
    { name: "Stage", type: "status" },
    { name: "Priority", type: "select", options: ["High", "Low"] },
    { name: "Due", type: "date" },
    { name: "Budget", type: "number" },
  ];
  fake.setChat(caller([{ name: "create_database", arguments: { title: "Launch tasks", parent_id: plan.id, properties } }]));
  fake.chats.length = 0;
  const created = await ask(alice, { workspaceId, message: "Make a database of launch tasks" });
  const [tasks] = await db.select().from(page).where(and(eq(page.workspaceId, workspaceId), eq(page.title, "Launch tasks"), eq(page.kind, "database")));
  const taskProps = tasks ? await db.select().from(databaseProperty).where(and(eq(databaseProperty.databaseId, tasks.id), isNull(databaseProperty.deletedAt))) : [];
  check(
    created.asked[0]?.action === "createDatabase" && created.asked[0].target?.pageId === plan.id && created.asked[0].properties?.map((p) => p.name).join() === "Stage,Priority,Due,Budget",
    "create_database asks first, with where it goes and its properties",
    created.asked,
  );
  check(
    tasks?.parentId === plan.id && tasks.createdBy === alice && created.steps.includes("write:createDatabase:done"),
    "…and once approved makes the database under the page, as the person",
    { tasks, steps: created.steps },
  );
  const priority = taskProps.find((p) => p.name === "Priority");
  check(
    ["Stage:status", "Priority:select", "Due:date", "Budget:number"].every((want) => taskProps.some((p) => `${p.name}:${p.type}` === want)) && priority?.options.options?.map((o) => o.name).join() === "High,Low",
    "…with the properties, types and options asked for",
    taskProps.map((p) => ({ name: p.name, type: p.type, options: p.options })),
  );
  check(lastResults()[0]?.includes(`database_id ${tasks.id}`) && lastResults()[0].includes("Priority"), "…and the model learns its id and properties", lastResults());

  fake.setChat(caller([{ name: "create_database", arguments: { title: "Not here", parent_id: handbook.id } }]));
  fake.chats.length = 0;
  const notHere = await ask(alice, { workspaceId, message: "Make a database in the handbook" });
  check(notHere.asked.length === 0 && lastResults()[0]?.startsWith("The person may only read this") && (await db.select().from(page).where(eq(page.title, "Not here"))).length === 0, "a database under a page the person may only read is refused", lastResults());

  fake.setChat(caller([{ name: "create_database", arguments: { title: "Bad types", properties: [{ name: "X", type: "formula" }] } }]));
  fake.chats.length = 0;
  await ask(alice, { workspaceId, message: "Make one with a formula" });
  check(lastResults()[0]?.startsWith("The change is not valid: properties.0: type must be one of"), "a property type the chat can't make is refused", lastResults());

  fake.setChat(caller([{ name: "create_database", arguments: { title: "Top level list" } }]));
  const top = await ask(alice, { workspaceId, message: "Make a list" }, "decline");
  check(top.asked[0]?.target === null && top.steps.includes("write:createDatabase:declined") && (await db.select().from(page).where(eq(page.title, "Top level list"))).length === 0, "a database at the top is asked about too, and not made when declined", top);

  // ── A form ────────────────────────────────────────────────────────────────────────────────
  fake.setChat(
    caller([
      {
        name: "create_form",
        arguments: {
          database_id: tasks.id,
          title: "Suggest a task",
          description: "Tell us what is missing.",
          questions: [{ property: "title", label: "Task" }, { property: "Priority", required: true }, { property: "Due" }],
          public: true,
        },
      },
    ]),
  );
  fake.chats.length = 0;
  const form = await ask(alice, { workspaceId, message: "Make a form to suggest tasks, with a public link" });
  const [formView] = await db.select().from(databaseView).where(and(eq(databaseView.databaseId, tasks.id), eq(databaseView.type, "form")));
  const [publication] = formView ? await db.select().from(formPublication).where(eq(formPublication.viewId, formView.id)) : [];
  check(
    form.asked[0]?.action === "createForm" && form.asked[0].title === "Suggest a task" && form.asked[0].publicForm === "signedIn" && form.asked[0].changes.some((c) => c.property === "Priority *"),
    "create_form asks first, with its questions (required ones marked) and that it gets a public link",
    form.asked,
  );
  const questions = (formView?.config as { form?: { title?: string; questions?: { propertyId: string; required?: boolean }[] } } | undefined)?.form;
  check(
    formView && questions?.title === "Suggest a task" && questions.questions?.length === 3 && questions.questions.some((q) => q.propertyId === priority!.id && q.required),
    "…and once approved adds a form view with the questions, title and description",
    formView,
  );
  check(publication && !publication.anonymous && publication.publishedBy === alice, "…opened to the web as the person", publication);
  check(lastResults()[0]?.includes(`/f/${publication.token}`) && lastResults()[0].includes(`?view=${formView.id}`), "…and the model gets the form's links to give", lastResults());

  fake.setChat(caller([{ name: "create_form", arguments: { database_id: readOnlyDb.id, questions: [{ property: "title" }] } }]));
  fake.chats.length = 0;
  const noForm = await ask(alice, { workspaceId, message: "Make a form on the read-only list" });
  check(noForm.asked.length === 0 && lastResults()[0]?.startsWith("The person may only read this"), "a form on a database the person may only read is refused", lastResults());

  fake.setChat(caller([{ name: "create_form", arguments: { database_id: tasks.id, questions: [{ property: "Nope" }] } }]));
  fake.chats.length = 0;
  await ask(alice, { workspaceId, message: "Make a form" });
  check(lastResults()[0]?.startsWith("The change is not valid:"), "a question about a property the database doesn't have is refused", lastResults());

  fake.setChat(
    caller([
      {
        name: "create_form",
        arguments: {
          database_id: tasks.id,
          title: "Urgent tasks",
          questions: [{ property: "title" }, { property: "Priority" }, { property: "Due", required: true, show_when: { question: "Priority", check: "is", values: ["High"] } }],
          show_own_answers: true,
        },
      },
    ]),
  );
  await ask(alice, { workspaceId, message: "Make a form that asks for a due date only for urgent tasks" });
  const [conditional] = await db
    .select()
    .from(databaseView)
    .where(and(eq(databaseView.databaseId, tasks.id), eq(databaseView.name, "Urgent tasks")));
  const conditionalForm = (conditional?.config as { form?: FormConfig } | undefined)?.form;
  const due = conditionalForm?.questions?.find((q) => q.propertyId === taskProps.find((p) => p.name === "Due")?.id);
  check(
    due?.showIf?.propertyId === priority!.id &&
      due.showIf.values?.[0] === priority!.options.options?.find((o) => o.name === "High")?.id &&
      conditionalForm?.showOwnAnswers === true,
    "create_form sets a question's condition by option name, and shows people their own answers",
    conditionalForm,
  );
  fake.setChat(
    caller([
      {
        name: "create_form",
        arguments: { database_id: tasks.id, questions: [{ property: "Due", show_when: { question: "Priority", check: "is", values: ["High"] } }, { property: "Priority" }] },
      },
    ]),
  );
  fake.chats.length = 0;
  await ask(alice, { workspaceId, message: "Make a form" });
  check(lastResults()[0]?.startsWith("The change is not valid:"), "a condition about a later question is refused", lastResults());

  // ── CSV files ─────────────────────────────────────────────────────────────────────────────
  /** Uploads a file as the chat box does; its id, to send with a question. */
  const attach = async (name: string, text: string) =>
    (await uploadChatFile(alice, workspaceId, { name, contentType: "text/csv", body: Readable.from([Buffer.from(text)]), declaredSize: Buffer.byteLength(text) })).id;
  /** Why an upload is refused (ChatFileError's problem). */
  const uploadRefusal = (name: string, text: string) =>
    attach(name, text).then(
      () => null,
      (error) => (error instanceof ChatFileError ? error.problem : String(error)),
    );
  const csv = ["Customer,Amount,Due,Paid", ...Array.from({ length: 40 }, (_, i) => `Customer ${i + 1},${(i + 1) * 100},2026-11-${String((i % 28) + 1).padStart(2, "0")},${i % 2 ? "yes" : "no"}`)].join("\n");
  fake.setChat(() => ({ text: "There are 40 invoices." }));
  fake.chats.length = 0;
  const attached = await ask(alice, { workspaceId, message: "How many invoices are there?", attachments: [await attach("invoices.csv", csv)] });
  const firstAsk = everything(fake.chats[0]);
  check(attached.done && /<attachment name="invoices.csv" rows="40" columns="4"[^>]*>\nCustomer,Amount,Due,Paid\nCustomer 1,100,/.test(firstAsk), "a CSV file goes to the model with the question, as a tagged table", firstAsk.slice(0, 2000));
  check(toolNames(fake.chats[0]).includes("read_attachment") && toolNames(fake.chats[0]).includes("create_database_from_csv"), "…with the file tools offered", toolNames(fake.chats[0]));
  const kept = await getConversation(alice, workspaceId, attached.conversationId!);
  check(
    kept.messages[0].attachments?.length === 1 && kept.messages[0].attachments[0].name === "invoices.csv" && kept.messages[0].attachments[0].rows === 40 && kept.messages[0].attachments[0].columns === 4,
    "the question is kept with its file, shown by name and size",
    kept.messages[0],
  );

  fake.setChat(caller([{ name: "read_attachment", arguments: { from_row: 39 } }]));
  fake.chats.length = 0;
  const followUp = await ask(alice, { workspaceId, conversationId: attached.conversationId, message: "Who is the last customer?" });
  check(followUp.done && everything(fake.chats[0]).includes('<attachment name="invoices.csv"') && lastResults()[0]?.startsWith('Rows 39-40 of 40 of "invoices.csv"') && lastResults()[0].includes("Customer 40,4000"), "a later question still sees the file, and read_attachment reads its rows", lastResults());

  fake.setChat(caller([{ name: "create_database_from_csv", arguments: { title: "Invoices", parent_id: plan.id, column_types: { Paid: "checkbox" } } }]));
  fake.chats.length = 0;
  const fromCsv = await ask(alice, { workspaceId, conversationId: attached.conversationId, message: "Make it a database" });
  const [invoices] = await db.select().from(page).where(and(eq(page.workspaceId, workspaceId), eq(page.title, "Invoices"), eq(page.kind, "database")));
  const invoiceProps = invoices ? await db.select().from(databaseProperty).where(and(eq(databaseProperty.databaseId, invoices.id), isNull(databaseProperty.deletedAt))) : [];
  const invoiceRows = invoices ? await db.select().from(page).where(and(eq(page.parentId, invoices.id), isNull(page.archivedAt))) : [];
  check(
    fromCsv.asked[0]?.action === "createDatabase" && fromCsv.asked[0].fromFile?.name === "invoices.csv" && fromCsv.asked[0].fromFile.rows === 40 && fromCsv.asked[0].properties?.[0]?.type === "title",
    "create_database_from_csv asks first, saying which file and how many rows, with the columns' types",
    fromCsv.asked,
  );
  const amount = invoiceProps.find((p) => p.name === "Amount");
  const paid = invoiceProps.find((p) => p.name === "Paid");
  check(
    invoices?.parentId === plan.id && invoiceRows.length === 40 && amount?.type === "number" && invoiceProps.find((p) => p.name === "Due")?.type === "date" && paid?.type === "checkbox",
    "…and once approved imports the file as a database with its rows, the types guessed or given",
    { props: invoiceProps.map((p) => `${p.name}:${p.type}`), rows: invoiceRows.length },
  );
  const row7 = invoiceRows.find((r) => r.title === "Customer 7");
  check(row7?.properties[amount.id] === 700 && row7.properties[paid.id] === false && row7.createdBy === alice, "…its values kept, as the person", row7);

  fake.setChat(caller([{ name: "create_database_from_csv", arguments: { attachment: "other.csv" } }]));
  fake.chats.length = 0;
  await ask(alice, { workspaceId, conversationId: attached.conversationId, message: "Import other.csv" });
  check(lastResults()[0]?.includes('no attached file has that name. The files: "invoices.csv"'), "a file the conversation doesn't have is refused, naming the ones it has", lastResults());

  fake.setChat(() => ({ text: "Fine." }));
  const again = await ask(alice, { workspaceId, conversationId: attached.conversationId, message: "And this one?", attachments: [await attach("invoices.csv", "a,b\n1,2")] });
  const renamed = await getConversation(alice, workspaceId, again.conversationId!);
  check(renamed.messages.at(-2)?.attachments?.[0]?.name === "invoices (2).csv", "a second file with the same name gets its own name", renamed.messages.at(-2));

  fake.setChat(() => ({ text: "It lists two products." }));
  fake.chats.length = 0;
  const fileOnly = await ask(alice, { workspaceId, message: "", attachments: [await attach("products.csv", "Product,Price\nLamp,40\nDesk,250")] });
  const fileOnlyKept = await getConversation(alice, workspaceId, fileOnly.conversationId!);
  check(
    fileOnly.done && everything(fake.chats[0]).includes('<attachment name="products.csv"') && fileOnlyKept.messages[0].attachments?.[0]?.name === "products.csv" && fileOnlyKept.title.includes("products.csv"),
    "a file sent without a question is asked about, the conversation named after it",
    { title: fileOnlyKept.title, first: fileOnlyKept.messages[0] },
  );

  const tooMany = ["a", ...Array.from({ length: 1_001 }, (_, i) => String(i))].join("\n");
  check((await uploadRefusal("big.csv", tooMany)) === "tooManyRows", "a file of more than 1,000 rows is refused when uploaded");
  check((await uploadRefusal("empty.csv", "")) === "empty", "…an empty one too");
  const six = await Promise.all(Array.from({ length: 6 }, (_, i) => attach(`f${i}.csv`, "a\n1")));
  check((await refusal(() => startChat(alice, { workspaceId, message: "Read them", attachments: six }))) === "invalid", "…and more than five files at once before anything is sent");

  fake.setChat(caller([{ name: "read_attachment", arguments: {} }]));
  fake.chats.length = 0;
  const noFiles = await ask(alice, { workspaceId, message: "No files here" });
  check(noFiles.done && !toolNames(fake.chats[0]).includes("read_attachment") && !toolNames(fake.chats[0]).includes("create_database_from_csv"), "a conversation without files isn't offered the file tools", toolNames(fake.chats[0]));

  console.log(`\n${passed} checks passed`);
} finally {
  resetAi();
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  await fake.close();
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
