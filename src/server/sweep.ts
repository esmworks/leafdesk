/**
 * Server only: runs `work` now and every `everyMs` after, one run at a time (a run still going when
 * the next one is due makes that one skip). A run that throws is logged with `failure` and the next
 * one goes ahead. Returns a function that stops it.
 */
export function startSweep(everyMs: number, work: () => Promise<unknown>, failure: string) {
  let sweeping = false;
  const sweep = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      await work();
    } catch (error) {
      console.error(failure, error);
    } finally {
      sweeping = false;
    }
  };
  void sweep();
  const timer = setInterval(() => void sweep(), everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
