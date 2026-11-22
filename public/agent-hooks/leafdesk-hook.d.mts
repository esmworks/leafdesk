// Types of leafdesk-hook.mjs, for its tests (src/lib/agent-hook.test.ts).
export declare const TIMEOUT_MS: number;
export declare const START_CHARS: number;
export declare const PROMPT_CHARS: number;
export declare const MIN_PROMPT_CHARS: number;
export type HookSettings = { url: string; token: string; workspace: string | null; pages: boolean };
export declare function startContext(memory: unknown, max?: number): string | null;
export declare function promptContext(found: unknown, search: unknown, max?: number): string | null;
export declare function hookOutput(event: string, context: string): string;
export declare function settingsFrom(env: Record<string, string | undefined>): HookSettings | null;
export declare function answer(input: unknown, settings: HookSettings, fetchImpl?: typeof fetch): Promise<string | null>;
