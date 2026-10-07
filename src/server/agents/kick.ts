/** Wakes the agents' worker (server/agents/run), once it runs in this process. Apart from it, so modules it uses can wake it too. */
type State = { kick?: () => void };
const g = globalThis as typeof globalThis & { __leafdeskAgents?: State };
export const agentsWorker: State = (g.__leafdeskAgents ??= {});

export function kickAgents() {
  agentsWorker.kick?.();
}
