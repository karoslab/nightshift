// tests/circuit-breaker.test.mjs — sliding-window HTTP/provider circuit breaker.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createCircuitBreaker } from "../lib/circuit-breaker.mjs";

function fixedClock(startMs) {
  let now = startMs;
  const clock = () => now;
  clock.set = (ms) => {
    now = ms;
  };
  return clock;
}

test("stays closed and allows requests below minSamples", () => {
  const cb = createCircuitBreaker({ minSamples: 5, errorThreshold: 0.5 }, fixedClock(0));
  for (let i = 0; i < 4; i++) cb.recordFailure();
  assert.equal(cb.state(), "closed");
  assert.equal(cb.allow(), true);
});

test("trips open once samples >= minSamples AND errorRate >= threshold", () => {
  const cb = createCircuitBreaker({ minSamples: 4, errorThreshold: 0.5 }, fixedClock(0));
  cb.recordFailure();
  cb.recordSuccess();
  cb.recordFailure();
  assert.equal(cb.state(), "closed"); // only 3 samples so far
  cb.recordFailure(); // 4th sample, 3/4 failures = 0.75 >= 0.5
  assert.equal(cb.state(), "open");
  assert.equal(cb.allow(), false);
});

test("stays closed when error rate is below threshold", () => {
  const cb = createCircuitBreaker({ minSamples: 4, errorThreshold: 0.5 }, fixedClock(0));
  cb.recordFailure();
  cb.recordSuccess();
  cb.recordSuccess();
  cb.recordSuccess(); // 1/4 = 0.25 < 0.5
  assert.equal(cb.state(), "closed");
  assert.equal(cb.allow(), true);
});

test("stays open (denies requests) until the cooldown elapses", () => {
  const clock = fixedClock(0);
  const cb = createCircuitBreaker({ minSamples: 2, errorThreshold: 0.5, cooldownMs: 1000 }, clock);
  cb.recordFailure();
  cb.recordFailure();
  assert.equal(cb.state(), "open");
  clock.set(999);
  assert.equal(cb.allow(), false);
  assert.equal(cb.state(), "open");
});

test("moves to half-open after cooldown and allows exactly one probe", () => {
  const clock = fixedClock(0);
  const cb = createCircuitBreaker({ minSamples: 2, errorThreshold: 0.5, cooldownMs: 1000 }, clock);
  cb.recordFailure();
  cb.recordFailure();
  clock.set(1000);
  assert.equal(cb.allow(), true); // the probe
  assert.equal(cb.state(), "half-open");
  assert.equal(cb.allow(), false); // no second concurrent probe
});

test("a successful half-open probe closes the breaker and resets the window", () => {
  const clock = fixedClock(0);
  const cb = createCircuitBreaker({ minSamples: 2, errorThreshold: 0.5, cooldownMs: 1000 }, clock);
  cb.recordFailure();
  cb.recordFailure();
  clock.set(1000);
  cb.allow(); // probe
  cb.recordSuccess();
  assert.equal(cb.state(), "closed");
  assert.equal(cb.allow(), true);
});

test("a failed half-open probe reopens the breaker for another full cooldown", () => {
  const clock = fixedClock(0);
  const cb = createCircuitBreaker({ minSamples: 2, errorThreshold: 0.5, cooldownMs: 1000 }, clock);
  cb.recordFailure();
  cb.recordFailure();
  clock.set(1000);
  cb.allow(); // probe
  cb.recordFailure();
  assert.equal(cb.state(), "open");
  assert.equal(cb.allow(), false);
  clock.set(1999);
  assert.equal(cb.allow(), false);
  clock.set(2000);
  assert.equal(cb.allow(), true);
});

test("window only keeps the most recent windowSize samples", () => {
  const cb = createCircuitBreaker({ windowSize: 4, minSamples: 4, errorThreshold: 0.5 }, fixedClock(0));
  cb.recordFailure();
  cb.recordFailure();
  cb.recordFailure();
  cb.recordFailure(); // 4/4 failures -> would trip
  assert.equal(cb.state(), "open");
});

test("applies design defaults when opts is empty", () => {
  const cb = createCircuitBreaker({}, fixedClock(0));
  assert.equal(cb.state(), "closed");
  assert.equal(cb.allow(), true);
});
