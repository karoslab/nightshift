// lib/baseline.mjs — the per-target element-census baseline store.
// Layout (persists across runs, distinct from the per-run report dirs):
//   <report.dir>/baselines/meta.json          created-at, runId, config hash, accepts
//   <report.dir>/baselines/<route-key>.json   { route, viewports: {mobile,tablet,desktop} }
// Writes are atomic (temp file + rename) so an interrupted run never leaves a
// half-written baseline that would manufacture false disappearances next time.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { VIEWPORT_CLASSES, diffCensus, mergeCensus, signatureKey } from "./census.mjs";

export function baselinesDir(config) {
  return path.join(path.resolve(config?.report?.dir ?? ".nightshift"), "baselines");
}

// pathname+search -> a stable, path-safe filename. A short hash of the exact
// path is appended so two routes that sanitize to the same slug never collide.
export function routeKeyFor(route) {
  let ps;
  try {
    const u = new URL(route);
    ps = u.pathname + u.search;
  } catch {
    ps = String(route ?? "");
  }
  const slug = ps.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "root";
  const hash = crypto.createHash("sha256").update(ps).digest("hex").slice(0, 8);
  return slug + "-" + hash;
}

// Identity of the census CONFIG that produced a baseline. When it changes
// (viewport classes or ignore list), the stored baseline is no longer
// comparable and the run re-seeds instead of reporting mass disappearances.
export function configHashFor(config) {
  const shape = {
    viewports: VIEWPORT_CLASSES,
    ignoreSelectors: config?.oracles?.expectedElements?.ignoreSelectors ?? [],
  };
  return crypto.createHash("sha256").update(JSON.stringify(shape)).digest("hex");
}

function nowISO() {
  return new Date().toISOString();
}

function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function readMeta(dir) {
  return readJson(path.join(dir, "meta.json"));
}

export function readBaseline(dir, routeKey) {
  return readJson(path.join(dir, routeKey + ".json"));
}

function writeBaseline(dir, routeKey, data) {
  atomicWriteJson(path.join(dir, routeKey + ".json"), data);
}

function writeMeta(dir, meta) {
  atomicWriteJson(path.join(dir, "meta.json"), meta);
}

// Called once at the start of a run's census. Decides whether this run must
// RE-SEED every visited route (first-ever run, a config-hash change, or an
// explicit --update-baselines) and keeps meta.json current. Returns the config
// hash and the reseedAll flag to thread through recordRouteCensus.
export function beginBaselineRun({ dir, config, runId, updateBaselines = false }) {
  fs.mkdirSync(dir, { recursive: true });
  const meta = readMeta(dir);
  const configHash = configHashFor(config);
  const reseedAll = Boolean(updateBaselines) || meta == null || meta.configHash !== configHash;
  if (reseedAll) {
    writeMeta(dir, {
      createdAt: meta?.createdAt ?? nowISO(),
      runId,
      configHash,
      accepts: meta?.accepts ?? [],
    });
  }
  return { configHash, reseedAll };
}

// Records one route's census against the baseline store.
//   reseedAll OR no baseline yet -> SEED (write, report nothing).
//   otherwise -> DIFF: return disappearances (missing) and auto-add new
//   elements (growth) to the stored baseline, retaining still-missing entries.
export function recordRouteCensus({ dir, route, census, runId, configHash, reseedAll = false }) {
  const routeKey = routeKeyFor(route);
  const existing = readBaseline(dir, routeKey);

  // Re-seed (never diff) when: this run re-seeds everything; the route has no
  // baseline yet; OR the route's stored baseline was seeded under a DIFFERENT
  // config hash. The last case is load-bearing: a config change re-seeds meta +
  // the routes visited that run, but a route not revisited then keeps its
  // old-config baseline. Without this per-route check, a later run (whose meta
  // hash already matches) would diff that stale baseline against a fresh census
  // and flag now-ignored elements as false-positive disappearances.
  if (reseedAll || existing == null || existing.configHash !== configHash) {
    writeBaseline(dir, routeKey, { route, routeKey, viewports: census, seededAt: nowISO(), runId, configHash });
    return { seeded: true, missing: [], added: [] };
  }

  const { missing, added } = diffCensus(existing.viewports, census);
  const merged = mergeCensus(existing.viewports, census);
  writeBaseline(dir, routeKey, { ...existing, viewports: merged, updatedAt: nowISO(), runId });
  return { seeded: false, missing, added };
}

// `nightshift baseline accept <finding-id>`: the accepted disappearance was
// intentional — drop that element from the route+viewport baseline so it never
// re-flags, and append a who/when audit record to meta.json.
export function acceptFinding({ dir, finding, who, when = nowISO() }) {
  const census = finding?.census;
  if (!census || !census.route || !census.viewport?.name || !census.element) {
    return { accepted: false, reason: "finding carries no expected-element census payload" };
  }
  const routeKey = routeKeyFor(census.route);
  const baseline = readBaseline(dir, routeKey);
  if (!baseline) return { accepted: false, reason: "no baseline for route " + census.route };

  const vp = census.viewport.name;
  const key = signatureKey(census.element);
  const before = baseline.viewports?.[vp] ?? [];
  const after = before.filter((e) => signatureKey(e) !== key);
  if (after.length === before.length) {
    return { accepted: false, reason: "element not present in the " + vp + " baseline (already accepted?)" };
  }
  baseline.viewports[vp] = after;
  baseline.updatedAt = nowISO();
  writeBaseline(dir, routeKey, baseline);

  const meta = readMeta(dir) ?? { createdAt: nowISO(), runId: null, configHash: null, accepts: [] };
  meta.accepts = meta.accepts ?? [];
  meta.accepts.push({
    findingId: finding.id ?? null,
    route: census.route,
    viewport: vp,
    elementKey: key,
    elementName: census.element.name ?? null,
    who,
    when,
  });
  writeMeta(dir, meta);
  return { accepted: true };
}
