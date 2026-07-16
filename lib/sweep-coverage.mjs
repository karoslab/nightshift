// lib/sweep-coverage.mjs — sweep coverage accounting + checkpoint persistence.
// Pure/deterministic (the only I/O is the checkpoint file), so the queue and
// coverage bookkeeping is unit-tested without a browser.

import fs from "node:fs";
import path from "node:path";

const CHECKPOINT_FILE = "sweep-checkpoint.json";

// Per-route tallies: found (interactive elements enumerated), exercised
// (attempted and the action completed), skipped (denied by selectorDenylist /
// denyActionKinds), failed (attempted but the action errored), forms (form
// passes run). coveragePct is the fraction of found elements we actually
// touched: (exercised + failed) / found — denied elements deliberately lower
// it. An empty route (found 0) reports 100% (nothing to miss), never NaN.
export function createCoverageTracker() {
  const routes = new Map();

  const ensure = (url) => {
    if (!routes.has(url)) {
      routes.set(url, { url, found: 0, exercised: 0, skipped: 0, failed: 0, forms: 0 });
    }
    return routes.get(url);
  };

  return {
    setFound(url, n) {
      ensure(url).found = n;
    },
    recordExercised(url) {
      ensure(url).exercised += 1;
    },
    recordSkipped(url, n = 1) {
      ensure(url).skipped += n;
    },
    recordFailed(url) {
      ensure(url).failed += 1;
    },
    recordForm(url) {
      ensure(url).forms += 1;
    },
    // Re-hydrate a route wholesale from a checkpoint summary (resume).
    restore(summary) {
      routes.set(summary.url, {
        url: summary.url,
        found: summary.found ?? 0,
        exercised: summary.exercised ?? 0,
        skipped: summary.skipped ?? 0,
        failed: summary.failed ?? 0,
        forms: summary.forms ?? 0,
      });
    },
    routeSummary(url) {
      return { ...ensure(url) };
    },
    summary() {
      const perRoute = [...routes.values()].map((r) => ({ ...r, coveragePct: pct(r) }));
      const totals = perRoute.reduce(
        (a, r) => ({
          found: a.found + r.found,
          exercised: a.exercised + r.exercised,
          skipped: a.skipped + r.skipped,
          failed: a.failed + r.failed,
          forms: a.forms + r.forms,
        }),
        { found: 0, exercised: 0, skipped: 0, failed: 0, forms: 0 },
      );
      return { routes: perRoute, totals: { ...totals, coveragePct: pct(totals) } };
    },
  };
}

function pct(r) {
  if (!r.found) return 100;
  return Math.round((100 * (r.exercised + r.failed)) / r.found);
}

// Checkpoint: the resumable state of an interrupted sweep, written into the run
// dir after each element and each finished route so a maxMinutes hard stop (or
// a crash) continues instead of restarting.
export function loadCheckpoint(runDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(runDir, CHECKPOINT_FILE), "utf8"));
  } catch {
    return null;
  }
}

export function saveCheckpoint(runDir, state) {
  fs.writeFileSync(path.join(runDir, CHECKPOINT_FILE), JSON.stringify(state, null, 2) + "\n");
}
