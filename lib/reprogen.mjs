// lib/reprogen.mjs — standalone repro script generator (the trust artifact).
// generateReproScript(finding, config) -> string: a self-contained .mjs that
// imports ONLY playwright, replays the recorded trace in a fresh browser
// context, and exits 0 when the failure signature (or semantic check)
// reproduces, 1 when it does not. Buyers attach it to tickets; CI runs it as
// a regression test.
//
// Signature logic is NOT hand-copied: buildSignature/signaturesMatch (pinned
// dependency-free in lib/signature.mjs) and resolveLocator (self-contained in
// lib/trace.mjs) are embedded via Function.prototype.toString(), so the
// script can never disagree with the report's verdict. A parity test asserts
// embedded vs imported behavior is byte-identical.

import { buildSignature, signaturesMatch } from "./signature.mjs";
import { resolveLocator } from "./trace.mjs";
import { isPrefetchRequest } from "./oracles.mjs";

// Sentinels around the embedded signature functions; the parity test slices
// between them. Keep in sync with tests/reprogen.test.mjs.
const EMBED_BEGIN = "// --- begin embedded lib/signature.mjs (do not edit; parity-tested) ---";
const EMBED_END = "// --- end embedded lib/signature.mjs ---";
const EMBED_PREFETCH_BEGIN = "// --- begin embedded lib/oracles.mjs isPrefetchRequest (do not edit; parity-tested) ---";
const EMBED_PREFETCH_END = "// --- end embedded lib/oracles.mjs isPrefetchRequest ---";

export function generateReproScript(finding, config) {
  if (finding === null || typeof finding !== "object") {
    throw new Error("generateReproScript: finding must be an object");
  }
  if (!Array.isArray(finding.trace) || finding.trace.length === 0) {
    throw new Error("generateReproScript: finding.trace is empty — nothing to replay");
  }
  const semantic = finding.source === "brain:semantic";
  if (semantic && (finding.check === null || typeof finding.check !== "object")) {
    throw new Error("generateReproScript: semantic finding " + String(finding.id) + " has no deterministic check");
  }
  if (!semantic && (typeof finding.signature !== "string" || finding.signature.length === 0)) {
    throw new Error("generateReproScript: finding " + String(finding.id) + " has no signature");
  }

  const js = (value) => JSON.stringify(value ?? null, null, 2);
  const oneLine = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const navTimeoutMs = Number.isInteger(config?.reverify?.navTimeoutMs) ? config.reverify.navTimeoutMs : 15000;
  const oraclesConfig = {
    expectedStatuses: config?.oracles?.expectedStatuses ?? [401, 403],
    ignoreConsole: config?.oracles?.ignoreConsole ?? [],
  };
  let fallbackOrigin = null;
  try {
    fallbackOrigin = new URL(config.target.url).origin;
  } catch {
    // trace[0].value supplies the origin at runtime
  }

  return `#!/usr/bin/env node
// NightShift QA repro script — ${oneLine(finding.id)}: ${oneLine(finding.title)}
// Standalone: imports only playwright. Replays the recorded trace in a fresh
// browser context and re-checks the failure ${semantic ? "check" : "signature"} with the LLM out of
// the loop. Exit 0 = bug reproduced, exit 1 = not reproduced.
import { chromium } from "playwright";

const FINDING_ID = ${js(finding.id)};
const SOURCE = ${js(finding.source)};
const SIGNATURE = ${js(finding.signature)};
const CHECK = ${js(finding.check ?? null)};
const TRACE = ${js(finding.trace)};
const ORACLES_CONFIG = ${js(oraclesConfig)};
const FALLBACK_ORIGIN = ${js(fallbackOrigin)};
const NAV_TIMEOUT_MS = ${navTimeoutMs};
const ACTION_TIMEOUT_MS = 5000; // mirrors lib/trace.mjs
const SETTLE_CAP_MS = 1500; // mirrors lib/trace.mjs
const GRACE_MS = 2000; // mirrors lib/reverify.mjs — slow responses must not decide the verdict

${EMBED_BEGIN}
${fnSource(buildSignature)}

${fnSource(signaturesMatch)}
${EMBED_END}

// --- embedded lib/trace.mjs resolveLocator (via Function.toString) ---
${fnSource(resolveLocator)}

${EMBED_PREFETCH_BEGIN}
${fnSource(isPrefetchRequest)}
${EMBED_PREFETCH_END}

// Mirrors lib/oracles.mjs detection + noise filters. No nav allow-list here:
// every navigation in the trace came from the recording, so recorded
// dead-links must be able to reproduce.
function attachOracles(context, origin) {
  const events = [];
  const FETCHY = new Set(["fetch", "xhr"]);
  const ABORT_RE = /net::ERR_ABORTED|NS_BINDING_ABORTED|cancell?ed|frame was detached/i;
  // Chromium network-log console entries bypass the network oracles' filters —
  // dropped here exactly as in lib/oracles.mjs.
  const NETWORK_LOG_RE = /^Failed to load resource:/;
  // A fetch/xhr 400 from an auth endpoint is validation rejection, not a bug
  // (empty signup fields → 400) — suppressed exactly as in lib/oracles.mjs.
  const AUTH_PATH_RE = /(^|\\/)(auth|login|log-in|signin|sign-in|signup|sign-up|register|password|forgot|reset|verify|otp|credentials|session)s?(\\/|$)/i;
  const expected = new Set(ORACLES_CONFIG.expectedStatuses);
  const ignore = ORACLES_CONFIG.ignoreConsole.map((s) => new RegExp(s));
  const push = (oracle, message, url, detail) => events.push({ oracle, message, url, detail });
  const pathnameOf = (u) => {
    try { return new URL(u).pathname; } catch { return String(u); }
  };
  const sameOrigin = (u) => {
    try { return new URL(u).origin === origin; } catch { return false; }
  };
  const pageUrlOf = (page) => {
    try { return page ? page.url() : ""; } catch { return ""; }
  };
  const frameUrlOf = (request) => {
    try { const f = request.frame(); return f ? f.url() : ""; } catch { return ""; }
  };

  context.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (NETWORK_LOG_RE.test(text)) return;
    if (ignore.some((re) => re.test(text))) return;
    // location feeds the console-error signature subject (lib/oracles.mjs parity)
    const loc = typeof msg.location === "function" ? msg.location() : null;
    push("console-error", text, pageUrlOf(msg.page()), loc ? { location: loc.url + ":" + loc.lineNumber } : {});
  });
  context.on("weberror", (webError) => {
    const err = webError.error();
    push("page-error", String(err && err.message ? err.message : err), pageUrlOf(webError.page()), {});
  });
  context.on("requestfailed", (request) => {
    const failure = request.failure();
    const errorText = failure && failure.errorText ? failure.errorText : "request failed";
    if (ABORT_RE.test(errorText)) return;
    const detail = { status: null, method: request.method(), requestUrl: pathnameOf(request.url()) };
    if (request.isNavigationRequest()) {
      push("nav-failure", errorText, request.url(), detail);
      return;
    }
    if (!FETCHY.has(request.resourceType())) return;
    if (isPrefetchRequest(request)) return; // see isPrefetchRequest
    push("request-failed", errorText, frameUrlOf(request), detail);
  });
  context.on("response", (response) => {
    const status = response.status();
    if (status < 400) return;
    if (!sameOrigin(response.url())) return;
    // expected statuses suppress ALL response oracle families (lib/oracles.mjs parity)
    if (expected.has(status)) return;
    const request = response.request();
    const detail = { status, method: request.method(), requestUrl: pathnameOf(response.url()) };
    if (request.isNavigationRequest() && request.resourceType() === "document") {
      push("dead-link", "navigation landed on HTTP " + status, response.url(), detail);
      return;
    }
    if (status >= 500) {
      push("network-5xx", "HTTP " + status + " " + request.method() + " " + detail.requestUrl, frameUrlOf(request), detail);
      return;
    }
    if (!FETCHY.has(request.resourceType())) return;
    // fetch/xhr 400 on an auth endpoint = validation rejection (lib/oracles.mjs parity)
    if (status === 400 && AUTH_PATH_RE.test(pathnameOf(response.url()))) return;
    push("network-4xx", "HTTP " + status + " " + request.method() + " " + detail.requestUrl, frameUrlOf(request), detail);
  });
  return events;
}

// A failed goto leaves a pending chrome-error:// commit that can interrupt
// the next navigation — retry once after it lands (mirrors lib/trace.mjs).
async function gotoWithRetry(page, url) {
  try {
    await page.goto(url, { timeout: NAV_TIMEOUT_MS, waitUntil: "domcontentloaded" });
  } catch (err) {
    if (!/interrupted by another navigation/i.test(String(err && err.message ? err.message : err))) throw err;
    await page.waitForLoadState("domcontentloaded", { timeout: 2000 }).catch(() => {});
    let landed = "";
    try { landed = page.url(); } catch {}
    if (landed === url) return;
    await page.goto(url, { timeout: NAV_TIMEOUT_MS, waitUntil: "domcontentloaded" });
  }
}

async function act(page, step) {
  switch (step.kind) {
    case "goto": return gotoWithRetry(page, step.value);
    case "back": return page.goBack({ timeout: NAV_TIMEOUT_MS, waitUntil: "domcontentloaded" });
    case "click": return resolveLocator(page, step.locator).click({ timeout: ACTION_TIMEOUT_MS });
    case "fill": return resolveLocator(page, step.locator).fill(step.value == null ? "" : step.value, { timeout: ACTION_TIMEOUT_MS });
    case "select": return resolveLocator(page, step.locator).selectOption(step.value, { timeout: ACTION_TIMEOUT_MS });
    case "press": return resolveLocator(page, step.locator).press(step.value, { timeout: ACTION_TIMEOUT_MS });
    default: throw new Error("unknown step kind: " + String(step.kind));
  }
}

// Settle: networkidle or the 1500ms cap, then pad to the recorded floor so
// the replay never observes less of the world than the recording did.
async function settle(page, recorded) {
  const t0 = Date.now();
  try {
    await page.waitForLoadState("networkidle", { timeout: SETTLE_CAP_MS });
  } catch {}
  const observed = Date.now() - t0;
  const floor = recorded && Number.isFinite(recorded.waitedMs) ? recorded.waitedMs : 0;
  if (floor > observed) {
    await page.waitForTimeout(floor - observed).catch(() => {});
  }
}

async function executeStep(page, step) {
  let ok = true;
  try {
    await act(page, step);
  } catch {
    ok = false;
  }
  await settle(page, step.settle || null);
  return ok;
}

// Case-SENSITIVE substring on innerText (whole body when selector is null).
async function evaluateCheck(page, check) {
  let text = "";
  let resolved = true;
  try {
    const target = check.selector ? page.locator(check.selector).first() : page.locator("body");
    text = await target.innerText({ timeout: 3000 });
  } catch {
    resolved = false;
    text = "";
  }
  // an unresolved selector proves nothing — text-absent must not be vacuously
  // "reproduced" on a healthy page (lib/reverify.mjs parity)
  if (!resolved && check.selector) return { reproduced: false, excerpt: null };
  const idx = text.indexOf(check.text);
  const found = idx !== -1;
  const reproduced = check.kind === "text-absent" ? !found : found;
  const excerpt = reproduced && found ? text.slice(Math.max(0, idx - 80), idx + check.text.length + 80) : null;
  return { reproduced, excerpt };
}

async function main() {
  let origin = FALLBACK_ORIGIN;
  try {
    origin = new URL(TRACE[0].value).origin;
  } catch {}
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const events = attachOracles(context, origin);
    const page = await context.newPage();

    let broken = false;
    for (const step of TRACE) {
      const ok = await executeStep(page, step);
      // a step that failed at record time may BE the bug; "broken" means a
      // step that recorded ok no longer executes
      if (!ok && step.ok !== false) {
        console.error("replay broken at step " + step.i + " (" + step.kind + ")");
        broken = true;
        break;
      }
    }
    await page.waitForTimeout(GRACE_MS).catch(() => {});

    let reproduced = false;
    if (SOURCE === "brain:semantic") {
      const res = await evaluateCheck(page, CHECK);
      reproduced = res.reproduced;
      if (res.excerpt) console.error("matched excerpt: " + JSON.stringify(res.excerpt));
      // Control replay (lib/reverify.mjs parity): a text-present check can name
      // text that is ALWAYS on the page (headline/CTA). If it reproduces on a
      // trace with real interactions, replay ONLY the nav steps in a fresh
      // context — if the text is still there without any interaction it is
      // static page copy, not an interaction-caused bug: NOT reproduced.
      const hasInteraction = TRACE.some((s) => s.kind !== "goto" && s.kind !== "back");
      if (reproduced && CHECK && CHECK.kind === "text-present" && hasInteraction) {
        const ctlCtx = await browser.newContext();
        attachOracles(ctlCtx, origin);
        try {
          const ctlPage = await ctlCtx.newPage();
          let ctlBroken = false;
          for (const step of TRACE) {
            if (step.kind !== "goto" && step.kind !== "back") continue;
            const ok = await executeStep(ctlPage, step);
            if (!ok && step.ok !== false) { ctlBroken = true; break; }
          }
          await ctlPage.waitForTimeout(GRACE_MS).catch(() => {});
          if (!ctlBroken) {
            const ctl = await evaluateCheck(ctlPage, CHECK);
            if (ctl.reproduced) {
              reproduced = false;
              console.error("control-matched: check text present without interactions (static page copy)");
            }
          }
        } finally {
          await ctlCtx.close().catch(() => {});
        }
      }
    } else {
      reproduced = events.some((event) => {
        try {
          return signaturesMatch(buildSignature(event), SIGNATURE);
        } catch {
          return false;
        }
      });
    }
    if (!reproduced && broken) console.error("verdict: replay-broken (recorded step no longer executes)");
    // Honesty caveat (lib/reverify.mjs parity): a text-present/text-absent
    // check only proves a substring was/wasn't found — not ordering, counts,
    // or correctness beyond that. Never printed as "confirmed" without this.
    if (reproduced && SOURCE === "brain:semantic") {
      console.error(
        "caveat: text-verified only — this check proves the text was present/absent, " +
          "not ordering, counts, or correctness beyond that"
      );
    }
    console.log((reproduced ? "REPRODUCED " : "NOT REPRODUCED ") + FINDING_ID + " " + SIGNATURE);
    process.exitCode = reproduced ? 0 : 1;
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});
`;
}

// Function.prototype.toString() returns the declaration without the "export"
// keyword on V8; the strip is defensive for other engines.
function fnSource(fn) {
  const src = fn.toString();
  return src.startsWith("export ") ? src.slice("export ".length) : src;
}
