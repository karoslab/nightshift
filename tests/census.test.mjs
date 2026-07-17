// tests/census.test.mjs — unit tests for the element-census pure logic:
// dynamic-text name normalization, descriptor -> normalized signature, and the
// baseline-vs-run census diff. No browser: collectCensus (the resize+enumerate
// pass) is exercised end-to-end in tests/census-e2e.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  VIEWPORT_CLASSES,
  normalizeName,
  elementSignature,
  signatureKey,
  locatorToSelector,
  diffCensus,
} from "../lib/census.mjs";

test("VIEWPORT_CLASSES are the three pinned classes at the PRD sizes", () => {
  assert.deepEqual(
    VIEWPORT_CLASSES,
    [
      { name: "mobile", width: 375, height: 812 },
      { name: "tablet", width: 760, height: 1024 },
      { name: "desktop", width: 1280, height: 800 },
    ],
  );
});

test("normalizeName replaces dynamic digits/dates/times with a single placeholder", () => {
  // Independent worked expectations — NOT recomputed the way the code does.
  assert.equal(normalizeName("Cart (3)"), "Cart (#)");
  assert.equal(normalizeName("12 items left"), "# items left");
  assert.equal(normalizeName("Updated 2026-07-17"), "Updated #");
  assert.equal(normalizeName("Posted 2026-07-17T14:33:02Z"), "Posted #");
  assert.equal(normalizeName("Sale ends 11:59 PM"), "Sale ends #");
  // Placeholders separated by static words stay distinct; adjacent runs and
  // whitespace collapse.
  assert.equal(normalizeName("Order 4567 of 12"), "Order # of #");
  assert.equal(normalizeName("Order   4567  12"), "Order #");
  // A purely static name is returned unchanged (bar whitespace collapse).
  assert.equal(normalizeName("  Search   the  catalog "), "Search the catalog");
  assert.equal(normalizeName(null), "");
});

test("two runs of the same element normalize to the SAME key despite changing digits", () => {
  const a = elementSignature({ role: "link", tag: "a", name: "Cart (3)", locator: { strategy: "role", role: "link", name: "Cart (3)", nth: 0 } });
  const b = elementSignature({ role: "link", tag: "a", name: "Cart (5)", locator: { strategy: "role", role: "link", name: "Cart (5)", nth: 0 } });
  assert.equal(signatureKey(a), signatureKey(b), "digit-only name change must not shift identity");
});

test("elementSignature records role/tag, normalized name, selectorPath and visible", () => {
  const sig = elementSignature({
    role: "button",
    tag: "button",
    name: "Add to cart",
    locator: { strategy: "role", role: "button", name: "Add to cart", nth: 0 },
  });
  assert.equal(sig.role, "button");
  assert.equal(sig.tag, "button");
  assert.equal(sig.name, "Add to cart");
  assert.equal(sig.selector, "role=button[name=Add to cart]#0");
  assert.equal(sig.visible, true);
});

test("locatorToSelector serializes each strategy stably, normalizing dynamic names", () => {
  assert.equal(locatorToSelector({ strategy: "role", role: "button", name: "Item 7", nth: 2 }), "role=button[name=Item #]#2");
  assert.equal(locatorToSelector({ strategy: "text", text: "Buy 9 now", nth: 0 }), "text=Buy # now#0");
  assert.equal(locatorToSelector({ strategy: "css", css: "html > body > button:nth-of-type(1)", nth: 0 }), "css=html > body > button:nth-of-type(1)#0");
});

test("diffCensus flags a baseline element missing at one viewport, ignoring the others", () => {
  const search = elementSignature({ role: "button", tag: "button", name: "Search", locator: { strategy: "role", role: "button", name: "Search", nth: 0 } });
  const home = elementSignature({ role: "link", tag: "a", name: "Home", locator: { strategy: "role", role: "link", name: "Home", nth: 0 } });
  const baseline = { mobile: [search, home], tablet: [search, home], desktop: [search, home] };
  // Search vanished at tablet only (the short4movies case); everything else stable.
  const current = { mobile: [search, home], tablet: [home], desktop: [search, home] };

  const { missing, added } = diffCensus(baseline, current);
  assert.equal(missing.length, 1, "exactly one disappearance");
  assert.equal(missing[0].viewport, "tablet");
  assert.equal(missing[0].element.name, "Search");
  assert.equal(added.length, 0, "nothing new appeared");
});

test("diffCensus treats a NEW element as added, never missing (growth is not a regression)", () => {
  const home = elementSignature({ role: "link", tag: "a", name: "Home", locator: { strategy: "role", role: "link", name: "Home", nth: 0 } });
  const help = elementSignature({ role: "link", tag: "a", name: "Help", locator: { strategy: "role", role: "link", name: "Help", nth: 0 } });
  const baseline = { mobile: [home], tablet: [home], desktop: [home] };
  const current = { mobile: [home, help], tablet: [home, help], desktop: [home, help] };
  const { missing, added } = diffCensus(baseline, current);
  assert.equal(missing.length, 0);
  assert.equal(added.length, 3, "the new link appears once per viewport class");
  assert.ok(added.every((a) => a.element.name === "Help"));
});

test("diffCensus leaves a viewport untouched when the run did not collect it", () => {
  const home = elementSignature({ role: "link", tag: "a", name: "Home", locator: { strategy: "role", role: "link", name: "Home", nth: 0 } });
  const baseline = { mobile: [home], tablet: [home], desktop: [home] };
  const current = { mobile: [home], desktop: [home] }; // tablet not collected this run
  const { missing } = diffCensus(baseline, current);
  assert.equal(missing.length, 0, "an uncollected viewport must not produce disappearances");
});
