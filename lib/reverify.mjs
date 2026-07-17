// lib/reverify.mjs — fresh-context deterministic replay + verdicts (the moat).
// reverifyFinding(finding, {config, log}) -> Finding. The LLM is never in the
// loop: each replay runs in a fresh browser context through the SAME
// executeStep path that recorded the trace, with oracles attached, then a
// fixed 2s end grace and one final oracle/check pass. Verdict per replay:
// "reproduced" | "not-reproduced" | "replay-broken". Status: reproduced >=
// requiredPasses -> confirmed (oracle signature) or text-verified (semantic
// text-present/text-absent check — proves only that a substring was/wasn't
// present, not ordering/counts/correctness); some -> flaky; zero ->
// unconfirmed; all replay-broken -> unverifiable.
//
// Control replay (text-present false-positive guard): a brain-proposed
// text-present check can name text that is ALWAYS on the page (a headline/CTA).
// Such a check "reproduces" on any healthy load, so an interaction trace alone
// proves nothing. When a text-present finding reproduces AND its trace has real
// interactions, we replay ONLY the navigation steps (goto/back) through the
// same path; if the text is present without any interaction it is static page
// copy, not evidence the interaction caused a bug -> verdict "control-matched",
// finding NOT confirmed. Goto-only traces skip the control (it would equal the
// replay; a bug visible on plain load must still confirm).

import { chromium } from "playwright";
import { executeStep } from "./trace.mjs";
import { attachOracles } from "./oracles.mjs";
import { buildSignature, signaturesMatch } from "./signature.mjs";
import { enumerateElements } from "./elements.mjs";
import { elementSignature, signatureKey } from "./census.mjs";

// Fixed end grace before the final oracle/check pass: slow responses must not
// decide verdicts.
const GRACE_MS = 2000;
const CHECK_TIMEOUT_MS = 3000;

const defaultLog = (level, message) => console.error("[" + level + "] " + message);

export async function reverifyFinding(finding, { config, log = defaultLog }) {
  const { replays, requiredPasses, navTimeoutMs } = config.reverify;

  // Expected-element census finding: its "signature" is structural, not an
  // oracle event or a text check, so it gets its own LLM-free replay — fresh
  // context, goto route, resize to the viewport class, re-enumerate, and if the
  // baseline element is still absent from the visible interactive set it
  // reproduced. Same reproduced>=requiredPasses -> confirmed gate as any oracle.
  if (finding.source === "oracle:expected-element") {
    return await reverifyExpectedElement(finding, { config, log });
  }

  const semantic = finding.source === "brain:semantic";

  // No deterministic assertion (checkless semantic flag or an empty trace):
  // unverifiable by definition — never presented as confirmed.
  const replayable =
    Array.isArray(finding.trace) &&
    finding.trace.length > 0 &&
    (semantic ? isCheck(finding.check) : typeof finding.signature === "string" && finding.signature.length > 0);
  if (!replayable) {
    log("info", finding.id + ": no deterministic assertion to replay — unverifiable");
    return finalize(finding, finding.trace ?? [], [], { minimized: false, excerpt: null, requiredPasses, forceStatus: "unverifiable" });
  }

  const origin = new URL(config.target.url).origin;
  const opts = { origin, oraclesConfig: config.oracles, navTimeoutMs, semantic };
  const browser = await chromium.launch({ headless: true });
  let trace = finding.trace;
  let minimized = false;
  const verdicts = [];
  let excerpt = null;
  try {
    // Minimization (v1, deterministic): the shortest suffix starting at the
    // most recent goto; adopt it only if it reproduces once on its own.
    const suffix = suffixFromLastGoto(finding.trace);
    if (suffix) {
      const probe = await replayOnce(browser, suffix, finding, opts);
      if (probe.verdict === "reproduced") {
        trace = suffix;
        minimized = true;
        log("info", finding.id + ": minimized trace " + finding.trace.length + " -> " + suffix.length + " step(s)");
      }
    }

    for (let n = 0; n < replays; n++) {
      const result = await replayOnce(browser, trace, finding, opts);
      verdicts.push(result.verdict);
      if (excerpt == null && result.excerpt != null) excerpt = result.excerpt;
      log("info", finding.id + ": replay " + (n + 1) + "/" + replays + " -> " + result.verdict);
    }

    // Control replay: only for a text-present semantic finding that reproduced
    // AND whose trace carries interactions — replay nav-only steps and, if the
    // check still matches, the text is static page copy (present without any
    // interaction). Rewrite the reproduced verdicts to "control-matched" so the
    // finding cannot be presented as confirmed.
    if (
      semantic &&
      finding.check?.kind === "text-present" &&
      verdicts.some((v) => v === "reproduced") &&
      hasInteraction(trace)
    ) {
      const control = await replayControl(browser, trace, finding, opts);
      if (control) {
        for (let i = 0; i < verdicts.length; i++) {
          if (verdicts[i] === "reproduced") verdicts[i] = "control-matched";
        }
        excerpt = null; // the excerpt would misleadingly cite static copy
        log("info", finding.id + ": control-matched — check text present without interactions (static page copy)");
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return finalize(finding, trace, verdicts, { minimized, excerpt, requiredPasses });
}

// Expected-element census reverify. Each replay: fresh context, set the
// viewport class, goto route, re-enumerate (reusing lib/elements.mjs), and
// check whether the baseline element's key is still present in the visible
// interactive set. Absent -> "reproduced" (still missing/invisible). A failed
// goto -> "replay-broken". No minimization, no control replay — a structural
// disappearance is the full claim.
async function reverifyExpectedElement(finding, { config, log }) {
  const { replays, requiredPasses, navTimeoutMs } = config.reverify;
  const census = finding.census;
  const replayable =
    census && census.route && census.viewport && census.element && Array.isArray(finding.trace) && finding.trace.length > 0;
  if (!replayable) {
    log("info", finding.id + ": expected-element finding has no census payload — unverifiable");
    return finalize(finding, finding.trace ?? [], [], { minimized: false, excerpt: null, requiredPasses, forceStatus: "unverifiable" });
  }

  const targetKey = signatureKey(census.element);
  const ignoreSelectors = Array.isArray(census.ignoreSelectors) ? census.ignoreSelectors : [];
  const max = Number.isFinite(census.max) ? census.max : Infinity;
  const browser = await chromium.launch({ headless: true });
  const verdicts = [];
  try {
    for (let n = 0; n < replays; n++) {
      const verdict = await replayCensusOnce(browser, {
        route: census.route,
        viewport: census.viewport,
        targetKey,
        ignoreSelectors,
        max,
        navTimeoutMs,
      });
      verdicts.push(verdict);
      log("info", finding.id + ": census replay " + (n + 1) + "/" + replays + " -> " + verdict);
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return finalize(finding, finding.trace, verdicts, { minimized: false, excerpt: null, requiredPasses });
}

async function replayCensusOnce(browser, { route, viewport, targetKey, ignoreSelectors, max, navTimeoutMs }) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    try {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    } catch {
      // a context that refuses a resize is broken; the goto below will confirm
    }
    const res = await executeStep(page, { kind: "goto", value: route }, { navTimeoutMs });
    if (!res.ok) return "replay-broken";
    let keys;
    try {
      const els = await enumerateElements(page, max, ignoreSelectors);
      keys = new Set(els.map((e) => signatureKey(elementSignature(e))));
    } catch {
      return "replay-broken";
    }
    return keys.has(targetKey) ? "not-reproduced" : "reproduced";
  } finally {
    await context.close().catch(() => {});
  }
}

// One deterministic replay in a fresh context. Returns {verdict, excerpt}.
async function replayOnce(browser, trace, finding, { origin, oraclesConfig, navTimeoutMs, semantic }) {
  const context = await browser.newContext();
  // Pinned two-option attach — no navAllowList: every nav in a recorded trace
  // came from the recording, so recorded dead-links must be able to reproduce.
  const oracles = attachOracles(context, { origin, oraclesConfig });
  try {
    const page = await context.newPage();
    let broken = false;
    for (const step of trace) {
      oracles.setStep(step.i);
      const res = await executeStep(page, step, { navTimeoutMs });
      // A step that failed at record time may BE the bug (e.g. nav-failure).
      // "broken" means a step that recorded ok no longer executes.
      if (!res.ok && step.ok !== false) {
        broken = true;
        break;
      }
    }
    try {
      await page.waitForTimeout(GRACE_MS);
    } catch {
      // page/context died during grace — the oracle events still decide
    }

    let reproduced = false;
    let excerpt = null;
    if (semantic) {
      const res = await evaluateCheck(page, finding.check);
      reproduced = res.reproduced;
      excerpt = res.excerpt;
    } else {
      reproduced = oracles.events.some((event) => {
        try {
          return signaturesMatch(buildSignature(event), finding.signature);
        } catch {
          return false;
        }
      });
    }
    // A reproduce outranks a broken step: the failure demonstrably recurred.
    if (reproduced) return { verdict: "reproduced", excerpt };
    return { verdict: broken ? "replay-broken" : "not-reproduced", excerpt: null };
  } finally {
    oracles.dispose();
    await context.close().catch(() => {});
  }
}

// True when the trace contains a step that is not pure navigation — a real
// interaction (fill/click/select/press) whose effect the control must strip.
function hasInteraction(trace) {
  return trace.some((s) => s.kind !== "goto" && s.kind !== "back");
}

// Nav-only control: fresh context (same opts as a replay), execute ONLY the
// trace's goto/back steps through the same executeStep path, settle the same
// way, then evaluateCheck. Returns true iff the text-present check matches
// WITHOUT any interaction — i.e. it is static page copy. A broken nav step (or
// a page that dies) yields false: only a positive match downgrades the finding.
async function replayControl(browser, trace, finding, { origin, oraclesConfig, navTimeoutMs }) {
  const context = await browser.newContext();
  const oracles = attachOracles(context, { origin, oraclesConfig });
  try {
    const page = await context.newPage();
    for (const step of trace) {
      if (step.kind !== "goto" && step.kind !== "back") continue;
      const res = await executeStep(page, step, { navTimeoutMs });
      if (!res.ok && step.ok !== false) return false; // control couldn't navigate — inconclusive
    }
    try {
      await page.waitForTimeout(GRACE_MS);
    } catch {
      // page/context died during grace — treat as inconclusive below
    }
    const res = await evaluateCheck(page, finding.check);
    return res.reproduced;
  } catch {
    return false;
  } finally {
    oracles.dispose();
    await context.close().catch(() => {});
  }
}

// Semantic check semantics (pinned): case-SENSITIVE substring match on the
// innerText of the selector's element (whole body when selector is null);
// the matched excerpt ±80 chars is recorded as evidence.
async function evaluateCheck(page, check) {
  let text = "";
  let resolved = true;
  try {
    const target = check.selector ? page.locator(check.selector).first() : page.locator("body");
    text = await target.innerText({ timeout: CHECK_TIMEOUT_MS });
  } catch {
    resolved = false; // selector matched nothing (or the page died)
    text = "";
  }
  // A selector that resolves nothing proves nothing: without this, ANY
  // text-absent check whose selector never matches (brain typo, renamed
  // element, late render) is vacuously "reproduced" on a healthy page.
  // Absence-of-element bugs must be flagged with selector:null (body scope).
  if (!resolved && check.selector) {
    return { reproduced: false, excerpt: null };
  }
  const idx = text.indexOf(check.text);
  const found = idx !== -1;
  const reproduced = check.kind === "text-absent" ? !found : found;
  const excerpt =
    reproduced && found ? text.slice(Math.max(0, idx - 80), idx + check.text.length + 80) : null;
  return { reproduced, excerpt };
}

// Shortest suffix starting at the most recent goto, renumbered from 0 so the
// minimized trace stands alone. null when there is nothing to cut.
function suffixFromLastGoto(trace) {
  let last = -1;
  for (let i = 0; i < trace.length; i++) {
    if (trace[i].kind === "goto") last = i;
  }
  if (last <= 0) return null;
  return trace.slice(last).map((step, i) => ({ ...step, i }));
}

function isCheck(check) {
  return (
    check !== null &&
    typeof check === "object" &&
    (check.kind === "text-present" || check.kind === "text-absent") &&
    typeof check.text === "string" &&
    check.text.length > 0
  );
}

// A text-present/text-absent assertion only proves a substring was (or was
// not) found in innerText at one instant — it says nothing about ordering,
// counts, or correctness beyond that. Such semantic findings get their own
// tier ("text-verified") instead of "confirmed", which is reserved for
// deterministic oracle signatures (page-error, network-5xx, etc.) whose
// signature match IS the full claim.
function statusFor(verdicts, requiredPasses, textOnly) {
  const reproduced = verdicts.filter((v) => v === "reproduced").length;
  if (reproduced >= requiredPasses) return textOnly ? "text-verified" : "confirmed";
  if (reproduced > 0) return "flaky";
  if (verdicts.length > 0 && verdicts.every((v) => v === "replay-broken")) return "unverifiable";
  return "unconfirmed";
}

function finalize(finding, trace, verdicts, { minimized, excerpt, requiredPasses, forceStatus = null }) {
  const reproduced = verdicts.filter((v) => v === "reproduced").length;
  const textOnly = finding.source === "brain:semantic" && isCheck(finding.check);
  const status = forceStatus ?? statusFor(verdicts, requiredPasses, textOnly);
  const evidence = excerpt != null ? { ...(finding.evidence ?? {}), excerpt } : finding.evidence;
  return {
    ...finding,
    trace,
    status,
    evidence,
    reverify: {
      replays: verdicts.length,
      reproduced,
      verdicts,
      minimized,
      // the report layer writes <runDir>/repro/<id>.mjs and fills this in
      reproScript: finding.reverify?.reproScript ?? null,
    },
  };
}
