/**
 * Debounce plus a floor: collapse a burst of calls into one run, and never
 * start runs closer together than `minIntervalMs`. The last call in a burst
 * always gets a run (trailing edge), so nothing that happened is dropped.
 *
 * Used by the bid stream, where the debounce alone fired almost constantly:
 * the engine streams every team's writes on the shared testnet, so a quiet
 * 250ms gap is rare.
 */
export function throttledRunner(
  run: () => void,
  { debounceMs, minIntervalMs }: { debounceMs: number; minIntervalMs: number },
) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastRun = -Infinity;

  return {
    schedule() {
      if (timer) clearTimeout(timer);
      const wait = Math.max(debounceMs, lastRun + minIntervalMs - Date.now());
      timer = setTimeout(() => {
        timer = null;
        lastRun = Date.now();
        run();
      }, wait);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
