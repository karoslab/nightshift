// lib/census.mjs — element census: what interactive elements exist and are
// visible per route per viewport class. The collection pass REUSES
// lib/elements.mjs enumeration (it does not fork it) at three viewport classes;
// the diff compares a stored baseline against a fresh census and reports
// elements that disappeared (missing or computed-invisible) at a class.
//
// CONSTRAINT (load-bearing, mirrors lib/signature.mjs): normalizeName,
// elementSignature, signatureKey and locatorToSelector are dependency-free and
// self-contained — lib/reprogen.mjs embeds them into standalone repro scripts
// via Function.prototype.toString(), and a parity test asserts byte-identical
// behavior. Keep every helper INSIDE the function bodies here.

import { enumerateElements } from "./elements.mjs";

// The three pinned viewport classes (PRD): mobile / tablet / desktop. Fixed in
// v1 — a per-target override is explicitly out of scope.
export const VIEWPORT_CLASSES = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 760, height: 1024 },
  { name: "desktop", width: 1280, height: 800 },
];

// Normalize dynamic text in an accessible name so a signature stays stable
// across runs: dates, timestamps, clock times and digit runs collapse to a
// single "#" placeholder. A name like "Cart (3)" and "Cart (5)" are the SAME
// control — without this every counter/date/price would look like a
// disappear+appear pair and flood the diff.
export function normalizeName(name) {
  let s = String(name == null ? "" : name);
  s = s.replace(/\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?/gi, "#"); // iso timestamps
  s = s.replace(/\d{4}-\d{2}-\d{2}/g, "#"); // bare dates
  s = s.replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[ap]m)?\b/gi, "#"); // clock times
  s = s.replace(/\d+/g, "#"); // any remaining digit run
  s = s.replace(/#(?:\s*#)+/g, "#"); // collapse adjacent placeholders
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

// A locator descriptor (see lib/elements.mjs) -> a stable selectorPath string.
// The accessible name inside a role/text locator is normalized too, so a
// dynamic-name control keeps one identity across runs.
export function locatorToSelector(locator) {
  if (!locator || typeof locator !== "object") return "?#0";
  const nth = Number.isInteger(locator.nth) ? locator.nth : 0;
  if (locator.strategy === "role") return "role=" + locator.role + "[name=" + normalizeName(locator.name) + "]#" + nth;
  if (locator.strategy === "text") return "text=" + normalizeName(locator.text) + "#" + nth;
  if (locator.strategy === "css") return "css=" + String(locator.css) + "#" + nth;
  return "?#" + nth;
}

// An enumerateElements descriptor -> the normalized census signature the
// baseline stores. `visible` is always true here: enumerateElements only
// returns elements with a non-zero rect and non-hidden computed style, so an
// element present in the census IS visible; disappearance is detected by its
// ABSENCE from a later census (missing OR computed-invisible collapse to the
// same signal — the element is no longer an enumerable visible control).
export function elementSignature(el) {
  return {
    role: el.role ?? null,
    tag: el.tag ?? null,
    name: normalizeName(el.name),
    selector: locatorToSelector(el.locator),
    visible: true,
  };
}

// Stable identity key for a signature. Two signatures are the same control iff
// their keys are equal.
export function signatureKey(sig) {
  return [sig.role ?? "", sig.tag ?? "", sig.name ?? "", sig.selector ?? ""].join("");
}

// Enumerate the visible interactive elements at one viewport class and map them
// to normalized signatures. Sets the page viewport first (enumeration only — no
// actions), then reuses lib/elements.mjs enumeration verbatim.
export async function censusForViewport(page, viewport, { max = Infinity, ignoreSelectors = [] } = {}) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  const els = await enumerateElements(page, max, ignoreSelectors);
  return els.map(elementSignature);
}

// Full census for a route: one resize + enumerate per viewport class.
// Returns { mobile: [sig...], tablet: [...], desktop: [...] }. The page is left
// at the last (desktop) viewport; callers that need the prior size restore it.
export async function collectCensus(page, { viewports = VIEWPORT_CLASSES, max = Infinity, ignoreSelectors = [] } = {}) {
  const out = {};
  for (const vp of viewports) {
    out[vp.name] = await censusForViewport(page, vp, { max, ignoreSelectors });
  }
  return out;
}

// Compare a stored baseline census against a fresh one.
//   missing: baseline signatures absent from this run's census at a viewport
//            that WAS collected — the disappearances the oracle flags.
//   added:   run signatures not in the baseline — new controls (auto-added to
//            the baseline, never flagged).
// A viewport present in the baseline but not collected this run is skipped
// (crawl variance must not manufacture a disappearance).
export function diffCensus(baseline = {}, current = {}) {
  const missing = [];
  const added = [];
  for (const vp of Object.keys(baseline)) {
    if (!current[vp]) continue;
    const curKeys = new Set(current[vp].map(signatureKey));
    for (const el of baseline[vp]) {
      if (!curKeys.has(signatureKey(el))) missing.push({ viewport: vp, element: el });
    }
  }
  for (const vp of Object.keys(current)) {
    const baseKeys = new Set((baseline[vp] ?? []).map(signatureKey));
    for (const el of current[vp]) {
      if (!baseKeys.has(signatureKey(el))) added.push({ viewport: vp, element: el });
    }
  }
  return { missing, added };
}

// Merge a fresh census into a baseline: keep every baseline signature (a
// missing element stays expected until accepted/restored) and append run
// signatures not already present (growth). Order-stable and idempotent.
export function mergeCensus(baseline = {}, current = {}) {
  const out = {};
  const names = new Set([...Object.keys(baseline), ...Object.keys(current)]);
  for (const vp of names) {
    const base = baseline[vp] ?? [];
    const seen = new Set(base.map(signatureKey));
    const merged = [...base];
    for (const el of current[vp] ?? []) {
      const key = signatureKey(el);
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(el);
      }
    }
    out[vp] = merged;
  }
  return out;
}
