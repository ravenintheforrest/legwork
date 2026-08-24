// A clock the tests own. `sleep` never waits: it records the request and moves `now`
// forward, so every backoff, Retry-After, and pacing assertion in http.test.ts is exact
// and the suite stays fast and offline.

export interface FakeClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Every sleep, in order, in milliseconds. */
  readonly slept: number[];
  total: () => number;
}

/** Starts on a whole second so HTTP-date round-trips (second precision) are exact. */
export function fakeClock(start = 1_700_000_000_000): FakeClock {
  let current = start;
  const slept: number[] = [];
  return {
    now: () => current,
    sleep: async (ms: number) => {
      slept.push(ms);
      current += ms;
    },
    slept,
    total: () => slept.reduce((sum, ms) => sum + ms, 0),
  };
}

/** A clock that fails the test if anything sleeps. */
export function noSleepClock(start = 1_700_000_000_000): FakeClock {
  const clock = fakeClock(start);
  return {
    ...clock,
    sleep: async (ms: number) => {
      throw new Error(`fixture mode must never sleep (asked for ${ms}ms)`);
    },
  };
}

/** Resolve-later promises, for exercising the concurrency gate without timers. */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Let queued microtasks run. */
export async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}
