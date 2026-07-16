// lib/circuit-breaker.mjs — sliding-window HTTP/provider circuit breaker.
// Pure factory with an injectable clock (ms epoch) for tests. Guards a single
// outbound target: trips open once enough recent samples show a high error
// rate, then probes once per cooldown (half-open) before fully closing again.

const DEFAULTS = {
  windowSize: 20,
  minSamples: 10,
  errorThreshold: 0.5,
  cooldownMs: 30_000,
};

export function createCircuitBreaker(opts = {}, clock = Date.now) {
  const windowSize = opts.windowSize ?? DEFAULTS.windowSize;
  const minSamples = opts.minSamples ?? DEFAULTS.minSamples;
  const errorThreshold = opts.errorThreshold ?? DEFAULTS.errorThreshold;
  const cooldownMs = opts.cooldownMs ?? DEFAULTS.cooldownMs;

  let state = "closed";
  let window = []; // recent samples, oldest first; true = success, false = failure
  let openedAt = 0;
  let probeInFlight = false;

  function errorRate() {
    if (window.length === 0) return 0;
    const failures = window.filter((ok) => !ok).length;
    return failures / window.length;
  }

  function record(ok) {
    if (state === "half-open") {
      probeInFlight = false;
      if (ok) {
        state = "closed";
        window = [];
      } else {
        state = "open";
        openedAt = clock();
      }
      return;
    }
    window.push(ok);
    if (window.length > windowSize) window.shift();
    if (state === "closed" && window.length >= minSamples && errorRate() >= errorThreshold) {
      state = "open";
      openedAt = clock();
    }
  }

  return {
    allow() {
      if (state === "closed") return true;
      if (state === "open") {
        if (clock() - openedAt < cooldownMs) return false;
        state = "half-open";
        probeInFlight = true;
        return true;
      }
      // half-open: only one probe in flight at a time
      if (probeInFlight) return false;
      probeInFlight = true;
      return true;
    },
    recordSuccess() {
      record(true);
    },
    recordFailure() {
      record(false);
    },
    state() {
      return state;
    },
  };
}
