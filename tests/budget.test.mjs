// tests/budget.test.mjs — session + night budget guards with injected clocks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionBudget, createNightBudget } from "../lib/budget.mjs";

function fixedClock(startMs) {
  let now = startMs;
  const clock = () => now;
  clock.set = (ms) => {
    now = ms;
  };
  return clock;
}

test("session budget: tryConsumeCall allows exactly maxLlmCalls", () => {
  const budget = createSessionBudget({ maxLlmCalls: 3, maxMinutes: 45 }, fixedClock(0));
  assert.equal(budget.tryConsumeCall(), true);
  assert.equal(budget.tryConsumeCall(), true);
  assert.equal(budget.tryConsumeCall(), true);
  assert.equal(budget.tryConsumeCall(), false);
  assert.equal(budget.tryConsumeCall(), false);
  assert.equal(budget.summary().llmCalls, 3); // denied calls are not counted
});

test("session budget: timeLeft flips at maxMinutes", () => {
  const clock = fixedClock(1_000_000);
  const budget = createSessionBudget({ maxLlmCalls: 40, maxMinutes: 45 }, clock);
  assert.equal(budget.timeLeft(), true);
  clock.set(1_000_000 + 45 * 60_000 - 1);
  assert.equal(budget.timeLeft(), true);
  clock.set(1_000_000 + 45 * 60_000);
  assert.equal(budget.timeLeft(), false);
});

test("session budget: summary reports calls and elapsed minutes", () => {
  const clock = fixedClock(0);
  const budget = createSessionBudget({ maxLlmCalls: 40, maxMinutes: 45 }, clock);
  budget.tryConsumeCall();
  budget.tryConsumeCall();
  clock.set(90_000); // 1.5 minutes
  assert.deepEqual(budget.summary(), { llmCalls: 2, minutes: 1.5 });
});

test("session budget: applies design defaults when fields missing", () => {
  const clock = fixedClock(0);
  const budget = createSessionBudget({}, clock);
  for (let i = 0; i < 40; i++) assert.equal(budget.tryConsumeCall(), true);
  assert.equal(budget.tryConsumeCall(), false); // default maxLlmCalls 40
  clock.set(45 * 60_000);
  assert.equal(budget.timeLeft(), false); // default maxMinutes 45
});

test("night budget: sessionAllowed enforces maxSessionsPerNight", () => {
  const night = createNightBudget({ maxSessionsPerNight: 4, stopAtHour: 6 }, () => 0);
  assert.equal(night.sessionAllowed(0), true);
  assert.equal(night.sessionAllowed(3), true);
  assert.equal(night.sessionAllowed(4), false);
  assert.equal(night.sessionAllowed(5), false);
});

test("night budget: beforeStopHour wraps midnight (stopAtHour 6)", () => {
  const atHour = (h) => () => new Date(2026, 0, 1, h, 30, 0).getTime();
  const expected = new Map([
    [23, true], // evening run keeps going
    [0, true], //  ... through midnight
    [5, true], //  ... until the stop hour
    [6, false], // stop window opens
    [11, false], // stop window still open
    [12, true], // afternoon start is allowed again
    [18, true],
  ]);
  for (const [hour, want] of expected) {
    const night = createNightBudget({ maxSessionsPerNight: 4, stopAtHour: 6 }, atHour(hour));
    assert.equal(night.beforeStopHour(), want, `hour ${hour}`);
  }
});

test("night budget: beforeStopHour honors a non-default stopAtHour", () => {
  const atHour = (h) => () => new Date(2026, 0, 1, h, 0, 0).getTime();
  const night = (h) => createNightBudget({ stopAtHour: 8 }, atHour(h));
  assert.equal(night(7).beforeStopHour(), true);
  assert.equal(night(8).beforeStopHour(), false);
  assert.equal(night(11).beforeStopHour(), false);
  assert.equal(night(12).beforeStopHour(), true);
});
