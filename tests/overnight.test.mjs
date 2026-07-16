// tests/overnight.test.mjs — per-session error containment in the overnight
// loop (2026-07-02 findings review). Hermetic: stubbed night budget and
// sessions, no browser, no network. Importing bin/nightshift.mjs is safe: its
// isMain guard keeps main() from running under the test runner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { collectOvernightFindings, exitCodeForRunState } from "../bin/nightshift.mjs";

const makeStats = () => ({
  routesVisited: 1,
  actionsExecuted: 2,
  llmCalls: 3,
  turnsOk: 3,
  turnsFailed: 0,
  startedAt: "2026-07-02T03:00:00.000Z",
  endedAt: "2026-07-02T03:10:00.000Z",
  durationMs: 600_000,
  usage: { inputTokens: 10, outputTokens: 5, costUsd: null },
});

const finding = (id, signature) => ({ id, signature, status: "candidate" });

test("a session crash at 3am keeps the candidates earlier sessions collected", async () => {
  const night = { sessionAllowed: (n) => n < 4, beforeStopHour: () => true };
  let calls = 0;
  const runOneSession = async () => {
    calls += 1;
    if (calls === 1) return { findings: [finding("NS-001", "sig-a"), finding("NS-002", "sig-b")], stats: makeStats() };
    if (calls === 2) return { findings: [finding("NS-003", "sig-b"), finding("NS-004", "sig-c")], stats: makeStats() };
    // transient chromium.launch failure on the sleeping laptop
    throw new Error("browserType.launch: Resource temporarily unavailable (EAGAIN)");
  };
  const logs = [];
  const out = await collectOvernightFindings({ night, runOneSession, log: (level, message) => logs.push([level, message]) });

  assert.equal(out.sessions, 2, "two sessions completed before the crash");
  assert.deepEqual(
    out.findings.map((f) => f.id),
    ["NS-001", "NS-002", "NS-004"],
    "earlier candidates kept, duplicate signature deduped",
  );
  assert.equal(out.stats.llmCalls, 6, "stats merged across the completed sessions");
  assert.equal(out.stats.turnsOk, 6, "turnsOk merged across the completed sessions");
  assert.equal(out.stats.turnsFailed, 0, "turnsFailed merged across the completed sessions");
  assert.ok(
    logs.some(([level, message]) => level === "error" && /crashed/.test(message) && /EAGAIN/.test(message)),
    "the crash must be logged, not swallowed: " + JSON.stringify(logs),
  );
});

test("a crash on the very first session still resolves so the caller writes a (clean) report", async () => {
  const night = { sessionAllowed: (n) => n < 4, beforeStopHour: () => true };
  const out = await collectOvernightFindings({
    night,
    runOneSession: async () => {
      throw new Error("boom");
    },
    log: () => {},
  });
  assert.equal(out.sessions, 0);
  assert.deepEqual(out.findings, []);
  assert.equal(out.stats, null); // cmdOvernight substitutes emptyStats()
});

test("the loop still respects the night budget and stop hour", async () => {
  let hourOk = true;
  const night = { sessionAllowed: (n) => n < 2, beforeStopHour: () => hourOk };
  let calls = 0;
  const runOneSession = async () => {
    calls += 1;
    return { findings: [finding("NS-00" + calls, "sig-" + calls)], stats: makeStats() };
  };
  const out = await collectOvernightFindings({ night, runOneSession, log: () => {} });
  assert.equal(out.sessions, 2, "maxSessionsPerNight caps the loop");

  hourOk = false;
  const stopped = await collectOvernightFindings({ night, runOneSession, log: () => {} });
  assert.equal(stopped.sessions, 0, "past the stop hour no session launches");
});

test("exitCodeForRunState: nonzero only for failed/inconclusive, zero for healthy/degraded", () => {
  assert.equal(exitCodeForRunState("healthy"), 0);
  assert.equal(exitCodeForRunState("degraded"), 0);
  assert.equal(exitCodeForRunState("failed"), 1);
  assert.equal(exitCodeForRunState("inconclusive"), 1);
});
