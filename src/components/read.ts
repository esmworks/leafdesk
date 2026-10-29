import type { Reads } from "@/app/api/read/reads";
import { decodeRead, encodeRead } from "@/lib/read-wire";

type Result<K extends keyof Reads> = Awaited<ReturnType<Reads[K]>>;

/**
 * Calls one of the reads in app/api/read/reads.ts, as its server action would be called but beside
 * other requests instead of queued behind the tab's server actions. Rejects as the action would.
 */
export function read<K extends keyof Reads>(name: K, ...args: Parameters<Reads[K]>): Promise<Result<K>> {
  return readWith(undefined, name, ...args);
}

/** `read`, cancelled with `signal` (a search box dropping the answer to what was typed before). */
export async function readWith<K extends keyof Reads>(signal: AbortSignal | undefined, name: K, ...args: Parameters<Reads[K]>): Promise<Result<K>> {
  const response = await fetch(`/api/read/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: encodeRead(args),
    signal,
  });
  if (!response.ok) throw new Error(`read ${name}: ${response.status}`);
  return decodeRead(await response.text()) as Result<K>;
}
