import { CURSOR_FIELD, PRESENCE_FIELD, userColor, type Presence } from "@/lib/presence";

/**
 * Rewrites the presence and the cursor label in awareness states coming from a connection to the
 * identity it signed in with: the browser's own name, picture and color never reach the others (a
 * cursor label's color goes into their page's styles). A state without either keeps none; without
 * a signed-in user both are dropped.
 */
export function stampPresence(
  states: Map<number, Record<string, unknown>>,
  signedIn: { userId?: string; userName?: string; userImage?: string | null } | undefined,
) {
  for (const state of states.values()) {
    if (!state) continue;
    if (state[PRESENCE_FIELD] != null) {
      if (signedIn?.userId) {
        state[PRESENCE_FIELD] = {
          id: signedIn.userId,
          name: signedIn.userName ?? "",
          ...(signedIn.userImage ? { image: signedIn.userImage } : {}),
        } satisfies Presence;
      } else delete state[PRESENCE_FIELD];
    }
    if (state[CURSOR_FIELD] != null) {
      if (signedIn?.userId) {
        state[CURSOR_FIELD] = { name: signedIn.userName ?? "", color: userColor(signedIn.userId) };
      } else delete state[CURSOR_FIELD];
    }
  }
}
