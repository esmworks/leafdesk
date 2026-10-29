/**
 * A person's own AI provider accounts (server/ai-accounts.ts), shared by the server and the
 * settings forms. Only hosted providers and OpenAI-compatible servers at a URL: a local provider's
 * default address would be the server's own machine, not the person's.
 */

export const OWN_AI_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "xai",
  "moonshotai",
  "minimax",
  "zai",
  "opencode-go",
  "openai-compatible",
] as const;
export type OwnAiProvider = (typeof OWN_AI_PROVIDERS)[number];
export const isOwnAiProvider = (value: unknown): value is OwnAiProvider =>
  typeof value === "string" && (OWN_AI_PROVIDERS as readonly string[]).includes(value);

/** A model id each hosted provider knows, shown in the empty Model field as an example. */
export const MODEL_EXAMPLES: Partial<Record<OwnAiProvider, string>> = {
  anthropic: "claude-sonnet-5-5",
  openai: "gpt-5.5",
  google: "gemini-3.5-flash",
  openrouter: "anthropic/claude-sonnet-5.5",
  xai: "grok-4.7",
  moonshotai: "kimi-k3",
  minimax: "MiniMax-M3",
  zai: "glm-5.3",
  "opencode-go": "kimi-k3",
};

/** Providers with an OpenAI-compatible embeddings endpoint an account's key also opens. */
export const EMBEDDING_PROVIDERS: readonly OwnAiProvider[] = ["openai", "google", "openai-compatible"];
/** Providers with an OpenAI-compatible transcription endpoint an account's key also opens. */
export const STT_PROVIDERS: readonly OwnAiProvider[] = ["openai", "openai-compatible"];

export const AI_ACCOUNT_STATUSES = ["active", "broken"] as const;
export type AiAccountStatus = (typeof AI_ACCOUNT_STATUSES)[number];

export const MAX_AI_ACCOUNT_LABEL = 80;
export const MAX_AI_MODEL = 200;
export const MAX_AI_KEY = 1_000;
export const MAX_AI_BASE_URL = 500;
/** Accounts one person may keep. */
export const MAX_AI_ACCOUNTS = 20;

/** An account as its owner's settings show it: never the key, only its last characters. */
export type AiAccountView = {
  id: string;
  label: string;
  provider: OwnAiProvider;
  model: string;
  baseUrl: string | null;
  embeddingsModel: string | null;
  sttModel: string | null;
  keyHint: string | null;
  isDefault: boolean;
  status: AiAccountStatus;
  lastError: string | null;
  verifiedAt: string;
  /** Workspaces whose AI runs on it. */
  workspaces: { id: string; name: string }[];
};

/** What adding or changing an account takes; a change without `apiKey` keeps the saved key. */
export type AiAccountInput = {
  label?: string;
  provider: OwnAiProvider;
  model: string;
  baseUrl?: string | null;
  apiKey?: string | null;
  embeddingsModel?: string | null;
  sttModel?: string | null;
};

/** Where a workspace's AI comes from, for its settings. */
export type WorkspaceAiSource =
  | { kind: "account"; accountId: string; label: string; provider: string; model: string; ownerId: string; ownerName: string; mine: boolean }
  | { kind: "instance" }
  | { kind: "off" };

/** The last characters of a key, for telling keys apart without showing them. */
export const keyHint = (key: string) => (key.length > 8 ? key.slice(-4) : null);

export type WorkspaceAiView = {
  source: WorkspaceAiSource;
  /** The viewer's own accounts they may attach (owners only; empty otherwise). */
  mine: { id: string; label: string; provider: string; model: string; status: "active" | "broken" }[];
  /** Whether the viewer may change it: owners attach their own accounts and take any off. */
  canChange: boolean;
  /** The server's AI is kept from workspaces (AI_ONLY_OWN_KEYS): without an account, AI is off. */
  onlyOwnKeys: boolean;
  /** Whether a workspace without an account runs on the server's AI (else AI is off there). */
  serverAi: boolean;
};
