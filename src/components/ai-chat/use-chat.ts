"use client";

/**
 * One AI chat conversation as the panel and the full-page chat show it: its messages, the question
 * being typed, the streamed answer from `/api/ai/chat` (see server/ai-chat.ts) and what the model
 * is doing meanwhile. A question asked while an answer is on its way waits in a queue and is asked
 * once that answer is done. Stop cancels the answer and gives the queued questions back: the first
 * into an empty box, the rest still queued to follow it. Switching conversations or starting a new
 * one cancels the answer too, and keeps the conversation's queued questions for when it's opened
 * again. The mode (what the chat may change) is remembered in the browser; in mode `ask` a change
 * the model wants to make waits, as `pending`, for the person's decision. A long paste shows in the
 * box as a label (lib/chat-paste.ts) and is sent in its place. CSV files attached to a question
 * (lib/chat-attachments.ts) are read here, shown as chips, and sent with it.
 */
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { decideChangeAction, deleteConversationAction, getConversationAction } from "@/app/actions/ai";
import { isAiErrorCode } from "@/lib/ai";
import { CHAT_MODES, changedThings, thoughtText, type ChatActionView, type ChatEvent, type ChatMessageView, type ChatMode } from "@/lib/ai-chat";
import {
  CHAT_CSV_MAX_CHARS,
  CHAT_CSV_MAX_COLUMNS,
  CHAT_CSV_MAX_ROWS,
  CHAT_MAX_ATTACHMENTS,
  cleanAttachmentName,
  isCsvFile,
  uniqueAttachmentName,
  type AttachmentProblem,
  type ChatAttachmentView,
} from "@/lib/chat-attachments";
import { EMPTY_DRAFT, expandDraft, insertPaste, pasteLineCount, syncDraft, uniqueLabel, type ChatDraft } from "@/lib/chat-paste";
import { browserTimeZone } from "@/lib/time-zone";
import { holdAnswering } from "./answering";

/** What the model is doing while an answer is on its way: working on a turn, or writing. */
export type ChatStatus = "thinking" | "writing";

/** `startedAt`: when an answer being written was asked for (for its running time). */
export type ChatMessage = ChatMessageView & { key: string; startedAt?: number };

/** A change the model asks to make, waiting for the person's decision. */
export type PendingChange = { id: string; action: ChatActionView };

/** A skill picked for the next question: its instructions guide the answer (server/skills). */
export type ChatSkillPick = { id: string; title: string };

/** A CSV file attached to the question being typed: as shown, and its text (sent with the question). */
export type ChatFile = ChatAttachmentView & { text: string };

/** A question asked while an answer was on its way, waiting to be asked. */
export type QueuedQuestion = { question: string; skill: ChatSkillPick | null; scopePageId: string | null; files: ChatFile[] };

/**
 * The model's thinking on its current turn, as it comes (not kept): held apart from the messages so
 * that each piece redraws only the line showing it, not the conversation.
 */
export type Reasoning = { get(): string; subscribe(listener: () => void): () => void };

function reasoningStore() {
  let text = "";
  const listeners = new Set<() => void>();
  return {
    get: () => text,
    set(next: string) {
      if (next === text) return;
      text = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** The model's thinking on the current turn, kept up to date. */
export function useReasoning(reasoning: Reasoning): string {
  return useSyncExternalStore(reasoning.subscribe, reasoning.get, () => "");
}

/**
 * Questions left waiting when their conversation was left mid-answer (another one opened, the panel
 * closed): given back when it's opened again in this tab.
 */
const parked = new Map<string, QueuedQuestion[]>();

function park(conversationId: string | null, questions: QueuedQuestion[]) {
  if (conversationId && questions.length) parked.set(conversationId, [...(parked.get(conversationId) ?? []), ...questions]);
}

/** Yes; yes and don't ask again (the mode becomes `auto`); no. */
export type ChangeDecision = "approve" | "always" | "decline";

let keys = 0;
const nextKey = () => `m${++keys}`;

const MODE_KEY = "leafdesk.aiChat.mode";

function savedMode(): ChatMode {
  try {
    const saved = localStorage.getItem(MODE_KEY);
    return CHAT_MODES.find((m) => m === saved) ?? "ask";
  } catch {
    return "ask";
  }
}

export function useChat(
  workspaceId: string,
  {
    onConversation,
    onAnswered,
  }: {
    /** A conversation was started (by the first question) or opened. */
    onConversation?: (id: string | null) => void;
    /** An answer finished or failed: the conversation list may have changed. */
    onAnswered?: () => void;
  } = {},
) {
  const t = useTranslations("ai.chat");
  const ta = useTranslations("ai");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState<ChatDraft>(EMPTY_DRAFT);
  const input = draft.text;
  const [status, setStatus] = useState<ChatStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setModeState] = useState<ChatMode>("ask");
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [skill, setSkill] = useState<ChatSkillPick | null>(null);
  const [files, setFiles] = useState<ChatFile[]>([]);
  const filesNow = useRef(files);
  filesNow.current = files;
  const [queued, setQueued] = useState<QueuedQuestion[]>([]);
  const [reasoning] = useState(reasoningStore);
  const abort = useRef<AbortController | null>(null);
  // Read by a queued question asked from the end of the answer before it, after renders that
  // answer's own closure never saw (its conversation, a mode changed meanwhile).
  const queue = useRef<QueuedQuestion[]>([]);
  const conversationRef = useRef(conversationId);
  conversationRef.current = conversationId;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const inputNow = useRef(input);
  inputNow.current = input;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** The box's text, typed or set; a paste whose label is no longer in it goes. */
  const setInput = useCallback((text: string) => setDraft((d) => syncDraft(d, text)), []);
  /**
   * Puts a long paste in the box as a label, in place of `start..end`; returns where the caret goes
   * (after the label).
   */
  const pasteInput = (text: string, start: number, end: number) => {
    const label = uniqueLabel(draft.pastes, t("pasted", { count: pasteLineCount(text) }));
    const next = insertPaste(draft, text, label, start, end);
    inputNow.current = next.text;
    setDraft(next);
    return Math.min(start, end) + label.length;
  };
  /**
   * Attaches CSV files to the question being typed, read here with the limits the server keeps;
   * one that can't be attached says why (the others still are).
   */
  const attachFiles = async (list: readonly File[]) => {
    const problem = (p: AttachmentProblem) =>
      p === "tooManyRows"
        ? t("files.tooManyRows", { rows: CHAT_CSV_MAX_ROWS })
        : p === "tooManyColumns"
          ? t("files.tooManyColumns", { columns: CHAT_CSV_MAX_COLUMNS })
          : p === "tooLarge"
            ? t("files.tooLarge", { size: "1 MB" })
            : p === "tooMany"
              ? t("files.tooMany", { count: CHAT_MAX_ATTACHMENTS })
              : t(`files.${p}`);
    let next = filesNow.current;
    let failed: string | null = null;
    for (const file of list) {
      if (next.length >= CHAT_MAX_ATTACHMENTS) {
        failed = problem("tooMany");
        break;
      }
      if (!isCsvFile(file)) {
        failed = problem("notCsv");
        continue;
      }
      // Bytes first: a file far too large isn't read at all.
      if (file.size > CHAT_CSV_MAX_CHARS * 4) {
        failed = problem("tooLarge");
        continue;
      }
      // The parser is loaded with the first file, not with the chat.
      const { decodeText, readCsvAttachment } = await import("@/lib/chat-attachment-table");
      const text = decodeText(new Uint8Array(await file.arrayBuffer()));
      const read = readCsvAttachment(text);
      if (!read.ok) {
        failed = problem(read.problem);
        continue;
      }
      const name = uniqueAttachmentName(next.map((f) => f.name), cleanAttachmentName(file.name));
      next = [...next, { name, text, rows: read.table.rows.length, columns: read.table.headers.length }];
    }
    filesNow.current = next;
    setFiles(next);
    setError(failed);
  };
  const removeFile = (name: string) => {
    filesNow.current = filesNow.current.filter((f) => f.name !== name);
    setFiles(filesNow.current);
  };
  const setFilesNow = (next: ChatFile[]) => {
    filesNow.current = next;
    setFiles(next);
  };

  // The latest callbacks, without restarting anything when the caller passes new ones.
  const callbacks = useRef({ onConversation, onAnswered });
  callbacks.current = { onConversation, onAnswered };
  const running = status !== null;

  // Unmounted (the panel closed, the page left) mid-answer: the answer stops, its queue is parked.
  useEffect(
    () => () => {
      abort.current?.abort();
      park(conversationRef.current, queue.current);
    },
    [],
  );
  // The sidebar's list marks the conversation while its answer is on its way.
  useEffect(() => (running && conversationId ? holdAnswering(conversationId) : undefined), [running, conversationId]);
  // After hydration: the server doesn't know the browser's choice.
  useEffect(() => setModeState(savedMode()), []);

  const setMode = useCallback((next: ChatMode) => {
    setModeState(next);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {}
  }, []);

  const errorText = useCallback(
    (code: unknown) => {
      const c = isAiErrorCode(code) ? code : "provider";
      // The chat says some things its own way; the rest as the other AI features do.
      if (c === "noAccess" || c === "tooLarge" || c === "disabled" || c === "invalid") return t(`errors.${c}`);
      return ta(`errors.${c}`);
    },
    [t, ta],
  );

  const updateLast = (fn: (m: ChatMessage) => ChatMessage) =>
    setMessages((list) => (list.length && list[list.length - 1].role === "assistant" ? [...list.slice(0, -1), fn(list[list.length - 1])] : list));

  const setQueue = (next: QueuedQuestion[]) => {
    queue.current = next;
    setQueued(next);
  };

  /**
   * Gives back questions that weren't asked (`unasked`, then the queue's): the first into the box
   * when nothing is typed there, the rest staying queued, to follow the next answer.
   */
  const giveBack = (unasked: QueuedQuestion[] = []) => {
    const all = [...unasked, ...queue.current];
    const toBox = inputNow.current.trim() || filesNow.current.length ? undefined : all[0];
    setQueue(toBox ? all.slice(1) : all);
    if (!toBox) return;
    inputNow.current = toBox.question;
    setInput(toBox.question);
    setSkill((current) => current ?? toBox.skill);
    setFilesNow(toBox.files);
  };

  /** Stops the answer and leaves the conversation, its queued questions parked for its return. */
  const leave = () => {
    abort.current?.abort();
    park(conversationRef.current, queue.current);
    setQueue([]);
  };

  /**
   * Asks the typed question with the picked skill, of the whole workspace or of `scopePageId` and
   * its subpages; with `again`, asks its question (the last one, maybe edited, with the skill it
   * used) in place of the last question and answer. While an answer is on its way, the typed
   * question is queued instead.
   */
  async function send(scopePageId: string | null, again?: { question: string; skill?: ChatSkillPick }) {
    const question = (again?.question ?? expandDraft(draft)).trim();
    const attached = again ? [] : filesNow.current;
    if (!question && !attached.length) return;
    if (running) {
      if (again) return;
      setQueue([...queue.current, { question, skill, scopePageId, files: attached }]);
      setInput("");
      setSkill(null);
      setFilesNow([]);
      return;
    }
    if (!again) {
      setInput("");
      setSkill(null);
      setFilesNow([]);
    }
    await ask(question, again ? (again.skill ?? null) : skill, scopePageId, Boolean(again), attached);
  }

  async function ask(question: string, used: ChatSkillPick | null, scopePageId: string | null, again: boolean, attached: ChatFile[] = []) {
    setError(null);
    const controller = new AbortController();
    abort.current = controller;
    const startedAt = Date.now();
    const before = messages;
    // Asked again, a question keeps the files it had (the server keeps them too).
    const shownFiles = again ? messages[messages.length - 2]?.attachments : attached.map(({ name, rows, columns }) => ({ name, rows, columns }));
    const asked: ChatMessage[] = [
      {
        key: nextKey(),
        role: "user",
        content: question,
        ...(used ? { skill: used } : {}),
        ...(shownFiles?.length ? { attachments: shownFiles } : {}),
        at: new Date(startedAt).toISOString(),
      },
      { key: nextKey(), role: "assistant", content: "", steps: [], startedAt },
    ];
    setMessages((list) => [...(again ? list.slice(0, -2) : list), ...asked]);
    setStatus("thinking");
    let failed: string | null = null;
    let finished = false;
    // The text streamed on this turn of the model's; and whether what was streamed before a tool
    // call is shown as a thought until the server's own step replaces it.
    let streamed = "";
    let provisional = false;
    // The answer made changes: it stays, whatever happens next.
    let changed = false;
    try {
      const response = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          conversationId: conversationRef.current,
          message: question,
          scope: scopePageId ? { pageId: scopePageId } : null,
          mode: modeRef.current,
          ...(again ? { replaceLast: true } : {}),
          ...(used ? { skillId: used.id } : {}),
          timeZone: browserTimeZone(),
          ...(attached.length ? { attachments: attached.map(({ name, text }) => ({ name, text })) } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
        failed = errorText(body?.error?.code);
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as ChatEvent;
          if (event.type === "ping") continue;
          // Whatever comes after a change was asked about means it was decided (or timed out).
          setPending(event.type === "approval" ? { id: event.id, action: event.action } : null);
          if (event.type === "conversation") {
            conversationRef.current = event.id;
            setConversationId(event.id);
            callbacks.current.onConversation?.(event.id);
          } else if (event.type === "thinking") {
            setStatus("thinking");
            reasoning.set("");
          } else if (event.type === "reasoning") reasoning.set(reasoning.get() + event.text);
          else if (event.type === "step") {
            // The thinking that led to it is done.
            reasoning.set("");
            if (changedThings(event.step)) changed = true;
            const replaces = provisional && event.step.kind === "thought";
            provisional = false;
            updateLast((m) => {
              const steps = m.steps ?? [];
              return { ...m, steps: [...(replaces ? steps.slice(0, -1) : steps), event.step] };
            });
          } else if (event.type === "text") {
            setStatus("writing");
            streamed += event.text;
            reasoning.set("");
            updateLast((m) => ({ ...m, content: m.content + event.text }));
          } else if (event.type === "reset") {
            // What was streamed was the model thinking aloud before a tool call: it moves into the
            // steps at once (the server's thought step follows), and the tool runs meanwhile.
            setStatus("thinking");
            const thought = thoughtText(streamed);
            streamed = "";
            provisional = thought !== "";
            updateLast((m) => ({ ...m, content: "", ...(thought ? { steps: [...(m.steps ?? []), { kind: "thought" as const, text: thought }] } : {}) }));
          }
          else if (event.type === "sources") updateLast((m) => ({ ...m, sources: event.sources }));
          else if (event.type === "done") {
            finished = true;
            updateLast((m) => ({ ...m, ms: event.ms, at: new Date().toISOString(), ...(event.stopReason === "length" ? { note: "cutOff" as const } : {}) }));
          } else if (event.type === "error") {
            if (event.code === "aborted") updateLast((m) => ({ ...m, note: "stopped" }));
            else failed = errorText(event.code);
          }
        }
      }
      if (!finished && !failed && !controller.signal.aborted) failed = errorText("provider");
    } catch {
      if (controller.signal.aborted) updateLast((m) => ({ ...m, note: "stopped" }));
      else failed = errorText("provider");
    } finally {
      if (abort.current === controller) abort.current = null;
      setStatus(null);
      setPending(null);
      // Stopped or failed: the time it ran for, as the page saw it.
      reasoning.set("");
      updateLast((m) => (m.ms === undefined && m.startedAt ? { ...m, ms: Date.now() - m.startedAt } : m));
      if (failed) {
        setError(failed);
        // Nothing was answered: the question goes back into the box, unless it changed things; asked
        // again, the conversation stays as it was.
        setMessages((list) => {
          const last = list[list.length - 1];
          const answered = !(last?.role === "assistant" && !last.content.trim() && !changed);
          return answered ? list : again ? before : list.slice(0, -2);
        });
      }
      callbacks.current.onAnswered?.();
      // Answered: the next queued question is asked. Failed (the question first, unless it changed
      // things), or ended without an answer by the server: they are given back. Stopped here, Stop or
      // leaving the conversation took care of them.
      const next = queue.current[0];
      if (failed) giveBack(!changed && !again ? [{ question, skill: used, scopePageId, files: attached }] : []);
      else if (finished && next) {
        setQueue(queue.current.slice(1));
        void ask(next.question, next.skill, next.scopePageId, false, next.files);
      } else if (!finished && !controller.signal.aborted) giveBack();
    }
  }

  /** Stops the answer; the queued questions are given back. */
  function stop() {
    abort.current?.abort();
    giveBack();
  }

  /** Drops the queued questions. */
  function clearQueue() {
    setQueue([]);
  }

  /** Answers the change the model asks to make; "always" also makes the mode `auto`. */
  async function decide(decision: ChangeDecision) {
    if (!pending) return;
    const asked = pending;
    setPending(null);
    if (decision === "always") setMode("auto");
    const result = await decideChangeAction(asked.id, decision);
    // Not sent (offline, say): asked again. When it no longer waited, the stream says how it went.
    if (!result.ok) {
      setPending((current) => current ?? asked);
      setError(result.error);
    }
  }

  function newChat() {
    leave();
    setConversationId(null);
    setMessages([]);
    setError(null);
    setSkill(null);
    setFilesNow([]);
    inputRef.current?.focus();
  }

  /** Shows a saved conversation; false when it can't be loaded (gone, or not theirs). */
  async function openConversation(id: string) {
    leave();
    const result = await getConversationAction(workspaceId, id);
    if (!result.ok) {
      setError(t("loadFailed"));
      return false;
    }
    setError(null);
    setConversationId(result.data.id);
    setMessages(result.data.messages.map((m) => ({ ...m, key: nextKey() })));
    // Questions left waiting here come back.
    const left = parked.get(result.data.id);
    if (left) {
      parked.delete(result.data.id);
      giveBack(left);
    }
    return true;
  }

  /** Deletes a conversation (or all of them); the open one is replaced by a new chat. True when done. */
  async function remove(id: string | "all") {
    if (id === "all" && !confirm(t("confirmDeleteAll"))) return false;
    const result = await deleteConversationAction(workspaceId, id);
    if (!result.ok) return false;
    if (id === "all" || id === conversationId) {
      newChat();
      callbacks.current.onConversation?.(null);
    }
    if (id === "all") parked.clear();
    else parked.delete(id);
    return true;
  }

  return {
    workspaceId,
    skill,
    setSkill,
    queued,
    clearQueue,
    reasoning: reasoning as Reasoning,
    conversationId,
    messages,
    input,
    setInput,
    pastes: draft.pastes,
    pasteInput,
    files,
    attachFiles,
    removeFile,
    status,
    error,
    running,
    inputRef,
    mode,
    setMode,
    pending,
    decide,
    send,
    stop,
    newChat,
    openConversation,
    remove,
  };
}

export type Chat = ReturnType<typeof useChat>;
