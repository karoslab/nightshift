// lib/journeys.mjs — deterministic critical-path journeys.
// A journey is a fixed list of selector/url steps run every session with all
// oracles watching. It builds a replayable trace through the SAME executeStep
// path as the explorer (lib/trace.mjs), so a journey finding reverifies and
// generates a repro script exactly like an explorer finding. Two ways a journey
// produces a candidate finding:
//   1. an oracle fires during a step (page-error, network-5xx, dead-link, …) —
//      collected by signature, confirmable on replay; and
//   2. a step's `expect` assertion fails, or a step fails to execute — collected
//      as a semantic finding (text checks are text-verifiable; a bare url/step
//      failure has no mechanical assertion and stays unverifiable, by design).
// Every finding is stamped with the journey name (the collector already stamps
// the role).

import { performStep, safePageUrl } from "./trace.mjs";

const ORACLE_GRACE_MS = 2000;
const CHECK_TIMEOUT_MS = 3000;

// Run every journey on `page` (already in the desired role's context). Findings
// land in `collector`; the caller owns oracle attachment and the run dir.
export async function runJourneys(page, { journeys, origin, collector, oracles, navTimeoutMs = 15000, log = () => {} }) {
  for (const journey of journeys ?? []) {
    await runOne(page, journey, { origin, collector, oracles, navTimeoutMs, log });
  }
}

async function runOne(page, journey, { origin, collector, oracles, navTimeoutMs, log }) {
  log("info", 'journey: running "' + journey.name + '"');
  const before = collector.findings.length;
  const trace = [];

  for (const step of journey.steps) {
    const i = trace.length;
    oracles.setStep(i);
    const executed = await performStep(page, stepSpec(step, i, origin), { navTimeoutMs });
    trace.push(executed);
    await collector.collectOracleFindings(page, trace);

    if (!executed.ok) {
      await collector.collectSemanticFinding(page, trace, {
        title: 'Journey "' + journey.name + '": step ' + (i + 1) + " (" + step.action + ") failed",
        severity: "major",
        expected: "the step executes",
        actual: String(executed.error ?? "step did not execute"),
        check: null,
      });
      // A step that could not run leaves the journey in an undefined state;
      // stop rather than pile on cascading failures from the same root cause.
      break;
    }

    if (step.expect) {
      const failed = await evaluateExpect(page, step.expect);
      if (failed) {
        await collector.collectSemanticFinding(page, trace, rawFindingFor(journey.name, i, failed));
      }
    }
  }

  // Grace + final drain: a slow failing response from the journey's last step
  // must land while this trace is still current (mirrors session end-of-route).
  try {
    await page.waitForTimeout(ORACLE_GRACE_MS);
  } catch {
    // page/context died — drain whatever already arrived
  }
  await collector.collectOracleFindings(page, trace);

  for (const finding of collector.findings.slice(before)) finding.journey = journey.name;
}

// Journey step -> TraceStep spec for lib/trace.mjs. Selector steps resolve
// through the shared "css" locator strategy so replay is byte-identical.
function stepSpec(step, i, origin) {
  switch (step.action) {
    case "goto":
      return { i, kind: "goto", value: new URL(step.url, origin).href };
    case "click":
      return { i, kind: "click", locator: cssLocator(step.selector) };
    case "fill":
      return { i, kind: "fill", locator: cssLocator(step.selector), value: step.value ?? "" };
    case "select":
      return { i, kind: "select", locator: cssLocator(step.selector), value: step.value ?? null };
    case "press":
      return { i, kind: "press", locator: cssLocator(step.selector), value: step.value ?? "Enter" };
    default:
      return { i, kind: step.action };
  }
}

function cssLocator(selector) {
  return { strategy: "css", css: selector, nth: 0 };
}

// Returns the first failing assertion (or null). Text assertions read live
// innerText; a url assertion reads the page url.
async function evaluateExpect(page, expect) {
  if (expect.urlIncludes !== undefined) {
    const url = safePageUrl(page);
    if (!url.includes(expect.urlIncludes)) return { type: "url", expected: expect.urlIncludes, actualUrl: url };
  }
  if (expect.textPresent !== undefined) {
    const { present } = await readText(page, expect.selector ?? null, expect.textPresent);
    if (!present) return { type: "textPresent", text: expect.textPresent, selector: expect.selector ?? null };
  }
  if (expect.textAbsent !== undefined) {
    const { present } = await readText(page, expect.selector ?? null, expect.textAbsent);
    if (present) return { type: "textAbsent", text: expect.textAbsent, selector: expect.selector ?? null };
  }
  return null;
}

async function readText(page, selector, needle) {
  try {
    const loc = selector ? page.locator(selector).first() : page.locator("body");
    const content = await loc.innerText({ timeout: CHECK_TIMEOUT_MS });
    return { present: content.includes(needle) };
  } catch {
    return { present: false };
  }
}

// Turn a failed assertion into a raw semantic finding. A failed textPresent
// becomes a text-ABSENT check (the reproducible fact is that the text is
// missing); a failed textAbsent becomes a text-PRESENT check. A url mismatch
// has no page-text assertion, so it stays checkless -> unverifiable.
function rawFindingFor(journeyName, stepIndex, failed) {
  const where = 'Journey "' + journeyName + '": step ' + (stepIndex + 1);
  if (failed.type === "textPresent") {
    return {
      title: where + ' expected text "' + failed.text + '" but it was not found',
      severity: "major",
      expected: 'text "' + failed.text + '" present',
      actual: 'text "' + failed.text + '" absent',
      check: { kind: "text-absent", selector: failed.selector, text: failed.text },
    };
  }
  if (failed.type === "textAbsent") {
    return {
      title: where + ' expected text "' + failed.text + '" to be absent but it was present',
      severity: "major",
      expected: 'text "' + failed.text + '" absent',
      actual: 'text "' + failed.text + '" present',
      check: { kind: "text-present", selector: failed.selector, text: failed.text },
    };
  }
  return {
    title: where + ' expected the URL to include "' + failed.expected + '"',
    severity: "major",
    expected: 'URL includes "' + failed.expected + '"',
    actual: "URL is " + failed.actualUrl,
    check: null,
  };
}
