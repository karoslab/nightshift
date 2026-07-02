// lib/oracles.mjs — deterministic failure detectors (the eyes).
// attachOracles(context, {origin, oraclesConfig}) -> {events, setStep, dispose}
// Noise filters are load-bearing: false positives kill the product.

const FETCHY_TYPES = new Set(["fetch", "xhr"]);
// Navigation-abort family: a click that navigates while fetches are in flight
// is normal — and it replays perfectly, so it would sail through reverify as
// a confirmed non-bug. NS_BINDING_ABORTED/cancelled cover firefox/webkit.
const ABORT_FAMILY_RE = /net::ERR_ABORTED|NS_BINDING_ABORTED|cancell?ed|frame was detached/i;

const DEFAULT_EXPECTED_STATUSES = [401, 403];

// options:
//   origin        — target app origin; responses from elsewhere never fire.
//   oraclesConfig — {expectedStatuses, ignoreConsole} from config.oracles.
//   navAllowList  — optional live Set of pathnames the session harvested from
//                   real anchor hrefs + configured seed routes. When provided,
//                   dead-link fires ONLY for listed destinations (a brain-
//                   invented goto that 404s is not a bug in the buyer's app).
//                   When absent (reverify replay — every nav comes from a
//                   recorded trace), all qualifying document navs fire.
export function attachOracles(context, { origin, oraclesConfig = {}, navAllowList = null } = {}) {
  const events = [];
  let currentStep = 0;
  const expected = new Set(oraclesConfig.expectedStatuses ?? DEFAULT_EXPECTED_STATUSES);
  const ignoreConsole = (oraclesConfig.ignoreConsole ?? []).map((s) => new RegExp(s));
  const targetOrigin = safeOrigin(origin);

  const push = (oracle, message, url, detail) => {
    events.push({ oracle, message, url, detail, atStep: currentStep, ts: Date.now() });
  };

  const sameOrigin = (url) => {
    if (!targetOrigin) return true;
    return safeOrigin(url) === targetOrigin;
  };

  const onConsole = (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (ignoreConsole.some((re) => re.test(text))) return;
    const loc = typeof msg.location === "function" ? msg.location() : null;
    push(
      "console-error",
      text,
      pageUrlOf(msg.page(), loc ? loc.url : ""),
      loc ? { location: loc.url + ":" + loc.lineNumber } : {},
    );
  };

  const onWebError = (webError) => {
    const err = webError.error();
    push("page-error", String(err && err.message ? err.message : err), pageUrlOf(webError.page(), ""), {});
  };

  const onRequestFailed = (request) => {
    const failure = request.failure();
    const errorText = failure && failure.errorText ? failure.errorText : "request failed";
    if (ABORT_FAMILY_RE.test(errorText)) return;
    const detail = { status: null, method: request.method(), requestUrl: pathnameOf(request.url()) };
    if (request.isNavigationRequest()) {
      push("nav-failure", errorText, request.url(), detail);
      return;
    }
    // fetch/xhr only: a missing favicon is noise; a failing API call is signal
    if (!FETCHY_TYPES.has(request.resourceType())) return;
    push("request-failed", errorText, frameUrlOf(request), detail);
  };

  const onResponse = (response) => {
    const status = response.status();
    if (status < 400) return;
    if (!sameOrigin(response.url())) return;
    const request = response.request();
    const detail = { status, method: request.method(), requestUrl: pathnameOf(response.url()) };

    if (request.isNavigationRequest() && request.resourceType() === "document") {
      // dead-link owns document navigations exclusively so one bad landing
      // can't double-file as dead-link AND network-5xx.
      if (navAllowList && !navAllowList.has(pathnameOf(response.url()))) return;
      push("dead-link", "navigation landed on HTTP " + status, response.url(), detail);
      return;
    }
    if (status >= 500) {
      push("network-5xx", "HTTP " + status + " " + request.method() + " " + detail.requestUrl, frameUrlOf(request), detail);
      return;
    }
    // fetch/xhr only for 4xx, and expected statuses (auth probes) never fire
    if (!FETCHY_TYPES.has(request.resourceType())) return;
    if (expected.has(status)) return;
    push("network-4xx", "HTTP " + status + " " + request.method() + " " + detail.requestUrl, frameUrlOf(request), detail);
  };

  context.on("console", onConsole);
  context.on("weberror", onWebError);
  context.on("requestfailed", onRequestFailed);
  context.on("response", onResponse);

  return {
    events,
    setStep(i) {
      currentStep = i;
    },
    dispose() {
      context.off("console", onConsole);
      context.off("weberror", onWebError);
      context.off("requestfailed", onRequestFailed);
      context.off("response", onResponse);
    },
  };
}

function safeOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function pathnameOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return String(url);
  }
}

function pageUrlOf(page, fallback) {
  try {
    return page ? page.url() : fallback;
  } catch {
    return fallback;
  }
}

function frameUrlOf(request) {
  try {
    const frame = request.frame();
    return frame ? frame.url() : "";
  } catch {
    return "";
  }
}
