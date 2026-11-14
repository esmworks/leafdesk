/**
 * The trigger layer: everything that starts a run (a chat message, a person's own question, a
 * mention, an owner's request, a schedule, an automation's agent step or a row button, new email,
 * a connection's event, another agent's task) starts it through `startTriggered`, which queues the
 * run (`agent_run`) and puts it in a conversation by the trigger's rule (lib/triggers.ts
 * ConversationRule): a fresh one, the one kept for a key (`conversation.key`), or the chat's own.
 * `listTriggers` is the one list of what can start an agent's (or the person's own) runs.
 *
 * Which conversation a run joins is a link only (`agent_run.conversation_id`): who sees the run,
 * whose access it is held to and what it reads are still decided by its `source`
 * (lib/agents.ts ownerSeesRun, accessSource). An agent's runs that no chat started go to
 * conversations of the agent's own user, which no person lists; a person's own question to theirs.
 * Agent chats keep their own path for everything else (chat.ts, chat-store.ts lock the conversation
 * and write its messages) and pass their already locked conversation here with rule `fixed`.
 */
import { and, eq, gt, isNull, lte, notExists, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { agentRun, connection, connectionTrigger, conversation, databaseAutomation, page, workspaceAgent } from "@/db/schema";
import { MAX_AGENT_PROMPT, type AgentRunContext, type RunSource } from "@/lib/agents";
import { conversationTitle } from "@/lib/ai-chat";
import { conversationRuleFor, MAX_CONVERSATION_KEY, type ConversationRule, type TriggerTarget, type TriggerView } from "@/lib/triggers";
import { kickAgents } from "@/server/agents/kick";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

export type TriggeredRun = typeof agentRun.$inferSelect;

export type TriggerStart = {
  /** Whose run: an agent's, or the person's own AI chat (`self`, source `assistant`). */
  target: TriggerTarget;
  workspaceId: string;
  source: RunSource;
  context: AgentRunContext;
  prompt: string;
  /** Which conversation it goes to; the source's usual one (conversationRuleFor) when left out. */
  conversation?: ConversationRule;
  /** Taken at once by the caller, which runs it itself (a helper asked with ask_agent, a chat question answered in its request). */
  claimed?: boolean;
  /**
   * Within the caller's transaction (a lock it holds, a conversation it locked): the run and its
   * conversation are written there, and the caller wakes the worker once it commits.
   */
  tx?: Tx;
};

/**
 * What makes two triggered runs the same run: the automation's run and row, the event and trigger,
 * the schedule and the time it was due, the comment or channel message that mentioned the agent,
 * or the email that came. A step taken again (its worker stopped before saving that it queued the run) finds the run
 * it queued rather than queuing another. Null where every run is its own (a chat message, a
 * request, another agent's task).
 */
function sameSource(source: RunSource, context: AgentRunContext): SQL | null {
  // A "for each" step runs the agent once per found row of the automation's run.
  if (source.kind === "automation") return sql`${agentRun.source}->>'automationRunId' = ${source.automationRunId} and ${agentRun.source}->>'rowId' = ${source.rowId}`;
  if (source.kind === "connection") return sql`${agentRun.source}->>'eventId' = ${source.eventId} and ${agentRun.source}->>'triggerId' = ${source.triggerId}`;
  if (source.kind === "mention") return sql`${agentRun.source}->>'commentId' = ${source.commentId}`;
  if (source.kind === "channel") return sql`${agentRun.source}->>'kind' = 'channel' and ${agentRun.source}->>'messageId' = ${source.messageId}`;
  if (source.kind === "mail") return sql`${agentRun.source}->>'kind' = 'mail' and ${agentRun.source}->>'messageId' = ${source.messageId}`;
  // A chain's step: one run per step of the chain's run (server/agents/chains.ts), the same agent twice in a chain included.
  if (source.kind === "schedule" && source.chain) {
    return sql`${agentRun.source}->'chain'->>'runId' = ${source.chain.runId} and (${agentRun.source}->'chain'->>'step')::int = ${source.chain.step}`;
  }
  const scheduledFor = "scheduledFor" in context ? context.scheduledFor : undefined;
  if (source.kind === "schedule" && scheduledFor) {
    return sql`${agentRun.source}->>'scheduleId' = ${source.scheduleId} and ${agentRun.context}->>'scheduledFor' = ${scheduledFor}`;
  }
  if (source.kind === "assistant" && source.scheduleId && scheduledFor) {
    return sql`${agentRun.source}->>'userId' = ${source.userId} and ${agentRun.source}->>'scheduleId' = ${source.scheduleId} and ${agentRun.context}->>'scheduledFor' = ${scheduledFor}`;
  }
  return null;
}

/** The person whose conversations a target's triggered runs go to: the person's own, or the agent's own user. */
async function conversationOwner(ex: Executor, target: TriggerTarget): Promise<string> {
  if ("self" in target) return target.self;
  const [agent] = await ex.select({ userId: workspaceAgent.userId }).from(workspaceAgent).where(eq(workspaceAgent.id, target.agentId)).limit(1);
  if (!agent) throw new Error("Agent not found");
  return agent.userId;
}

/** The conversation a run goes to by `rule`, made when there is none yet. */
async function conversationFor(ex: Executor, input: TriggerStart, rule: ConversationRule): Promise<string> {
  if (rule.rule === "fixed") return rule.conversationId;
  const agentId = "agentId" in input.target ? input.target.agentId : null;
  const userId = await conversationOwner(ex, input.target);
  const title = conversationTitle(input.prompt);
  if (rule.rule === "new") {
    const [made] = await ex.insert(conversation).values({ userId, workspaceId: input.workspaceId, agentId, title }).returning({ id: conversation.id });
    return made.id;
  }
  const key = rule.key.slice(0, MAX_CONVERSATION_KEY);
  // One per person, workspace, agent and key (conversation_key_idx): two triggers at once both find the one made first.
  const [made] = await ex
    .insert(conversation)
    .values({ userId, workspaceId: input.workspaceId, agentId, title, key })
    .onConflictDoNothing()
    .returning({ id: conversation.id });
  if (made) return made.id;
  const [kept] = await ex
    .select({ id: conversation.id })
    .from(conversation)
    .where(and(eq(conversation.userId, userId), eq(conversation.workspaceId, input.workspaceId), agentId ? eq(conversation.agentId, agentId) : isNull(conversation.agentId), eq(conversation.key, key)))
    .limit(1);
  if (!kept) throw new Error("The trigger's conversation is gone");
  // An agent's own conversations go once none of their runs is kept (pruneTriggerConversations): one joined again stays.
  if (agentId) await ex.update(conversation).set({ updatedAt: new Date() }).where(eq(conversation.id, kept.id));
  return kept.id;
}

/**
 * Starts (or continues) a conversation for a trigger: queues the run in the conversation its rule
 * names, made when needed, and wakes the agents' worker. A trigger that fired before for the same
 * thing (sameSource, the same prompt) gets the run it started then, with `started` false. A
 * person's own run (`self`) answers in a conversation of theirs: the source's `conversationId` is
 * set to it.
 */
export async function startTriggered(input: TriggerStart): Promise<{ run: TriggeredRun; started: boolean }> {
  const self = "self" in input.target;
  if (self !== (input.source.kind === "assistant")) throw new Error("A person's own run has an assistant source, and only it");
  if ("self" in input.target && input.source.kind === "assistant" && input.source.userId !== input.target.self) throw new Error("A person's own run is theirs");
  const ex: Executor = input.tx ?? db;
  // An agent's task is cut to MAX_AGENT_PROMPT; a chat's turn (several messages) and a person's own question aren't.
  const prompt = self || input.source.kind === "chat" ? input.prompt : input.prompt.slice(0, MAX_AGENT_PROMPT);
  const same = sameSource(input.source, input.context);
  if (same) {
    const [queued] = await ex
      .select()
      .from(agentRun)
      .where(and("agentId" in input.target ? eq(agentRun.agentId, input.target.agentId) : isNull(agentRun.agentId), same, eq(agentRun.prompt, prompt)))
      .limit(1);
    if (queued) return { run: queued, started: false };
  }
  const rule = input.conversation ?? conversationRuleFor(input.source);
  const conversationId = await conversationFor(ex, { ...input, prompt }, rule);
  const source: RunSource = input.source.kind === "assistant" || input.source.kind === "chat" ? { ...input.source, conversationId } : input.source;
  const [run] = await ex
    .insert(agentRun)
    .values({
      agentId: "agentId" in input.target ? input.target.agentId : null,
      workspaceId: input.workspaceId,
      source,
      context: input.context,
      prompt,
      conversationId,
      ...(input.claimed ? { status: "running" as const, attempts: 1, startedAt: new Date() } : {}),
    })
    .returning();
  if (!input.tx && !input.claimed) kickAgents();
  return { run, started: true };
}

/** Queues a run of an agent for its source's usual conversation (startTriggered); its id. */
export async function queueAgentRun(input: { agentId: string; workspaceId: string; source: RunSource; context: AgentRunContext; prompt: string }): Promise<string> {
  const { run } = await startTriggered({ target: { agentId: input.agentId }, workspaceId: input.workspaceId, source: input.source, context: input.context, prompt: input.prompt });
  return run.id;
}

/**
 * The agents' own conversations (those triggers made, which no person lists) once none of their
 * runs is kept and nothing joined them for `days`: runs go after AGENT_RUN_HISTORY_DAYS (run.ts
 * pruneAgentRuns), and their conversations after them.
 */
export async function pruneTriggerConversations(days: number) {
  await db
    .delete(conversation)
    .where(
      and(
        sql`${conversation.userId} in (select ${workspaceAgent.userId} from ${workspaceAgent})`,
        lte(conversation.updatedAt, new Date(Date.now() - days * 24 * 60 * 60_000)),
        notExists(db.select({ one: sql`1` }).from(agentRun).where(eq(agentRun.conversationId, conversation.id))),
      ),
    );
}

// ---------------------------------------------------------------------------------- the list

/** Whether an automation's published steps (any depth: branches, "for each") run this agent. */
function runsAgent(actions: unknown, agentId: string): boolean {
  if (Array.isArray(actions)) return actions.some((a) => runsAgent(a, agentId));
  if (!actions || typeof actions !== "object") return false;
  const step = actions as Record<string, unknown>;
  if (step.type === "run_agent" && step.agentId === agentId) return true;
  return Object.values(step).some((v) => typeof v === "object" && v !== null && runsAgent(v, agentId));
}

/**
 * Everything that can start the agent's runs (or, without `agentId`, the person's own), as
 * `userId` may see it: how it can be used (chat, mention, channel, request), the agent's schedules (a task
 * hidden where it may name a database they can't open), the published automations of databases
 * they can open whose steps run it (a button property's click as `button`), new email in their own
 * mailboxes opened to it, and, for owners, the connections' events that start it. Without an agent:
 * the chat and the requests they ask on a schedule (server/own-requests.ts). Each with the
 * conversation rule its runs follow (lib/triggers.ts conversationRuleFor).
 */
export async function listTriggers(userId: string, workspaceId: string, agentId?: string | null): Promise<TriggerView[]> {
  // Loaded here: the agents' modules reach the worker, which queues through this module.
  const [{ requireMembership, pageVisibleTo, isGuest }, { aiAvailable }] = await Promise.all([import("@/server/access"), import("@/server/ai-writing")]);
  const membership = await requireMembership(userId, workspaceId);
  if (!agentId) {
    const { listOwnRequests } = await import("@/server/own-requests");
    return [{ kind: "chat", conversation: "fixed", available: await aiAvailable(workspaceId) }, ...(await listOwnRequests(userId, workspaceId))];
  }
  const [{ agentWithLevel }, { listAgentSchedules }, { agentMailboxesOf }, { AgentError }, { hasAgentLevel }] = await Promise.all([
    import("@/server/agents/sharing"),
    import("@/server/agents/schedules"),
    import("@/server/agents/mail"),
    import("@/server/agents/errors"),
    import("@/lib/agent-sharing"),
  ]);
  const { agent, level, owner } = await agentWithLevel(userId, agentId, "interact");
  if (agent.workspaceId !== workspaceId) throw new AgentError("notFound", "Agent not found");
  const live = agent.enabled && !agent.archivedAt;
  const views: TriggerView[] = [
    { kind: "chat", conversation: "fixed", available: live },
    // A member's comment mentioning it, on a page it may comment on (agents/mentions.ts).
    { kind: "mention", conversation: "keyed", available: live && !isGuest(membership.role) },
    // A member's message mentioning it in a channel of Messages it is in (agents/channel-mentions.ts).
    { kind: "channel", conversation: "keyed", available: live && !isGuest(membership.role) },
    // Asked for through MCP or the REST API by those who can edit it (agents/requests.ts).
    { kind: "request", conversation: "new", available: live && hasAgentLevel(level, "edit") },
  ];
  for (const s of await listAgentSchedules(userId, agent.id)) {
    views.push({
      kind: "schedule",
      conversation: "keyed",
      id: s.id,
      scheduleKind: "agent",
      enabled: s.enabled,
      rule: s.rule,
      timeZone: s.timeZone,
      task: s.task,
      taskHidden: s.taskHidden,
      databaseId: s.databaseId,
      nextRunAt: s.nextRunAt,
      lastRunAt: s.lastRunAt,
      lastError: s.lastError,
      failures: s.failures,
      setBy: s.setBy,
    });
  }
  // Chains it is a step of: those the viewer may run (agents/chains.ts).
  const { listAgentChains } = await import("@/server/agents/chains");
  if (!isGuest(membership.role)) {
    for (const c of await listAgentChains(userId, workspaceId)) {
      const steps = c.steps.flatMap((s, i) => (s.agentId === agent.id ? [i + 1] : []));
      if (!steps.length) continue;
      views.push({ kind: "chain", conversation: "keyed", id: c.id, name: c.name, steps, total: c.steps.length, repeats: c.repeats, enabled: c.enabled });
    }
  }
  const automations = await db
    .select({ id: databaseAutomation.id, name: databaseAutomation.name, enabled: databaseAutomation.enabled, trigger: databaseAutomation.trigger, actions: databaseAutomation.actions, databaseId: databaseAutomation.databaseId, databaseTitle: page.title })
    .from(databaseAutomation)
    .innerJoin(page, eq(page.id, databaseAutomation.databaseId))
    .where(
      and(
        eq(databaseAutomation.workspaceId, workspaceId),
        gt(databaseAutomation.version, 0),
        isNull(page.archivedAt),
        pageVisibleTo(userId),
        sql`jsonb_path_exists(${databaseAutomation.actions}, '$.** ? (@.type == "run_agent" && @.agentId == $agent)', jsonb_build_object('agent', ${agent.id}::text))`,
      ),
    )
    .orderBy(databaseAutomation.createdAt);
  for (const a of automations) {
    if (!runsAgent(a.actions, agent.id)) continue;
    const button = a.trigger.type === "button_clicked";
    views.push({
      kind: button ? "button" : "automation",
      conversation: "keyed",
      id: a.id,
      name: a.name,
      enabled: a.enabled,
      databaseId: a.databaseId,
      databaseTitle: a.databaseTitle,
      trigger: a.trigger.type,
      propertyId: a.trigger.type === "button_clicked" ? a.trigger.propertyId : null,
    });
  }
  for (const box of await agentMailboxesOf(userId, agent.id)) {
    if (!box.open) continue;
    views.push({ kind: "mail", conversation: "keyed", mailboxId: box.id, address: box.address, enabled: box.trigger.on, task: box.trigger.task });
  }
  // Connections are the owners' (connections/manage.ts): only they see what their events start.
  if (owner) {
    const triggers = await db
      .select({ trigger: connectionTrigger, connectionName: connection.name })
      .from(connectionTrigger)
      .innerJoin(connection, eq(connection.id, connectionTrigger.connectionId))
      .where(and(eq(connectionTrigger.agentId, agent.id), eq(connection.workspaceId, workspaceId)))
      .orderBy(connectionTrigger.createdAt);
    for (const { trigger, connectionName } of triggers) {
      views.push({
        kind: "connection",
        conversation: "new",
        id: trigger.id,
        connectionId: trigger.connectionId,
        connectionName,
        eventType: trigger.eventType,
        enabled: trigger.enabled,
        trusted: trigger.trusted,
        prompt: trigger.prompt,
      });
    }
  }
  return views;
}
