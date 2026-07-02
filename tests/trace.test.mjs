// tests/trace.test.mjs — hermetic: chromium + setContent + in-test http server on port 0.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";
import { resolveLocator, executeStep, performStep } from "../lib/trace.mjs";
import { executeAction } from "../lib/explorer.mjs";
import { enumerateElements } from "../lib/elements.mjs";

let browser;
let page;
let server;
let origin;

before(async () => {
  browser = await chromium.launch({ headless: true });
  page = await (await browser.newContext()).newPage();
  server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<html><title>${req.url}</title><body><h1>${req.url}</h1><a href="/b">to b</a></body></html>`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = "http://127.0.0.1:" + server.address().port;
});

after(async () => {
  await browser.close();
  await new Promise((r) => server.close(r));
});

test("resolveLocator: role strategy with nth picks the right duplicate", async () => {
  await page.setContent(`
    <button onclick="window.__hit='first'">Buy</button>
    <button onclick="window.__hit='second'">Buy</button>
  `);
  await resolveLocator(page, { strategy: "role", role: "button", name: "Buy", nth: 1 }).click();
  assert.equal(await page.evaluate(() => window.__hit), "second");
});

test("resolveLocator: text and css strategies", async () => {
  await page.setContent(`<p id="para">hello world</p>`);
  const byText = resolveLocator(page, { strategy: "text", text: "hello world", nth: 0 });
  assert.equal(await byText.getAttribute("id"), "para");
  const byCss = resolveLocator(page, { strategy: "css", css: "#para", nth: 0 });
  assert.equal(await byCss.innerText(), "hello world");
});

test("resolveLocator: unknown strategy and invalid locator throw", () => {
  assert.throws(() => resolveLocator(page, { strategy: "xpath", css: "x" }), /unknown locator strategy/);
  assert.throws(() => resolveLocator(page, null), /invalid locator/);
});

test("executeStep: successful click settles and reports {ok, error, settle}", async () => {
  await page.setContent(`<button onclick="window.__clicked=true">Go</button>`);
  const res = await executeStep(page, {
    kind: "click",
    locator: { strategy: "role", role: "button", name: "Go", nth: 0 },
    value: null,
  });
  assert.equal(res.ok, true);
  assert.equal(res.error, null);
  assert.equal(await page.evaluate(() => window.__clicked), true);
  assert.ok(["networkidle", "timeout"].includes(res.settle.condition));
  assert.ok(res.settle.waitedMs >= 0 && res.settle.waitedMs <= 1600, String(res.settle.waitedMs));
});

test("executeStep: replay waits AT LEAST the recorded settle waitedMs", async () => {
  await page.setContent(`<button onclick="window.__clicked=true">Go</button>`);
  const t0 = Date.now();
  const res = await executeStep(page, {
    kind: "click",
    locator: { strategy: "role", role: "button", name: "Go", nth: 0 },
    value: null,
    settle: { condition: "networkidle", waitedMs: 400 },
  });
  const elapsed = Date.now() - t0;
  assert.equal(res.ok, true);
  assert.ok(res.settle.waitedMs >= 400, "settle.waitedMs=" + res.settle.waitedMs);
  assert.ok(elapsed >= 400, "elapsed=" + elapsed);
});

test("executeStep: missing element fails after the 5s action timeout without throwing", async () => {
  await page.setContent(`<p>nothing to click</p>`);
  const t0 = Date.now();
  const res = await executeStep(page, {
    kind: "click",
    locator: { strategy: "css", css: "#does-not-exist", nth: 0 },
    value: null,
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /Timeout/i);
  assert.ok(Date.now() - t0 >= 4900, "should have waited the 5s action timeout");
  assert.ok(res.settle, "settle recorded even on failure");
});

test("executeStep: unknown kind fails fast, never throws", async () => {
  const res = await executeStep(page, { kind: "hover", locator: null, value: null });
  assert.equal(res.ok, false);
  assert.match(res.error, /unknown step kind/);
});

test("executeStep: unreachable goto records the failure", async () => {
  const res = await executeStep(page, { kind: "goto", locator: null, value: "http://127.0.0.1:9/" }, { navTimeoutMs: 3000 });
  assert.equal(res.ok, false);
  assert.ok(res.error.length > 0);
});

test("performStep builds a full TraceStep for goto and back", async () => {
  const stepA = await performStep(page, { i: 0, kind: "goto", value: origin + "/a" });
  assert.deepEqual(Object.keys(stepA).sort(), ["error", "i", "kind", "locator", "ok", "postUrl", "settle", "tMs", "url", "value"].sort());
  assert.equal(stepA.i, 0);
  assert.equal(stepA.ok, true);
  assert.equal(stepA.locator, null);
  assert.equal(stepA.value, origin + "/a");
  assert.equal(stepA.postUrl, origin + "/a");
  assert.ok(Number.isFinite(stepA.tMs));

  const stepB = await performStep(page, { i: 1, kind: "goto", value: origin + "/b" });
  assert.equal(stepB.url, origin + "/a", "url is the page URL before the step");
  assert.equal(stepB.postUrl, origin + "/b");

  const stepBack = await performStep(page, { i: 2, kind: "back" });
  assert.equal(stepBack.ok, true);
  assert.equal(stepBack.postUrl, origin + "/a");
  assert.equal(stepBack.value, origin + "/a", "back records the landed URL as value");
});

test("performStep: fill and press go through the shared path", async () => {
  await page.goto(origin + "/form");
  await page.setContent(`<input aria-label="Name"><div id="out"></div>
    <script>document.querySelector('input').addEventListener('keydown', e => {
      if (e.key === 'Enter') document.getElementById('out').textContent = 'submitted:' + e.target.value;
    });</script>`);
  const locator = { strategy: "role", role: "textbox", name: "Name", nth: 0 };
  const fillStep = await performStep(page, { i: 1, kind: "fill", locator, value: "karthik" });
  assert.equal(fillStep.ok, true);
  const pressStep = await performStep(page, { i: 2, kind: "press", locator, value: "Enter" });
  assert.equal(pressStep.ok, true);
  assert.equal(await page.locator("#out").innerText(), "submitted:karthik");
});

test("executeAction: maps elementId to locator, records failures, guards cross-origin goto", async () => {
  await page.goto(origin + "/actions");
  await page.setContent(`<button onclick="window.__n=(window.__n||0)+1">Tap</button>`);
  const elements = await enumerateElements(page);

  const clickStep = await executeAction(page, { kind: "click", elementId: 0 }, elements);
  assert.equal(clickStep.ok, true);
  assert.equal(clickStep.kind, "click");
  assert.deepEqual(clickStep.locator, elements[0].locator);
  assert.equal(await page.evaluate(() => window.__n), 1);

  const badId = await executeAction(page, { kind: "click", elementId: 99 }, elements);
  assert.equal(badId.ok, false);
  assert.match(badId.error, /unknown elementId/);
  assert.equal(badId.tMs, 0, "rejected before touching the page");

  const crossOrigin = await executeAction(page, { kind: "goto", url: "http://example.com/x" }, elements);
  assert.equal(crossOrigin.ok, false);
  assert.match(crossOrigin.error, /goto blocked/);

  const relative = await executeAction(page, { kind: "goto", url: "/b" }, elements);
  assert.equal(relative.ok, true);
  assert.equal(relative.value, origin + "/b", "relative goto resolved to absolute same-origin URL");
  assert.equal(relative.postUrl, origin + "/b");

  const unknown = await executeAction(page, { kind: "dance" }, elements);
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /unknown action kind/);
});

test("executeAction: goto guard validates against the TARGET origin, not a foreign current page", async () => {
  // After a click on an external anchor the page itself is off-origin. Judged
  // by the page's origin, "/foo" would roam DEEPER into the foreign site while
  // the absolute goto back to the app would be refused as "cross-origin".
  const gotoCalls = [];
  const stubPage = {
    url: () => "https://accounts.google.com/signin",
    goto: async (u) => void gotoCalls.push(u),
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
  };
  const targetOrigin = "http://127.0.0.1:3000";

  const roam = await executeAction(stubPage, { kind: "goto", url: "/foo" }, [], { origin: targetOrigin });
  assert.equal(roam.ok, true, "relative goto resolves against the TARGET origin, not the foreign page");
  assert.deepEqual(gotoCalls, [targetOrigin + "/foo"], "must navigate back into the app under test");
  gotoCalls.length = 0;

  const foreignAbs = await executeAction(
    stubPage,
    { kind: "goto", url: "https://accounts.google.com/deeper" },
    [],
    { origin: targetOrigin },
  );
  assert.equal(foreignAbs.ok, false, "roaming deeper into the foreign site must be blocked");
  assert.match(foreignAbs.error, /goto blocked/);
  assert.deepEqual(gotoCalls, []);

  const home = await executeAction(stubPage, { kind: "goto", url: targetOrigin + "/" }, [], { origin: targetOrigin });
  assert.equal(home.ok, true, "the one goto that returns to the app under test must pass");
  assert.deepEqual(gotoCalls, [targetOrigin + "/"], "absolute same-target goto navigates home");

  // and with the page ON-origin, relative paths still resolve against the page
  const onOriginPage = { ...stubPage, url: () => targetOrigin + "/shop" };
  const rel = await executeAction(onOriginPage, { kind: "goto", url: "/cart" }, [], { origin: targetOrigin });
  assert.equal(rel.ok, true);
  assert.equal(gotoCalls.at(-1), targetOrigin + "/cart");
});
