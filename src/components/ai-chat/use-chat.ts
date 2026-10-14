"use client";

/**
 * One AI chat conversation as the panel and the full-page chat show it: its messages, the question
 * being typed, the streamed answer from `/api/ai/chat` (see server/ai-chat.ts) and what the model
 * is doing meanwhile. Stop cancels the answer; switching conversations or starting a new one does
 * too. The mode (what the chat may change) is remembered in the browser; in mode `ask` a change the
 * model wants to make waits, as `pending`, for the person's decision.
 */
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { decideChangeAction, deleteConversationAction, getConversationAction } from "@/app/actions/ai";
import { isAiErrorCode } from "@/lib/ai";
import { CHAT_MODES, type ChatActionView, type ChatEvent, type ChatMessageView, type ChatMode } from "@/lib/ai-chat";

/** What the model is doing while an answer is on its way: working on a turn, or writing. */
export type ChatStatus = "thinking" | "writing";

/** `startedAt`: when an answer being written was asked for (for its running time). */
export type ChatMessage = ChatMessageView & { key: string; startedAt?: number };

/** A change the model asks to make, waiting for the person's decision. */
export type PendingChange = { id: string; action: ChatActionView };

/** A skill picked for the next question: its instructions guide the answer (server/skills). */
export type ChatSkillPick = { id: string; title: string };

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
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<ChatStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setModeState] = useState<ChatMode>("ask");
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [skill, setSkill] = useState<ChatSkillPick | null>(null);
  const abort = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // The latest callbacks, without restarting anything when the caller passes new ones.
  const callbacks = useRef({ onConversation, onAnswered });
  callbacks.current = { onConversation, onAnswered };
  const running = status !== null;

  useEffect(() => () => abort.current?.abort(), []);
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

  /**
   * Asks the typed question with the picked skill, of the whole workspace or of `scopePageId` and
   * its subpages; with `again`, asks its question (the last one, maybe edited, with the skill it
   * used) in place of the last question and answer.
   */
  async function send(scopePageId: string | null, again?: { question: string; skill?: ChatSkillPick }) {
    const question = (again?.question ?? input).trim();
    if (!question || running) return;
    const used = again ? (again.skill ?? null) : skill;
    setError(null);
    if (!again) {
      setInput("");
      setSkill(null);
    }
    const controller = new AbortController();
    abort.current = controller;
    const startedAt = Date.now();
    const before = messages;
    const asked: ChatMessage[] = [
      { key: nextKey(), role: "user", content: question, ...(used ? { skill: used } : {}), at: new Date(startedAt).toISOString() },
      { key: nextKey(), role: "assistant", content: "", steps: [], startedAt },
    ];
    setMessages((list) => [...(again ? list.slice(0, -2) : list), ...asked]);
    setStatus("thinking");
    let failed: string | null = null;
    let finished = false;
    // The answer made changes: it stays, whatever happens next.
    let changed = false;
    try {
      const response = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          conversationId,
          message: question,
          scope: scopePageId ? { pageId: scopePageId } : null,
          mode,
          ...(again ? { replaceLast: true } : {}),
          ...(used ? { skillId: used.id } : {}),
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
            setConversationId(event.id);
            callbacks.current.onConversation?.(event.id);
          } else if (event.type === "thinking") setStatus("thinking");
          else if (event.type === "step") {
            if (event.step.kind === "write" && event.step.outcome === "done") changed = true;
            updateLast((m) => ({ ...m, steps: [...(m.steps ?? []), event.step] }));
          }
          else if (event.type === "text") {
            setStatus("writing");
            updateLast((m) => ({ ...m, content: m.content + event.text }));
          } else if (event.type === "reset") updateLast((m) => ({ ...m, content: "" }));
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
        if (!changed && !again) {
          setInput((current) => current || question);
          setSkill((current) => current ?? used);
        }
      }
      callbacks.current.onAnswered?.();
    }
  }

  function stop() {
    abort.current?.abort();
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
    stop();
    setConversationId(null);
    setMessages([]);
    setError(null);
    setSkill(null);
    inputRef.current?.focus();
  }

  /** Shows a saved conversation; false when it can't be loaded (gone, or not theirs). */
  async function openConversation(id: string) {
    stop();
    const result = await getConversationAction(workspaceId, id);
    if (!result.ok) {
      setError(t("loadFailed"));
      return false;
    }
    setError(null);
    setConversationId(result.data.id);
    setMessages(result.data.messages.map((m) => ({ ...m, key: nextKey() })));
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
    return true;
  }

  return {
    workspaceId,
    skill,
    setSkill,
    conversationId,
    messages,
    input,
    setInput,
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
