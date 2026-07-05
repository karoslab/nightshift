// tests/elements.test.mjs — hermetic: chromium + page.setContent only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { enumerateElements } from "../lib/elements.mjs";

let browser;
let page;

before(async () => {
  browser = await chromium.launch({ headless: true });
  page = await (await browser.newContext()).newPage();
});

after(async () => {
  await browser.close();
});

test("enumerates interactive elements in document order with role locators", async () => {
  await page.setContent(`
    <button>Add to cart</button>
    <a href="/about">About</a>
    <input type="text" aria-label="Email">
    <select aria-label="Color"><option>red</option></select>
    <textarea aria-label="Notes"></textarea>
    <div role="button">Fancy</div>
  `);
  const els = await enumerateElements(page);
  assert.equal(els.length, 6);
  assert.deepEqual(els.map((e) => e.id), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(
    els.map((e) => [e.tag, e.role, e.name]),
    [
      ["button", "button", "Add to cart"],
      ["a", "link", "About"],
      ["input", "textbox", "Email"],
      ["select", "combobox", "Color"],
      ["textarea", "textbox", "Notes"],
      ["div", "button", "Fancy"],
    ],
  );
  for (const e of els) {
    assert.equal(e.locator.strategy, "role");
    assert.equal(e.locator.nth, 0);
    assert.equal(e.disabled, false);
  }
  assert.deepEqual(els.map((e) => e.editable), [false, false, true, true, true, false]);
  assert.deepEqual(els[0].locator, { strategy: "role", role: "button", name: "Add to cart", nth: 0 });
});

test("filters hidden, disabled, and input[type=hidden] elements", async () => {
  await page.setContent(`
    <button style="display:none">Hidden</button>
    <button disabled>Disabled</button>
    <div style="visibility:hidden"><button>InvisibleParent</button></div>
    <input type="hidden" name="x">
    <fieldset disabled><button>InFieldset</button></fieldset>
    <button aria-disabled="true">AriaDisabled</button>
    <button>Visible</button>
  `);
  const els = await enumerateElements(page);
  assert.deepEqual(els.map((e) => e.name), ["Visible"]);
});

test("duplicate role+name gets increasing nth, counting ARIA-visible disabled elements", async () => {
  await page.setContent(`
    <button>Buy</button>
    <button disabled>Buy</button>
    <button>Buy</button>
  `);
  const els = await enumerateElements(page);
  // disabled button is excluded from the table but still occupies a getByRole slot
  assert.equal(els.length, 2);
  assert.deepEqual(els.map((e) => e.locator.nth), [0, 2]);
  // round-trip: locator descriptors must resolve back to the same elements
  await els.reduce(async (prev, e) => {
    await prev;
    const loc = page.getByRole(e.locator.role, { name: e.locator.name, exact: true }).nth(e.locator.nth);
    assert.equal(await loc.isDisabled(), false);
  }, Promise.resolve());
});

test("nameless elements fall back to a unique css path (id shortcut when available)", async () => {
  await page.setContent(`
    <div><input type="text"></div>
    <input id="q" type="text">
  `);
  const els = await enumerateElements(page);
  assert.equal(els.length, 2);
  assert.equal(els[0].locator.strategy, "css");
  assert.equal(els[1].locator.strategy, "css");
  assert.equal(els[1].locator.css, "#q");
  // each computed css path must be unique on the page
  for (const e of els) {
    assert.equal(await page.locator(e.locator.css).count(), 1, e.locator.css);
  }
});

test("caps at max (default 30)", async () => {
  const buttons = Array.from({ length: 40 }, (_, i) => `<button>B${i}</button>`).join("");
  await page.setContent(`<div>${buttons}</div>`);
  assert.equal((await enumerateElements(page)).length, 30);
  const five = await enumerateElements(page, 5);
  assert.equal(five.length, 5);
  assert.deepEqual(five.map((e) => e.name), ["B0", "B1", "B2", "B3", "B4"]);
});

test("dedupes elements matching multiple selector branches", async () => {
  await page.setContent(`<button role="button">Once</button>`);
  const els = await enumerateElements(page);
  assert.equal(els.length, 1);
});

test("accessible name preference: aria-label beats text; label beats placeholder", async () => {
  await page.setContent(`
    <button aria-label="Close">×</button>
    <label for="em">Work email</label><input id="em" type="email" placeholder="you@example.com">
  `);
  const els = await enumerateElements(page);
  assert.deepEqual(
    els.map((e) => [e.role, e.name]),
    [
      ["button", "Close"],
      ["textbox", "Work email"],
    ],
  );
});

// --- fixes: false-positive review 2026-07-04 (NS-001 recorder accname case) ---

test("CSS text-transform:uppercase label keeps DOM casing (getByRole round-trips)", async () => {
  // hernudge's .field-label renders "Your name" as "YOUR NAME" (text-transform).
  // innerText is CSS-rendered, so the old innerText||textContent path recorded
  // "YOUR NAME" — but getByRole matches the spec accname from DOM text, so the
  // replay locator getByRole('textbox', {name:'YOUR NAME', exact:true}) timed
  // out, the form submitted empty, and the server's correct 400 got mis-filed.
  await page.setContent(`
    <style>.field-label { text-transform: uppercase; }</style>
    <label class="field-label" for="nm">Your name</label>
    <input id="nm" type="text">
  `);
  const els = await enumerateElements(page);
  assert.equal(els.length, 1);
  assert.equal(els[0].name, "Your name", "recorded name must be DOM case, not the CSS-rendered 'YOUR NAME'");
  // round-trip: the recorded name resolves the input via the spec accname
  const loc = page.getByRole("textbox", { name: els[0].name, exact: true });
  assert.equal(await loc.count(), 1);
  await loc.fill("x");
  assert.equal(await page.locator("#nm").inputValue(), "x");
});

test("button styled uppercase keeps DOM casing in its accessible name", async () => {
  // buttons take the element-text fallback path (not the label path) — the
  // domText helper must apply there too.
  await page.setContent(`
    <style>button { text-transform: uppercase; }</style>
    <button>Save changes</button>
  `);
  const els = await enumerateElements(page);
  assert.equal(els.length, 1);
  assert.equal(els[0].name, "Save changes");
  assert.equal(await page.getByRole("button", { name: "Save changes", exact: true }).count(), 1);
});

test("hidden-content still excluded when the difference is NOT case-only", async () => {
  // A display:none span inside the label changes the text beyond case, so the
  // case-only shortcut does NOT fire — innerText (hidden-content filtered) wins,
  // matching the spec accname, which drops the hidden "SECRET".
  await page.setContent(`
    <label for="e2">Work email <span style="display:none">SECRET</span></label>
    <input id="e2" type="email">
  `);
  const els = await enumerateElements(page);
  assert.equal(els.length, 1);
  assert.equal(els[0].name, "Work email", "display:none text must be excluded (innerText path)");
});

test("a navigation racing page.evaluate degrades to an empty table, never throws", async () => {
  // "Execution context was destroyed, most likely because of a navigation" —
  // the one per-turn page call that used to escape every try/catch and kill
  // the whole session (and, overnight, discard all candidates found so far).
  const stubPage = {
    evaluate: async () => {
      throw new Error("Execution context was destroyed, most likely because of a navigation");
    },
  };
  assert.deepEqual(await enumerateElements(stubPage), []);
});
