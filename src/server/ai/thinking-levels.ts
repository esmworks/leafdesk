import type { ChatThinking } from "@/lib/ai-chat";
import type { AiRequest } from "./index";

/**
 * What each thinking choice (the AI chat's, an agent's) asks of the AI layer: `fast` as little
 * thinking as the model allows, `balanced` the feature's own (features.ts: the chat's, or an
 * agent's as it always was), `deep` the model's own default.
 */
export const THINKING_LEVELS: Record<ChatThinking, AiRequest["thinking"]> = { fast: "off", balanced: undefined, deep: "model" };
