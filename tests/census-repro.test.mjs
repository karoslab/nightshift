// tests/census-repro.test.mjs — the expected-element repro generator emits a
// valid standalone script that embeds the REAL census + enumeration functions
// (parity asserted byte-identical), so a repro can never disagree with the
// report's verdict. No browser: the embedded pure functions are evaluated
// directly; the enumeration itself is exercised in tests/census-e2e.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateReproScript,
  generateCensusReproScript,
  EMBED_CENSUS_BEGIN,
  EMBED_CENSUS_END,
} from "../lib/reprogen.mjs";
import { normalizeName, locatorToSelector, elementSignature, signatureKey } from "../lib/census.mjs";

const CONFIG = { reverify: { navTimeoutMs: 5000 } };

function censusFinding() {
  return {
    id: "NS-007",
    source: "oracle:expected-element",
    title: 'Expected element missing at tablet — the button "Search"',
    severity: "major",
    signature: "expected-element|/responsive|tablet|k",
    census: {
      route: "http://127.0.0.1:9999/responsive",
      viewport: { name: "tablet", width: 760, height: 1024 },
      element: elementSignature({ role: "button", tag: "button", name: "Search", locator: { strategy: "role", role: "button", name: "Search", nth: 0 } }),
      ignoreSelectors: [],
      max: null,
    },
    trace: [{ i: 0, kind: "goto", value: "http://127.0.0.1:9999/responsive", locator: null, ok: true }],
  };
}

test("generateReproScript routes expected-element findings to the census generator", () => {
  const a = generateReproScript(censusFinding(), CONFIG);
  const b = generateCensusReproScript(censusFinding(), CONFIG);
  assert.equal(a, b, "the source dispatch must produce the census script");
  assert.match(a, /import \{ chromium \} from "playwright"/);
  assert.doesNotMatch(a, /from "\.\.?\//, "must not import any local module (standalone)");
  assert.match(a, /setViewportSize\(\{ width: VIEWPORT\.width/);
  assert.match(a, /REPRODUCED/);
});

test("parity: embedded census + enumeration functions are byte-identical to the library", () => {
  const script = generateReproScript(censusFinding(), CONFIG);
  const start = script.indexOf(EMBED_CENSUS_BEGIN);
  const end = script.indexOf(EMBED_CENSUS_END);
  assert.ok(start !== -1 && end > start, "census embed sentinels present");
  const embeddedSrc = script.slice(start + EMBED_CENSUS_BEGIN.length, end);
  const embedded = new Function(
    embeddedSrc + "; return { normalizeName, locatorToSelector, elementSignature, signatureKey };",
  )();

  const names = ["Search", "Cart (3)", "Updated 2026-07-17", "Sale ends 11:59 PM", "Order 4567 of 12", "  spaced   out "];
  for (const n of names) {
    assert.equal(embedded.normalizeName(n), normalizeName(n), "normalizeName diverged for " + JSON.stringify(n));
  }
  const locators = [
    { strategy: "role", role: "button", name: "Item 7", nth: 2 },
    { strategy: "text", text: "Buy 9 now", nth: 0 },
    { strategy: "css", css: "html > body > button:nth-of-type(1)", nth: 0 },
  ];
  for (const loc of locators) {
    assert.equal(embedded.locatorToSelector(loc), locatorToSelector(loc), "locatorToSelector diverged");
  }
  const els = [
    { role: "button", tag: "button", name: "Search", locator: { strategy: "role", role: "button", name: "Search", nth: 0 } },
    { role: "link", tag: "a", name: "Cart (12)", locator: { strategy: "role", role: "link", name: "Cart (12)", nth: 1 } },
  ];
  for (const el of els) {
    assert.deepEqual(embedded.elementSignature(el), elementSignature(el), "elementSignature diverged");
    assert.equal(embedded.signatureKey(embedded.elementSignature(el)), signatureKey(elementSignature(el)), "signatureKey diverged");
  }
});

test("census repro generator rejects a finding with no census payload", () => {
  assert.throws(() => generateCensusReproScript({ id: "NS-1", source: "oracle:expected-element" }, CONFIG), /no census payload/);
});
