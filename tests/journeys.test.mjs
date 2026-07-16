// tests/journeys.test.mjs — lib/journeys.mjs against the bundled demo-app.
// A passing journey files nothing; a seeded-broken journey files a candidate
// that reverify CONFIRMS in a fresh context. Hermetic: demo-app on port 0, no
// brain, no external network.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { runJourneys } from "../lib/journeys.mjs";
import { attachOracles } from "../lib/oracles.mjs";
import { createFindingCollector } from "../lib/collector.mjs";
import { createIdMinter } from "../lib/session.mjs";
import { reverifyFinding } from "../lib/reverify.mjs";
import { startBugbox } from "../demo-app/server.mjs";

let bugbox;
let origin;
let browser;

before(async () => {
  bugbox = await startBugbox(0);
  origin = `http://127.0.0.1:${bugbox.port}`;
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  await bugbox?.close();
});

const quiet = () => {};

function makeConfig() {
  return {
    target: { url: origin },
    oracles: { expectedStatuses: [401, 403], ignoreConsole: [] },
    reverify: { replays: 2, requiredPasses: 2, navTimeoutMs: 10000 },
  };
}

function tmpRunDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ns-journeys-"));
  fs.mkdirSync(path.join(dir, "shots"), { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Attach oracles + a collector to a fresh context, run the journeys, return the
// candidate findings.
async function runInContext(t, journeys, { tag } = {}) {
  const runDir = tmpRunDir(t);
  const context = await browser.newContext();
  const oracles = attachOracles(context, { origin, oraclesConfig: { expectedStatuses: [401, 403], ignoreConsole: [] } });
  const collector = createFindingCollector({
    oracles,
    consoleTail: [],
    runDir,
    log: quiet,
    mintId: createIdMinter(),
    tag: tag ?? {},
  });
  try {
    const page = await context.newPage();
    await runJourneys(page, { journeys, origin, collector, oracles, navTimeoutMs: 10000, log: quiet });
  } finally {
    oracles.dispose();
    await context.close();
  }
  return collector.findings;
}

test("a passing journey files no findings", { timeout: 60_000 }, async (t) => {
  const journeys = [
    {
      name: "shop is open",
      steps: [
        { action: "goto", url: "/", expect: { textPresent: "A tiny shop" } },
        { action: "click", selector: "#choose-color", expect: { textPresent: "Color:" } },
      ],
    },
  ];
  const findings = await runInContext(t, journeys);
  assert.deepEqual(findings, [], JSON.stringify(findings.map((f) => f.title)));
});

test("a seeded-broken journey files a candidate that reverify CONFIRMS", { timeout: 120_000 }, async (t) => {
  // Reaches Bugbox's gated TypeError (Add to cart after Choose color) via a
  // fixed journey — an oracle (page-error) fires and is collected.
  const journeys = [
    {
      name: "add a colored item to the cart",
      steps: [
        { action: "goto", url: "/" },
        { action: "click", selector: "#choose-color" },
        { action: "click", selector: "#add-to-cart", expect: { textPresent: "Items in cart" } },
      ],
    },
  ];
  const findings = await runInContext(t, journeys, { tag: { role: "anonymous" } });

  const pageError = findings.find((f) => f.source === "oracle:page-error");
  assert.ok(pageError, "the journey must file a page-error candidate: " + JSON.stringify(findings.map((f) => [f.source, f.title])));
  assert.equal(pageError.journey, "add a colored item to the cart", "the finding must be tagged with the journey name");
  assert.equal(pageError.role, "anonymous", "the finding must carry the role tag");
  assert.ok(pageError.trace.length >= 3, "the journey trace must include goto + both clicks");

  const verified = await reverifyFinding(pageError, { config: makeConfig(), log: quiet });
  assert.equal(verified.status, "confirmed", "the seeded-broken journey must reverify to confirmed: " + JSON.stringify(verified.reverify));
});

test("a failed expect becomes a text-verified finding", { timeout: 120_000 }, async (t) => {
  // The home page never shows "Order shipped", so an expect for it fails and is
  // recorded as a text-ABSENT check (the reproducible fact: the text is missing).
  const journeys = [
    {
      name: "expect the impossible",
      steps: [{ action: "goto", url: "/", expect: { textPresent: "Order shipped" } }],
    },
  ];
  const findings = await runInContext(t, journeys);
  assert.equal(findings.length, 1, JSON.stringify(findings.map((f) => f.title)));
  assert.equal(findings[0].check.kind, "text-absent");
  assert.equal(findings[0].journey, "expect the impossible");

  const verified = await reverifyFinding(findings[0], { config: makeConfig(), log: quiet });
  assert.equal(verified.status, "text-verified", JSON.stringify(verified.reverify));
});
