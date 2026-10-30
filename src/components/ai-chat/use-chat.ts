"use client";

/**
 * One AI chat conversation as the panel and the full-page chat show it: its messages, the question
 * being typed, the streamed answer from `/api/ai/chat` (see server/ai-chat.ts) and what the model
 * is doing meanwhile. A question asked while an answer is on its way waits in a queue and is asked
 * once that answer is done. The answer runs on the server apart from the page (server/ai-chat-runs.ts):
 * switching conversations, starting a new one, reloading or closing the page leaves it going on and
 * saved, and opening its conversation again (here or in another tab) follows it from its start, a
 * change waiting for approval included. Stop stops it on the server and gives the queued questions
 * back: the first into an empty box, the rest still queued to follow it. A conversation left
 * mid-answer keeps its queued questions for when it's opened again in this tab. The mode (what the chat may change) is remembered in the browser; in mode `ask` a change
 * the model wants to make waits, as `pending`, for the person's decision. A long paste shows in the
 * box as a label (lib/chat-paste.ts) and is sent in its place. Files attached to a question
 * (lib/chat-attachments.ts) are uploaded as they are attached (/api/ai/chat/files), shown as chips,
 * and sent with it by their ids. Where the workspace's AI offers several models, the question goes
 * to the one picked (the conversation's, or for a new one the person's latest), thinking as much as
 * picked (kept the same way); research mode asks
 * for a long cited report instead of an answer, and only reads.
 */
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { decideChangeAction, deleteConversationAction, saveReportAsPageAction, stopChatAction } from "@/app/actions/ai";
import { read } from "@/components/read";
import { isAiErrorCode } from "@/lib/ai";
import { aiAsSuggestions, setAiAsSuggestions } from "@/lib/ai-suggestions";
import { CHAT_MODES, type ChatActionView, type ChatMessageView, type ChatMode, type ChatOptions, type ChatScopeView, type ChatThinking } from "@/lib/ai-chat";
import {
  CHAT_CSV_MAX_COLUMNS,
  CHAT_CSV_MAX_ROWS,
  CHAT_FILE_LIMITS,
  chatFileKind,
  type AttachmentProblem,
  type ChatAttachmentView,
} from "@/lib/chat-attachments";
import { formatBytes } from "@/lib/files";
import { EMPTY_DRAFT, expandDraft, insertPaste, pasteLineCount, syncDraft, uniqueLabel, type ChatDraft } from "@/lib/chat-paste";
import { browserTimeZone } from "@/lib/time-zone";
import { holdAnswering } from "./answering";
import type { AnswerState } from "./chat-answer";

/** What the model is doing while an answer is on its way: working on a turn, or writing. */
export type ChatStatus = "thinking" | "writing";

/** `startedAt`: when an answer being written was asked for (for its running time). */
export type ChatMessage = ChatMessageView & { key: string; startedAt?: number };

/** A change the model asks to make, waiting for the person's decision. */
export type PendingChange = { id: string; action: ChatActionView };

/** A skill picked for the next question: its instructions guide the answer (server/skills). */
export type ChatSkillPick = { id: string; title: string };

/** A file attached to the question being typed: uploaded, or on its way (`uploading`, a stand-in id). */
export type ChatFile = ChatAttachmentView & { uploading?: boolean };

/** Uploads a file for a chat question; the file as shown, or why it wasn't taken. */
async function uploadFile(workspaceId: string, file: File): Promise<{ ok: true; file: ChatAttachmentView } | { ok: false; code?: string; problem?: AttachmentProblem; limit?: number }> {
  try {
    const response = await fetch(`/api/ai/chat/files?workspaceId=${encodeURIComponent(workspaceId)}`, {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) },
      body: file,
    });
    const body = (await response.json().catch(() => null)) as (ChatAttachmentView & { code?: string; problem?: AttachmentProblem; limit?: number }) | null;
    if (response.ok && body?.id) return { ok: true, file: body };
    return { ok: false, code: body?.code, problem: body?.problem, limit: body?.limit };
  } catch {
    return { ok: false };
  }
}

let uploads = 0;

/** A question asked while an answer was on its way, waiting to be asked. */
export type QueuedQuestion = { question: string; skill: ChatSkillPick | null; scope: ChatScopeView | null; files: ChatFile[]; research: boolean };

/** Without options from the server (the full page outside the provider): one model, no picker. */
const NO_OPTIONS: ChatOptions = { models: [], defaultModel: null, defaultThinking: "balanced", webSearch: false };

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

/** An id for an answer, so Stop can name it from the start (crypto.randomUUID needs HTTPS). */
function newRunId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Why an answer's request is closed when the page leaves it: it goes on without the page. */
const DETACHED = "detached";
/** How long Stop waits for the server to end the answer before leaving it all the same. */
const STOP_WAIT_MS = 5_000;

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
    options = NO_OPTIONS,
    onConversation,
    onAnswered,
  }: {
    /** What the box offers: the models, the one a new conversation starts with (chatOptionsFor). */
    options?: ChatOptions;
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
  // What it writes in page bodies goes in as suggested edits: the person's choice (lib/ai-suggestions).
  const [asSuggestions, setAsSuggestionsState] = useState(false);
  useEffect(() => setAsSuggestionsState(aiAsSuggestions()), []);
  const asSuggestionsRef = useRef(asSuggestions);
  asSuggestionsRef.current = asSuggestions;
  const setAsSuggestions = useCallback((on: boolean) => {
    setAsSuggestionsState(on);
    setAiAsSuggestions(on);
  }, []);
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [skill, setSkill] = useState<ChatSkillPick | null>(null);
  const [files, setFiles] = useState<ChatFile[]>([]);
  // The model questions go to (null: the workspace's main one), and research mode.
  const [model, setModel] = useState<string | null>(options.defaultModel);
  const [research, setResearch] = useState(false);
  const modelNow = useRef(model);
  modelNow.current = model;
  // How much the model thinks, kept with the conversation like the model.
  const [thinking, setThinking] = useState<ChatThinking>(options.defaultThinking);
  const thinkingNow = useRef(thinking);
  thinkingNow.current = thinking;
  /** Whether the model picked (or the only one) takes images. */
  const takesImages = (id: string | null) => (options.models.find((m) => m.id === id) ?? options.models[0])?.images ?? false;
  const filesNow = useRef(files);
  filesNow.current = files;
  const [queued, setQueued] = useState<QueuedQuestion[]>([]);
  const [reasoning] = useState(reasoningStore);
  const abort = useRef<AbortController | null>(null);
  // The answer shown (its run id), and the one Stop was pressed for.
  const runNow = useRef<string | null>(null);
  const stopping = useRef<AbortController | null>(null);
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
   * Attaches files to the question being typed, each uploaded at once (a chip shows it meanwhile);
   * one that can't be attached says why (the others still are).
   */
  const attachFiles = async (list: readonly File[]) => {
    const problem = (p: AttachmentProblem, limit?: number) =>
      p === "tooManyRows"
        ? t("files.tooManyRows", { rows: CHAT_CSV_MAX_ROWS })
        : p === "tooManyColumns"
          ? t("files.tooManyColumns", { columns: CHAT_CSV_MAX_COLUMNS })
          : p === "tooLarge"
            ? t("files.tooLarge", { size: formatBytes(limit ?? CHAT_FILE_LIMITS.bytes) })
            : t("files.empty");
    let failed: string | null = null;
    const taken: File[] = [];
    for (const file of list) {
      if (filesNow.current.length + taken.length >= CHAT_FILE_LIMITS.perQuestion) {
        failed = t("files.tooMany", { count: CHAT_FILE_LIMITS.perQuestion });
        break;
      }
      const kind = chatFileKind(file.type, file.name);
      if (!kind) {
        failed = t("files.notSupported");
        continue;
      }
      if (kind === "image" && !takesImages(modelNow.current)) {
        failed = t("files.noImages");
        continue;
      }
      // Sizes first: a file far too large isn't sent at all.
      const limit = kind === "image" ? CHAT_FILE_LIMITS.imageBytes : CHAT_FILE_LIMITS.bytes;
      if (file.size > limit) {
        failed = problem("tooLarge", limit);
        continue;
      }
      taken.push(file);
    }
    setError(failed);
    await Promise.all(
      taken.map(async (file) => {
        const id = `uploading-${++uploads}`;
        const shown: ChatFile = { id, name: file.name, contentType: file.type, size: file.size, url: "", uploading: true };
        setFilesNow([...filesNow.current, shown]);
        const result = await uploadFile(workspaceId, file);
        // Taken off while it was on its way: it stays off (the upload goes with the day-old ones).
        if (!filesNow.current.some((f) => f.id === id)) return;
        if (result.ok) {
          setFilesNow(filesNow.current.map((f) => (f.id === id ? result.file : f)));
          return;
        }
        setFilesNow(filesNow.current.filter((f) => f.id !== id));
        setError(
          result.problem
            ? problem(result.problem, result.limit)
            : result.code === "tooLarge"
              ? problem("tooLarge", result.limit)
              : result.code === "quotaExceeded"
                ? t("files.quota")
                : result.code === "badRequest"
                  ? t("files.notSupported")
                  : t("files.failed", { name: file.name }),
        );
      }),
    );
  };
  const removeFile = (id: string) => {
    filesNow.current = filesNow.current.filter((f) => f.id !== id);
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

  // Unmounted mid-answer (the workspace left: the chat is held beside its pages, chat-panel.tsx):
  // the answer goes on without it, its queue is parked.
  useEffect(
    () => () => {
      abort.current?.abort(DETACHED);
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
    setResearch(toBox.research);
  };

  /**
   * Leaves the conversation, its queued questions parked for its return; an answer on its way goes
   * on without the page (the list marks it, opening the conversation follows it again).
   */
  const leave = () => {
    const leaving = abort.current;
    if (leaving) {
      leaving.abort(DETACHED);
      abort.current = null;
      runNow.current = null;
      setStatus(null);
      setPending(null);
      reasoning.set("");
      callbacks.current.onAnswered?.();
    }
    park(conversationRef.current, queue.current);
    setQueue([]);
  };

  /**
   * Asks the typed question with the picked skill, of the whole workspace or of `scope` (a page and
   * its subpages, or a teamspace); with `again`, asks its question (the last one, maybe edited, with the skill it
   * used) in place of the last question and answer. While an answer is on its way, the typed
   * question is queued instead.
   */
  async function send(scope: ChatScopeView | null, again?: { question: string; skill?: ChatSkillPick }) {
    const question = (again?.question ?? expandDraft(draft)).trim();
    const attached = again ? [] : filesNow.current;
    if (!question && !attached.length) return;
    // A file still on its way: the question waits for it (the box says so).
    if (attached.some((f) => f.uploading)) return;
    // The model was changed after an image was attached.
    if (attached.some((f) => f.contentType.startsWith("image/")) && !takesImages(modelNow.current)) {
      setError(t("files.noImages"));
      return;
    }
    if (running) {
      if (again) return;
      setQueue([...queue.current, { question, skill, scope, files: attached, research }]);
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
    await ask(question, again ? (again.skill ?? null) : skill, scope, Boolean(again), attached, again ? Boolean(messages[messages.length - 2]?.research) : research);
  }

  async function ask(question: string, used: ChatSkillPick | null, scope: ChatScopeView | null, again: boolean, attached: ChatFile[] = [], researching = false) {
    const runId = newRunId();
    const startedAt = Date.now();
    const before = messages;
    // Asked again, a question keeps the files it had (the server keeps them too).
    const shownFiles = again ? messages[messages.length - 2]?.attachments : attached;
    const asked: ChatMessage[] = [
      {
        key: nextKey(),
        role: "user",
        content: question,
        ...(used ? { skill: used } : {}),
        ...(scope ? { scope } : {}),
        ...(shownFiles?.length ? { attachments: shownFiles } : {}),
        ...(researching ? { research: true } : {}),
        at: new Date(startedAt).toISOString(),
      },
      { key: nextKey(), role: "assistant", content: "", steps: [], startedAt, ...(researching ? { research: true } : {}) },
    ];
    setMessages((list) => [...(again ? list.slice(0, -2) : list), ...asked]);
    await answer({
      runId,
      question: { question, skill: used, scope, files: attached, research: researching },
      again,
      before,
      open: (signal) =>
        fetch("/api/ai/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            runId,
            workspaceId,
            conversationId: conversationRef.current,
            message: question,
            scope: !scope ? null : scope.kind === "page" ? { pageId: scope.id } : { teamspaceId: scope.id },
            mode: modeRef.current,
            ...(again ? { replaceLast: true } : {}),
            ...(used ? { skillId: used.id } : {}),
            timeZone: browserTimeZone(),
            ...(asSuggestionsRef.current ? { asSuggestions: true } : {}),
            ...(attached.length ? { attachments: attached.map((f) => f.id) } : {}),
            // Only where there is a choice: otherwise the workspace's model answers.
            ...(options.models.length > 1 && modelNow.current ? { model: modelNow.current } : {}),
            thinking: thinkingNow.current,
            ...(researching ? { research: true } : {}),
          }),
          signal,
        }),
    });
  }

  /**
   * Follows an answer on its way in the conversation just opened (`saved`, its messages without
   * it): asked before the page was reloaded, or in another tab. Its question and what it has
   * written so far come first (its `conversation` event), then the rest as it comes.
   */
  async function follow(runId: string, saved: ChatMessage[]) {
    await answer({
      runId,
      question: null,
      again: false,
      before: saved,
      open: (signal) => fetch(`/api/ai/chat?run=${encodeURIComponent(runId)}`, { headers: { "x-leafdesk-chat": "1" }, signal }),
    });
  }

  /**
   * Shows an answer as its events come (`open` asks for them); `question`: the one asked here (null
   * when following one asked before: its `conversation` event brings it), given back when the
   * answer fails; `before`: the conversation as it was, for a question asked again that failed.
   */
  async function answer({
    runId,
    question: typed,
    again: asking,
    before,
    open,
  }: {
    runId: string;
    question: QueuedQuestion | null;
    again: boolean;
    before: ChatMessage[];
    open: (signal: AbortSignal) => Promise<Response>;
  }) {
    setError(null);
    const controller = new AbortController();
    abort.current = controller;
    runNow.current = runId;
    const following = !typed;
    setStatus("thinking");
    // Failed: what the box says.
    let failed: string | null = null;
    const state: AnswerState = { question: typed, again: asking, finished: false, stopped: false, changed: false, error: null };
    // Gone when followed (it ended a while ago): the conversation has it now.
    let gone = false;
    const detached = () => controller.signal.reason === DETACHED;
    try {
      const [response, { readAnswer }] = await Promise.all([open(controller.signal), import("./chat-answer")]);
      if (following && response.status === 404) {
        gone = true;
        return;
      }
      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
        failed = body?.error?.code === "busy" ? t("errors.busy") : errorText(body?.error?.code);
        return;
      }
      await readAnswer(response.body, state, {
        following,
        conversation: (id) => {
          conversationRef.current = id;
          setConversationId(id);
          callbacks.current.onConversation?.(id);
        },
        setPending,
        setStatus,
        reasoning,
        setMessages,
        updateLast,
        nextKey,
      });
      if (state.error) failed = errorText(state.error);
      else if (!state.finished && !state.stopped && !controller.signal.aborted) failed = errorText("provider");
    } catch {
      if (detached()) {
        // Left for another conversation: the answer goes on without this page.
      } else if (controller.signal.aborted) updateLast((m) => ({ ...m, note: "stopped" }));
      else failed = errorText("provider");
    } finally {
      if (abort.current === controller) {
        abort.current = null;
        runNow.current = null;
      }
      // Left: the conversation shown now isn't this one (leave() tidied up).
      if (!detached()) {
        const { question, again, changed, finished } = state;
        setStatus(null);
        setPending(null);
        // Stopped or failed: the time it ran for, as the page saw it.
        reasoning.set("");
        updateLast((m) => (m.ms === undefined && m.startedAt ? { ...m, ms: Date.now() - m.startedAt } : m));
        if (gone) await showSaved();
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
        // things), or ended without an answer by the server: they are given back. Stopped here, Stop
        // took care of them.
        const stoppedHere = stopping.current === controller || controller.signal.aborted;
        const next = queue.current[0];
        if (failed) giveBack(!changed && !again && question ? [question] : []);
        else if (finished && next) {
          setQueue(queue.current.slice(1));
          void ask(next.question, next.skill, next.scope, false, next.files, next.research);
        } else if (!finished && !stoppedHere && !gone) giveBack();
      }
    }
  }

  /** The open conversation as saved (an answer followed again had ended meanwhile). */
  async function showSaved() {
    const id = conversationRef.current;
    if (!id) return;
    const result = await read("chatConversation", workspaceId, id);
    if (result.ok && conversationRef.current === id) setMessages(result.data.messages.map((m) => ({ ...m, key: nextKey() })));
  }

  /**
   * Stops the answer (on the server: closing the page wouldn't); the queued questions are given
   * back. The answer ends with what it wrote so far; if the server can't be told, it is left here.
   */
  function stop() {
    const controller = abort.current;
    const runId = runNow.current;
    if (!controller || !runId) return;
    stopping.current = controller;
    giveBack();
    const leaveIt = () => controller.abort();
    void stopChatAction(runId).then((result) => {
      if (!result.ok) leaveIt();
    }, leaveIt);
    // The server's end of it doesn't come (the connection is stuck): it is left all the same.
    setTimeout(leaveIt, STOP_WAIT_MS);
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
    const result = await read("chatConversation", workspaceId, id);
    if (!result.ok) {
      setError(t("loadFailed"));
      return false;
    }
    setError(null);
    conversationRef.current = result.data.id;
    setConversationId(result.data.id);
    const saved = result.data.messages.map((m) => ({ ...m, key: nextKey() }));
    setMessages(saved);
    // The conversation goes on with its model, when it is still offered.
    if (result.data.model && options.models.some((m) => m.id === result.data.model)) setModel(result.data.model);
    setThinking(result.data.thinking);
    // Questions left waiting here come back.
    const left = parked.get(result.data.id);
    if (left) {
      parked.delete(result.data.id);
      giveBack(left);
    }
    // An answer on its way there (asked before a reload, or in another tab) is followed again.
    if (result.data.run) void follow(result.data.run, saved);
    return true;
  }

  /** Saves the research report at `index` of the open conversation as a private page; its id, or null (the error is shown). */
  async function saveReport(index: number): Promise<string | null> {
    if (!conversationId) return null;
    const result = await saveReportAsPageAction(workspaceId, conversationId, index);
    if (!result.ok) {
      setError(t("research.saveFailed"));
      return null;
    }
    return result.data.pageId;
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
    options,
    model,
    setModel,
    thinking,
    setThinking,
    research,
    setResearch,
    saveReport,
    status,
    error,
    running,
    inputRef,
    mode,
    setMode,
    asSuggestions,
    setAsSuggestions,
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
