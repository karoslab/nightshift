// lib/reverify.mjs — fresh-context deterministic replay + verdicts (the moat).
// reverifyFinding(finding, {config, log}) -> Finding. The LLM is never in the
// loop: each replay runs in a fresh browser context through the SAME
// executeStep path that recorded the trace, with oracles attached, then a
// fixed 2s end grace and one final oracle/check pass. Verdict per replay:
// "reproduced" | "not-reproduced" | "replay-broken". Status: reproduced >=
// requiredPasses -> confirmed; some -> flaky; zero -> unconfirmed; all
// replay-broken -> unverifiable.

import { chromium } from "playwright";
import { executeStep } from "./trace.mjs";
import { attachOracles } from "./oracles.mjs";
import { buildSignature, signaturesMatch } from "./signature.mjs";

// Fixed end grace before the final oracle/check pass: slow responses must not
// decide verdicts.
const GRACE_MS = 2000;
const CHECK_TIMEOUT_MS = 3000;

const defaultLog = (level, message) => console.error("[" + level + "] " + message);

export async function reverifyFinding(finding, { config, log = defaultLog }) {
  const { replays, requiredPasses, navTimeoutMs } = config.reverify;
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
  } finally {
    await browser.close().catch(() => {});
  }
  return finalize(finding, trace, verdicts, { minimized, excerpt, requiredPasses });
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

// Semantic check semantics (pinned): case-SENSITIVE substring match on the
// innerText of the selector's element (whole body when selector is null);
// the matched excerpt ±80 chars is recorded as evidence.
async function evaluateCheck(page, check) {
  let text = "";
  try {
    const target = check.selector ? page.locator(check.selector).first() : page.locator("body");
    text = await target.innerText({ timeout: CHECK_TIMEOUT_MS });
  } catch {
    text = ""; // element gone reads as empty text: text-present fails, text-absent holds
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

function statusFor(verdicts, requiredPasses) {
  const reproduced = verdicts.filter((v) => v === "reproduced").length;
  if (reproduced >= requiredPasses) return "confirmed";
  if (reproduced > 0) return "flaky";
  if (verdicts.length > 0 && verdicts.every((v) => v === "replay-broken")) return "unverifiable";
  return "unconfirmed";
}

function finalize(finding, trace, verdicts, { minimized, excerpt, requiredPasses, forceStatus = null }) {
  const reproduced = verdicts.filter((v) => v === "reproduced").length;
  const status = forceStatus ?? statusFor(verdicts, requiredPasses);
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
