// lib/trace.mjs — locator resolution + THE single step-execution path.
// executeStep is the ONLY code that performs a step: explorer records through
// it, reverify replays through it, reprogen inlines its logic. Recording and
// replay share one execution path — they cannot diverge.

const ACTION_TIMEOUT_MS = 5000;
const SETTLE_CAP_MS = 1500;
const DEFAULT_NAV_TIMEOUT_MS = 15000;

// Turns a locator descriptor (see lib/elements.mjs) into a live Playwright locator.
export function resolveLocator(page, locator) {
  if (!locator || typeof locator !== "object") {
    throw new Error("invalid locator: " + JSON.stringify(locator));
  }
  const nth = Number.isInteger(locator.nth) ? locator.nth : 0;
  switch (locator.strategy) {
    case "role":
      return page.getByRole(locator.role, { name: locator.name, exact: true }).nth(nth);
    case "text":
      return page.getByText(locator.text, { exact: true }).nth(nth);
    case "css":
      return page.locator(locator.css).nth(nth);
    default:
      throw new Error("unknown locator strategy: " + String(locator.strategy));
  }
}

// executeStep(page, step, {navTimeoutMs}) -> {ok, error, settle}
// step: {kind, locator, value, settle?} — when step.settle carries a recorded
// wait (replay), we wait AT LEAST that long so a fast replay can't observe
// less of the world than the recording did. Never throws.
export async function executeStep(page, step, opts = {}) {
  const navTimeoutMs = opts.navTimeoutMs ?? DEFAULT_NAV_TIMEOUT_MS;
  let ok = true;
  let error = null;
  try {
    await act(page, step, navTimeoutMs);
  } catch (err) {
    ok = false;
    error = String(err && err.message ? err.message : err).slice(0, 500);
  }
  const settle = await settleWait(page, step.settle ?? null);
  return { ok, error, settle };
}

async function act(page, step, navTimeoutMs) {
  switch (step.kind) {
    case "goto":
      await navWithRetry(page, () => page.goto(step.value, { timeout: navTimeoutMs, waitUntil: "domcontentloaded" }), step.value);
      return;
    case "back":
      await navWithRetry(page, () => page.goBack({ timeout: navTimeoutMs, waitUntil: "domcontentloaded" }), null);
      return;
    case "click":
      await resolveLocator(page, step.locator).click({ timeout: ACTION_TIMEOUT_MS });
      return;
    case "fill":
      await resolveLocator(page, step.locator).fill(step.value ?? "", { timeout: ACTION_TIMEOUT_MS });
      return;
    case "select":
      await resolveLocator(page, step.locator).selectOption(step.value, { timeout: ACTION_TIMEOUT_MS });
      return;
    case "press":
      await resolveLocator(page, step.locator).press(step.value, { timeout: ACTION_TIMEOUT_MS });
      return;
    default:
      throw new Error("unknown step kind: " + String(step.kind));
  }
}

// A previously failed navigation commits its chrome-error:// page
// asynchronously; that pending commit can interrupt the NEXT navigation
// ("interrupted by another navigation"). Sessions hit this whenever a route
// fails and we move on to the next one — retry once after the commit settles.
async function navWithRetry(page, nav, targetUrl) {
  const MAX_ATTEMPTS = 3;
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      await nav();
      return;
    } catch (err) {
      lastErr = err;
      if (!/interrupted by another navigation/i.test(String(err && err.message ? err.message : err))) throw err;
      // let the competing navigation land; if it was ours (re-issued), we're done
      await page.waitForLoadState("domcontentloaded", { timeout: 2000 }).catch(() => {});
      if (targetUrl && safePageUrl(page) === targetUrl) return;
    }
  }
  if (targetUrl && safePageUrl(page) === targetUrl) return;
  throw lastErr;
}

// Wait for networkidle OR the 1500ms cap, whichever first; then pad up to the
// recorded floor when replaying. Records {condition, waitedMs}.
async function settleWait(page, recorded) {
  const t0 = Date.now();
  let condition = "timeout";
  try {
    await page.waitForLoadState("networkidle", { timeout: SETTLE_CAP_MS });
    condition = "networkidle";
  } catch {
    condition = "timeout";
  }
  const observed = Date.now() - t0;
  const floor = recorded && Number.isFinite(recorded.waitedMs) ? recorded.waitedMs : 0;
  if (floor > observed) {
    try {
      await page.waitForTimeout(floor - observed);
    } catch {
      // page/context closed mid-wait — nothing left to settle
    }
  }
  return { condition, waitedMs: Date.now() - t0 };
}

// TraceStep construction helper: executes via executeStep and returns the full
// recorded TraceStep {i, kind, locator, value, url, postUrl, ok, error, tMs, settle}.
export async function performStep(page, spec, opts = {}) {
  const { i = 0, kind, locator = null, value = null, settle = null } = spec;
  const url = safePageUrl(page);
  const t0 = Date.now();
  const res = await executeStep(page, { kind, locator, value, settle }, opts);
  const postUrl = safePageUrl(page);
  return {
    i,
    kind,
    locator,
    // for "back" the target URL is only known after execution
    value: kind === "back" && value == null ? postUrl : value,
    url,
    postUrl,
    ok: res.ok,
    error: res.error,
    tMs: Date.now() - t0,
    settle: res.settle,
  };
}

export function safePageUrl(page) {
  try {
    return page.url();
  } catch {
    return "";
  }
}
