/**
 * Reads an AI chat answer's newline-delimited events (`/api/ai/chat`, see ChatEvent in
 * lib/ai-chat.ts) into the chat as they come: use-chat.ts loads it with the first answer, so it
 * stays out of every workspace page's first load.
 */
import { changedThings, thoughtText, type ChatEvent } from "@/lib/ai-chat";
import type { ChatMessage, ChatStatus, PendingChange, QueuedQuestion } from "./use-chat";

/** What the answer came to so far; kept by the caller, also when reading it fails midway. */
export type AnswerState = {
  /** The question (null until a followed answer's `conversation` event brings it), and whether it replaces the last one. */
  question: QueuedQuestion | null;
  again: boolean;
  finished: boolean;
  /** Stopped: by Stop (here or in another tab), or its conversation deleted meanwhile. */
  stopped: boolean;
  /** The answer made changes: it stays, whatever happens next. */
  changed: boolean;
  /** The error code it ended with. */
  error: string | null;
};

export type AnswerView = {
  /** Followed again (asked before a reload, or in another tab): its question comes with its first event. */
  following: boolean;
  conversation: (id: string) => void;
  setPending: (pending: PendingChange | null) => void;
  setStatus: (status: ChatStatus) => void;
  reasoning: { get(): string; set(text: string): void };
  setMessages: (fn: (list: ChatMessage[]) => ChatMessage[]) => void;
  updateLast: (fn: (m: ChatMessage) => ChatMessage) => void;
  nextKey: () => string;
};

export async function readAnswer(body: ReadableStream<Uint8Array>, state: AnswerState, view: AnswerView) {
  const { setPending, setStatus, reasoning, setMessages, updateLast, nextKey } = view;
  // The text streamed on this turn of the model's; and whether what was streamed before a tool
  // call is shown as a thought until the server's own step replaces it.
  let streamed = "";
  let provisional = false;
  const reader = body.getReader();
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
        view.conversation(event.id);
        const shown = event.question;
        if (view.following && shown) {
          // Followed again: the question as it was asked, and an answer to come.
          const again = Boolean(event.replaceLast);
          state.again = again;
          state.question = { question: shown.content, skill: shown.skill ?? null, scope: shown.scope ?? null, files: shown.attachments ?? [], research: Boolean(shown.research) };
          const asked: ChatMessage[] = [
            { ...shown, key: nextKey() },
            { key: nextKey(), role: "assistant", content: "", steps: [], startedAt: event.startedAt ?? Date.now(), ...(shown.research ? { research: true } : {}) },
          ];
          setMessages((list) => [...(again ? list.slice(0, -2) : list), ...asked]);
        } else {
          // The scope's title as the server read it (the panel knows the open page only by its id).
          const scoped = event.scope;
          if (scoped) setMessages((list) => list.map((m, i) => (i === list.length - 2 && m.role === "user" ? { ...m, scope: scoped } : m)));
        }
      } else if (event.type === "thinking") {
        setStatus("thinking");
        reasoning.set("");
      } else if (event.type === "reasoning") reasoning.set(reasoning.get() + event.text);
      else if (event.type === "step") {
        // The thinking that led to it is done.
        reasoning.set("");
        if (changedThings(event.step)) state.changed = true;
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
      } else if (event.type === "sources") updateLast((m) => ({ ...m, sources: event.sources }));
      else if (event.type === "done") {
        state.finished = true;
        updateLast((m) => ({ ...m, ms: event.ms, at: new Date().toISOString(), ...(event.stopReason === "length" ? { note: "cutOff" as const } : {}) }));
      } else if (event.type === "error") {
        if (event.code === "aborted") {
          state.stopped = true;
          updateLast((m) => ({ ...m, note: "stopped" }));
        } else state.error = event.code;
      }
    }
  }
}
