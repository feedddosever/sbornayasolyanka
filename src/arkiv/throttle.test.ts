import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { throttledRunner } from "./throttle";

function setup(debounceMs = 250, minIntervalMs = 3_000) {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  let runs = 0;
  const r = throttledRunner(() => runs++, { debounceMs, minIntervalMs });
  return { r, runs: () => runs, tick: (ms: number) => mock.timers.tick(ms) };
}

test("a burst collapses into one run after the debounce", (t) => {
  const { r, runs, tick } = setup();
  t.after(() => mock.timers.reset());
  for (let i = 0; i < 10; i++) r.schedule();
  tick(249);
  assert.equal(runs(), 0);
  tick(1);
  assert.equal(runs(), 1);
});

test("continuous traffic runs at most once per interval, not every debounce", (t) => {
  const { r, runs, tick } = setup();
  t.after(() => mock.timers.reset());
  // An event every 100ms for 10 seconds: a plain 250ms debounce would never
  // settle, and a leading-edge one would run 40 times.
  for (let elapsed = 0; elapsed < 10_000; elapsed += 100) {
    r.schedule();
    tick(100);
  }
  tick(3_000); // let the trailing run land
  assert.ok(runs() <= 5, `ran ${runs()} times in ~13s`);
  assert.ok(runs() >= 1);
});

test("the last event of a burst is never dropped", (t) => {
  const { r, runs, tick } = setup();
  t.after(() => mock.timers.reset());
  r.schedule();
  tick(250); // run 1
  r.schedule(); // inside the interval
  tick(2_000);
  assert.equal(runs(), 1, "held back by the floor");
  tick(1_000);
  assert.equal(runs(), 2, "trailing run after the floor");
});

test("cancel stops a pending run", (t) => {
  const { r, runs, tick } = setup();
  t.after(() => mock.timers.reset());
  r.schedule();
  r.cancel();
  tick(10_000);
  assert.equal(runs(), 0);
});
