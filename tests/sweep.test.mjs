// tests/sweep.test.mjs — pure-unit coverage for sweep mode's accounting and
// form-input synthesis. No browser: these modules are deterministic and
// dependency-free. The browser-driven sweep is covered by tests/sweep-e2e.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { synthesizeFieldValue, SWEEP_PASSES, HOSTILE_VALUE } from "../lib/sweep-input.mjs";
import {
  createCoverageTracker,
  loadCheckpoint,
  saveCheckpoint,
} from "../lib/sweep-coverage.mjs";

// ---------------------------------------------------------------------------
// Form-input synthesis
// ---------------------------------------------------------------------------
test("sweep passes are the three pinned kinds in order", () => {
  assert.deepEqual(SWEEP_PASSES, ["empty", "hostile", "valid"]);
});

test("empty pass always yields the empty string, whatever the field", () => {
  assert.equal(synthesizeFieldValue({ type: "email", name: "e" }, "empty"), "");
  assert.equal(synthesizeFieldValue({ type: "text" }, "empty"), "");
});

test("hostile pass is overlong, carries non-ASCII, and a script-tag payload", () => {
  const v = synthesizeFieldValue({ type: "text" }, "hostile");
  assert.equal(v, HOSTILE_VALUE, "hostile value is the shared constant");
  assert.ok(v.length > 1000, `hostile input should be overlong, got ${v.length}`);
  assert.ok(/<script/i.test(v), "hostile input should carry a script-tag payload");
  assert.ok([...v].some((c) => c.charCodeAt(0) > 127), "hostile input should carry non-ASCII");
});

test("valid pass derives a plausible value from the field type", () => {
  assert.match(synthesizeFieldValue({ type: "email" }, "valid"), /^[^@\s]+@[^@\s]+\.[^@\s]+$/);
  assert.match(synthesizeFieldValue({ type: "number" }, "valid"), /^\d+$/);
  assert.match(synthesizeFieldValue({ type: "url" }, "valid"), /^https?:\/\//);
  assert.match(synthesizeFieldValue({ type: "tel" }, "valid"), /^\+?[\d ()+-]+$/);
  const text = synthesizeFieldValue({ type: "text" }, "valid");
  assert.ok(text.length > 0 && !text.includes("<"), "plain text should be a benign non-empty string");
});

test("valid pass falls back to the field name/placeholder when the type is generic", () => {
  // A bare text input named "email" should still get an email-shaped value.
  assert.match(synthesizeFieldValue({ type: "text", name: "email" }, "valid"), /@/);
  assert.match(synthesizeFieldValue({ type: "text", placeholder: "Your phone" }, "valid"), /\d/);
});

test("valid pass exposes a brain hook that overrides the deterministic value", () => {
  const suggest = (field, pass) => (pass === "valid" ? "brained:" + field.name : null);
  assert.equal(synthesizeFieldValue({ type: "text", name: "q" }, "valid", { suggest }), "brained:q");
  // A null suggestion falls back to the deterministic path.
  assert.equal(synthesizeFieldValue({ type: "text" }, "empty", { suggest }), "");
});

test("an unknown pass is rejected rather than silently mis-filled", () => {
  assert.throws(() => synthesizeFieldValue({ type: "text" }, "bogus"), /unknown sweep pass/);
});

// ---------------------------------------------------------------------------
// Coverage accounting
// ---------------------------------------------------------------------------
test("coverage tracker tallies found/exercised/skipped/failed per route and in total", () => {
  const cov = createCoverageTracker();
  cov.setFound("/a", 4);
  cov.recordExercised("/a");
  cov.recordExercised("/a");
  cov.recordFailed("/a");
  cov.recordSkipped("/a", 1);

  cov.setFound("/b", 2);
  cov.recordExercised("/b");
  cov.recordExercised("/b");

  const s = cov.summary();
  const a = s.routes.find((r) => r.url === "/a");
  assert.deepEqual(
    { found: a.found, exercised: a.exercised, failed: a.failed, skipped: a.skipped },
    { found: 4, exercised: 2, failed: 1, skipped: 1 },
  );
  // coverage = attempted (exercised + failed) / found
  assert.equal(a.coveragePct, 75);

  const b = s.routes.find((r) => r.url === "/b");
  assert.equal(b.coveragePct, 100);

  assert.equal(s.totals.found, 6);
  assert.equal(s.totals.exercised, 4);
  assert.equal(s.totals.failed, 1);
  assert.equal(s.totals.skipped, 1);
  // totals coverage = (4 exercised + 1 failed) / 6 found = 83%
  assert.equal(s.totals.coveragePct, 83);
});

test("a route with zero interactive elements reports 100% (nothing to miss), not NaN", () => {
  const cov = createCoverageTracker();
  cov.setFound("/empty", 0);
  const s = cov.summary();
  assert.equal(s.routes[0].coveragePct, 100);
  assert.equal(s.totals.coveragePct, 100);
});

test("restore re-hydrates a completed route's counts from a checkpoint summary", () => {
  const cov = createCoverageTracker();
  cov.restore({ url: "/done", found: 3, exercised: 3, skipped: 0, failed: 0, forms: 1 });
  const s = cov.summary();
  const done = s.routes.find((r) => r.url === "/done");
  assert.equal(done.exercised, 3);
  assert.equal(done.forms, 1);
  assert.equal(done.coveragePct, 100);
});

// ---------------------------------------------------------------------------
// Checkpoint persistence
// ---------------------------------------------------------------------------
test("checkpoint round-trips through the run dir; missing file loads as null", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ns-sweep-ckpt-"));
  try {
    assert.equal(loadCheckpoint(dir), null, "no checkpoint yet -> null");
    const state = {
      version: 1,
      routesDone: ["/a"],
      current: { route: "/b", elementsDone: 2 },
      coverage: { routes: [{ url: "/a", found: 3, exercised: 3, skipped: 0, failed: 0, forms: 0 }] },
    };
    saveCheckpoint(dir, state);
    assert.ok(fs.existsSync(path.join(dir, "sweep-checkpoint.json")));
    assert.deepEqual(loadCheckpoint(dir), state);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
