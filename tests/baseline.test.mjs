// tests/baseline.test.mjs — the per-target baseline store: seed-then-diff,
// automatic growth, atomic writes, config-hash re-seed, and `baseline accept`.
// Filesystem only (a tmp dir); the browser census is covered by the e2e.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { elementSignature } from "../lib/census.mjs";
import {
  baselinesDir,
  routeKeyFor,
  configHashFor,
  beginBaselineRun,
  recordRouteCensus,
  readBaseline,
  readMeta,
  acceptFinding,
} from "../lib/baseline.mjs";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ns-baseline-"));
}

const sig = (name, role = "button", tag = "button") =>
  elementSignature({ role, tag, name, locator: { strategy: "role", role, name, nth: 0 } });

const censusOf = (mobile, tablet, desktop) => ({ mobile, tablet, desktop });

const cfg = (report, ignoreSelectors = []) => ({
  report: { dir: report },
  oracles: { expectedElements: { enabled: true, ignoreSelectors } },
});

test("baselinesDir hangs off report.dir; routeKeyFor is deterministic and path-safe", () => {
  const config = cfg("/tmp/x");
  assert.equal(baselinesDir(config), path.resolve("/tmp/x", "baselines"));
  const k = routeKeyFor("http://localhost:3000/shop/deals?tab=1");
  assert.equal(k, routeKeyFor("http://localhost:3000/shop/deals?tab=1"), "stable");
  assert.doesNotMatch(k, /[/?:]/, "no path separators or url metacharacters leak into the filename");
  assert.notEqual(routeKeyFor("http://x/a"), routeKeyFor("http://x/b"));
});

test("first run seeds the baseline and reports nothing; meta.json records created-at/runId/config-hash", () => {
  const dir = baselinesDir(cfg(tmpDir()));
  const config = cfg(path.dirname(dir));
  const run = beginBaselineRun({ dir, config, runId: "R1" });
  const census = censusOf([sig("Search"), sig("Home", "link", "a")], [sig("Search"), sig("Home", "link", "a")], [sig("Search"), sig("Home", "link", "a")]);

  const res = recordRouteCensus({ dir, route: "http://x/", census, runId: "R1", ...run });
  assert.equal(res.seeded, true);
  assert.deepEqual(res.missing, [], "a seeding run flags nothing");

  const meta = readMeta(dir);
  assert.equal(meta.runId, "R1");
  assert.equal(meta.configHash, configHashFor(config));
  assert.ok(meta.createdAt, "created-at recorded");

  const stored = readBaseline(dir, routeKeyFor("http://x/"));
  assert.equal(stored.route, "http://x/");
  assert.equal(stored.viewports.tablet.length, 2);
});

test("a later run flags a baseline element that disappeared at one viewport, and auto-adds new ones", () => {
  const dir = baselinesDir(cfg(tmpDir()));
  const config = cfg(path.dirname(dir));
  const seed = beginBaselineRun({ dir, config, runId: "R1" });
  const full = censusOf([sig("Search"), sig("Home", "link", "a")], [sig("Search"), sig("Home", "link", "a")], [sig("Search"), sig("Home", "link", "a")]);
  recordRouteCensus({ dir, route: "http://x/", census: full, runId: "R1", ...seed });

  // Next run: Search gone at tablet only, plus a brand-new "Help" link everywhere.
  const help = sig("Help", "link", "a");
  const changed = censusOf(
    [sig("Search"), sig("Home", "link", "a"), help],
    [sig("Home", "link", "a"), help],
    [sig("Search"), sig("Home", "link", "a"), help],
  );
  const run2 = beginBaselineRun({ dir, config, runId: "R2" });
  const res = recordRouteCensus({ dir, route: "http://x/", census: changed, runId: "R2", ...run2 });

  assert.equal(res.seeded, false);
  assert.equal(res.missing.length, 1, "exactly one disappearance");
  assert.equal(res.missing[0].viewport, "tablet");
  assert.equal(res.missing[0].element.name, "Search");

  // Growth landed in the stored baseline; the missing element is retained.
  const stored = readBaseline(dir, routeKeyFor("http://x/"));
  assert.ok(stored.viewports.tablet.some((e) => e.name === "Help"), "new element auto-added");
  assert.ok(stored.viewports.tablet.some((e) => e.name === "Search"), "missing element stays expected");
});

test("two consecutive unchanged runs produce ZERO findings (no flake)", () => {
  const dir = baselinesDir(cfg(tmpDir()));
  const config = cfg(path.dirname(dir));
  const census = censusOf([sig("A")], [sig("A")], [sig("A")]);
  const r1 = beginBaselineRun({ dir, config, runId: "R1" });
  assert.equal(recordRouteCensus({ dir, route: "http://x/", census, runId: "R1", ...r1 }).seeded, true);
  const r2 = beginBaselineRun({ dir, config, runId: "R2" });
  const res2 = recordRouteCensus({ dir, route: "http://x/", census, runId: "R2", ...r2 });
  assert.equal(res2.seeded, false);
  assert.deepEqual(res2.missing, []);
});

test("a changed config-hash re-seeds instead of flagging every element as missing", () => {
  const report = tmpDir();
  const dir = baselinesDir(cfg(report));
  const c1 = cfg(report, []);
  const r1 = beginBaselineRun({ dir, config: c1, runId: "R1" });
  const census1 = censusOf([sig("A"), sig("B")], [sig("A"), sig("B")], [sig("A"), sig("B")]);
  recordRouteCensus({ dir, route: "http://x/", census: census1, runId: "R1", ...r1 });

  // Config's ignoreSelectors changed -> config hash changes -> old baseline is
  // invalid. The run must RE-SEED, not report A and B as vanished.
  const c2 = cfg(report, ["#chatwidget"]);
  const r2 = beginBaselineRun({ dir, config: c2, runId: "R2" });
  assert.equal(r2.reseedAll, true, "config change forces a reseed");
  const res = recordRouteCensus({ dir, route: "http://x/", census: censusOf([sig("A")], [sig("A")], [sig("A")]), runId: "R2", ...r2 });
  assert.equal(res.seeded, true);
  assert.deepEqual(res.missing, []);
  assert.equal(readMeta(dir).configHash, configHashFor(c2));
});

test("a route not revisited during the config-change reseed is re-seeded on its next visit (no stale-baseline false positive)", () => {
  const report = tmpDir();
  const dir = baselinesDir(cfg(report));
  // R1 under config c1 (no ignoreSelectors): seed route /a WITH a "Chat" control.
  const c1 = cfg(report, []);
  const r1 = beginBaselineRun({ dir, config: c1, runId: "R1" });
  recordRouteCensus({ dir, route: "http://x/a", census: censusOf([sig("Chat"), sig("Home", "link", "a")], [sig("Chat"), sig("Home", "link", "a")], [sig("Chat"), sig("Home", "link", "a")]), runId: "R1", ...r1 });

  // R2 under config c2 (ignoreSelectors now hides Chat) -> global reseed, but /a
  // is NOT visited this run (crawl-order variance / maxRoutes cap). meta.json is
  // updated to c2's hash immediately, yet /a's baseline still carries c1's hash
  // and still lists "Chat".
  const c2 = cfg(report, ["#chat"]);
  const r2 = beginBaselineRun({ dir, config: c2, runId: "R2" });
  assert.equal(r2.reseedAll, true);
  assert.equal(readBaseline(dir, routeKeyFor("http://x/a")).configHash, configHashFor(c1), "stale route keeps its old config hash");

  // R3 under c2: meta matches now (reseedAll=false), and /a IS visited with a
  // census that correctly excludes the ignored "Chat". Diffing against the
  // stale c1 baseline would flag Chat as a disappearance — the fix re-seeds the
  // route because its stored config hash is out of date.
  const r3 = beginBaselineRun({ dir, config: c2, runId: "R3" });
  assert.equal(r3.reseedAll, false, "meta hash already matches after R2");
  const res = recordRouteCensus({ dir, route: "http://x/a", census: censusOf([sig("Home", "link", "a")], [sig("Home", "link", "a")], [sig("Home", "link", "a")]), runId: "R3", ...r3 });
  assert.equal(res.seeded, true, "a route with a stale config hash must re-seed, not diff");
  assert.deepEqual(res.missing, [], "no false-positive disappearance for an ignored element");
  assert.equal(readBaseline(dir, routeKeyFor("http://x/a")).configHash, configHashFor(c2), "route baseline now carries the current config hash");
});

test("--update-baselines forces a reseed of a visited route (deliberate redesign)", () => {
  const report = tmpDir();
  const dir = baselinesDir(cfg(report));
  const config = cfg(report);
  const r1 = beginBaselineRun({ dir, config, runId: "R1" });
  recordRouteCensus({ dir, route: "http://x/", census: censusOf([sig("A"), sig("B")], [sig("A"), sig("B")], [sig("A"), sig("B")]), runId: "R1", ...r1 });

  const r2 = beginBaselineRun({ dir, config, runId: "R2", updateBaselines: true });
  assert.equal(r2.reseedAll, true);
  const res = recordRouteCensus({ dir, route: "http://x/", census: censusOf([sig("A")], [sig("A")], [sig("A")]), runId: "R2", ...r2 });
  assert.equal(res.seeded, true, "the route is re-seeded rather than diffed");
  assert.equal(readBaseline(dir, routeKeyFor("http://x/")).viewports.tablet.length, 1, "B is gone from the baseline, not flagged");
});

test("baseline accept removes the accepted element and records who/when", () => {
  const dir = baselinesDir(cfg(tmpDir()));
  const config = cfg(path.dirname(dir));
  const seed = beginBaselineRun({ dir, config, runId: "R1" });
  recordRouteCensus({ dir, route: "http://x/", census: censusOf([sig("Search"), sig("Home", "link", "a")], [sig("Search"), sig("Home", "link", "a")], [sig("Search"), sig("Home", "link", "a")]), runId: "R1", ...seed });

  // A finding for Search missing at tablet — the shape recordRouteCensus emits.
  const finding = {
    id: "NS-003",
    source: "oracle:expected-element",
    census: { route: "http://x/", viewport: { name: "tablet" }, element: sig("Search") },
  };
  const out = acceptFinding({ dir, finding, who: "alice", when: "2026-07-17T00:00:00Z" });
  assert.equal(out.accepted, true);

  const stored = readBaseline(dir, routeKeyFor("http://x/"));
  assert.ok(!stored.viewports.tablet.some((e) => e.name === "Search"), "accepted element removed from that viewport");
  assert.ok(stored.viewports.mobile.some((e) => e.name === "Search"), "other viewports untouched");

  const meta = readMeta(dir);
  assert.ok(meta.accepts.some((a) => a.findingId === "NS-003" && a.who === "alice" && a.when === "2026-07-17T00:00:00Z"));

  // Re-running the same census now yields NO finding for the accepted element.
  const r2 = beginBaselineRun({ dir, config, runId: "R2" });
  const res2 = recordRouteCensus({ dir, route: "http://x/", census: censusOf([sig("Search"), sig("Home", "link", "a")], [sig("Home", "link", "a")], [sig("Search"), sig("Home", "link", "a")]), runId: "R2", ...r2 });
  assert.deepEqual(res2.missing, [], "an accepted disappearance never re-flags");
});
