import { env } from "@/lib/env";
import { callSlack, SlackApiError } from "./api";
import { handleEnvelope } from "./events";
import { slackIdentity } from "./links";

/**
 * Starts the Slack bot when SLACK_APP_TOKEN and SLACK_BOT_TOKEN are set (the chat-app bot,
 * server/chat-apps, over transport.ts), through Socket Mode: the server asks Slack for a websocket
 * address (apps.connections.open) and reads events from it, so it needs no public address. Each
 * envelope is acknowledged at once by its id, then handled on its own, so a button pressed while an
 * answer is written is handled at once. Slack asks for a new connection now and then
 * (`disconnect`); a dropped one is opened again with a growing wait. The address carries a ticket:
 * it is never logged.
 */

/** Events Slack may send twice (after a reconnect): the latest ids seen. */
const seen = new Set<string>();
const MAX_SEEN = 1_000;
/** Envelopes being handled: flushSlack waits for them. */
const working = new Set<Promise<void>>();
/** A connection that heard nothing for this long is opened anew (a link that died without closing). */
const SILENT_MS = 60 * 60_000;

/** Scripts and tests: waits for the envelopes being handled. */
export async function flushSlack() {
  while (working.size) await Promise.allSettled([...working]);
}

type Envelope = { type?: string; envelope_id?: string; payload?: { event_id?: string } & Record<string, unknown>; reason?: string };

/** Starts the bot; `stop` closes it (scripts). Null when Slack isn't set up. */
export function startSlack(): { stop: () => void } | null {
  if (!env.slackAppToken || !env.slackBotToken) {
    console.log("slack: off (SLACK_APP_TOKEN, SLACK_BOT_TOKEN)");
    return null;
  }
  const stopping = new AbortController();
  void run(stopping.signal);
  return { stop: () => stopping.abort() };
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

async function run(signal: AbortSignal) {
  try {
    console.log(`slack: on as @${(await slackIdentity()).name}`);
  } catch (error) {
    if (error instanceof SlackApiError && error.kind === "unauthorized") {
      console.error("slack: the bot token was refused; check SLACK_BOT_TOKEN");
      return;
    }
    console.error("slack: couldn't reach Slack yet, retrying", error instanceof Error ? error.message : error);
  }
  let failures = 0;
  while (!signal.aborted) {
    let url: string;
    try {
      url = (await callSlack<{ url: string }>("apps.connections.open", {}, "app")).url;
    } catch (error) {
      if (error instanceof SlackApiError && error.kind === "unauthorized") {
        console.error("slack: the app token was refused; check SLACK_APP_TOKEN (connections:write) and that Socket Mode is on");
        return;
      }
      failures += 1;
      if (failures === 1 || failures % 20 === 0) console.error(`slack: couldn't open Socket Mode (${error instanceof Error ? error.message : "error"}), retrying`);
      await wait(Math.min(60_000, 1_000 * 2 ** Math.min(failures, 6)), signal);
      continue;
    }
    const { greeted, again } = await connect(url, signal);
    if (again === "never") return;
    failures = greeted ? 0 : failures + 1;
    if (!greeted && (failures === 1 || failures % 20 === 0)) console.error("slack: the Socket Mode connection closed before it opened, retrying");
    if (again === "later") await wait(Math.min(60_000, 1_000 * 2 ** Math.min(failures, 6)), signal);
  }
}

/**
 * One Socket Mode connection, until it closes: whether Slack greeted it (`hello`), and when to open
 * the next one (at once when Slack asked for it, never when Socket Mode was turned off).
 */
function connect(url: string, signal: AbortSignal): Promise<{ greeted: boolean; again: "now" | "later" | "never" }> {
  return new Promise((resolve) => {
    let greeted = false;
    let again: "now" | "later" | "never" = "later";
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      return resolve({ greeted, again });
    }
    let silent: ReturnType<typeof setTimeout> | undefined;
    const heard = () => {
      clearTimeout(silent);
      silent = setTimeout(() => socket.close(), SILENT_MS);
      silent.unref?.();
    };
    const stop = () => socket.close();
    signal.addEventListener("abort", stop, { once: true });
    socket.addEventListener("open", heard);
    socket.addEventListener("message", (message) => {
      heard();
      let envelope: Envelope;
      try {
        envelope = JSON.parse(typeof message.data === "string" ? message.data : "") as Envelope;
      } catch {
        return;
      }
      if (envelope.type === "hello") {
        greeted = true;
        return;
      }
      if (envelope.type === "disconnect") {
        if (envelope.reason === "link_disabled") {
          console.error("slack: Socket Mode was turned off for the app; turn it on and restart the server");
          again = "never";
        } else again = "now";
        socket.close();
        return;
      }
      if (!envelope.envelope_id || !envelope.type) return;
      // Acknowledged first: Slack sends again what isn't acknowledged within three seconds.
      socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
      const eventId = envelope.payload?.event_id;
      if (eventId) {
        if (seen.has(eventId)) return;
        seen.add(eventId);
        if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value!);
      }
      const work = handleEnvelope(envelope.type, envelope.payload);
      working.add(work);
      void work.finally(() => working.delete(work));
    });
    socket.addEventListener("close", () => {
      clearTimeout(silent);
      signal.removeEventListener("abort", stop);
      resolve({ greeted, again: signal.aborted ? "never" : again });
    });
    // An error is followed by close.
    socket.addEventListener("error", () => {});
  });
}
