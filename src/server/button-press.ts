import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Whether the work running now is a button on a page doing what it does (server/buttons.ts): its
 * writes are the clicker's own, and a row's activity says they came through a button. Apart from
 * buttons.ts so that row activity can ask without importing what a button does.
 */
const pressing = new AsyncLocalStorage<true>();

export const pressingButton = () => pressing.getStore() === true;

export function runAsButton<T>(fn: () => Promise<T>): Promise<T> {
  return pressing.run(true, fn);
}
