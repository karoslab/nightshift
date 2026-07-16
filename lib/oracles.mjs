// lib/oracles.mjs — deterministic failure detectors (the eyes).
// attachOracles(context, {origin, oraclesConfig}) -> {events, setStep, dispose}
// Noise filters are load-bearing: false positives kill the product.

const FETCHY_TYPES = new Set(["fetch", "xhr"]);
// Navigation-abort family: a click that navigates while fetches are in flight
// is normal — and it replays perfectly, so it would sail through reverify as
// a confirmed non-bug. NS_BINDING_ABORTED/cancelled cover firefox/webkit.
const ABORT_FAMILY_RE = /net::ERR_ABORTED|NS_BINDING_ABORTED|cancell?ed|frame was detached/i;
// Chromium mirrors every failed subresource load into the console as
// "Failed to load resource: ...". Those entries would bypass the fetch/xhr-only
// and expectedStatuses filters the network oracles enforce (a missing favicon
// or an expected 401 auth probe would become a major console-error finding),
// so the console oracle drops them — network failures are the network
// oracles' job, with their filters applied.
const NETWORK_LOG_RE = /^Failed to load resource:/;

// A 400 from an auth endpoint is the server correctly rejecting invalid
// input (empty signup fields, malformed email) — expected validation, not a
// bug. 401/403 are already buyer-declared via expectedStatuses; this covers
// the validation status those endpoints legitimately return. Scoped to
// fetch/xhr 400s only (see onResponse) — a 400 DOCUMENT navigation dead-link
// on an auth page still fires. The `s?` is deliberately narrow: /api/authors
// and /blog/password-tips do NOT match (word must end at `/` or the string).
const AUTH_PATH_RE = /(^|\/)(auth|login|log-in|signin|sign-in|signup|sign-up|register|password|forgot|reset|verify|otp|credentials|session)s?(\/|$)/i;

const DEFAULT_EXPECTED_STATUSES = [401, 403];

// options:
//   origin        — target app origin; responses from elsewhere never fire.
//   oraclesConfig — {expectedStatuses, ignoreConsole} from config.oracles.
//   navAllowList  — optional live Set of pathname+search keys the session
//                   harvested from real anchor hrefs + configured seed routes.
//                   When provided, dead-link fires ONLY for listed destinations
//                   (a brain-invented goto that 404s is not a bug in the
//                   buyer's app); the key is the ORIGINAL request URL of the
//                   redirect chain — the anchor the user followed — so a real
//                   link that redirects to a 404 still fires. When absent
//                   (reverify replay — every nav comes from a recorded trace),
//                   all qualifying document navs fire.
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
    if (NETWORK_LOG_RE.test(text)) return; // network-log entries: see NETWORK_LOG_RE
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
    // Buyer-declared expected statuses (401/403 auth probes by default) are
    // expected app behavior for EVERY response oracle family — a login-gated
    // link landing on 403 or a declared-expected 503 must never file a bug.
    if (expected.has(status)) return;
    const request = response.request();
    const detail = { status, method: request.method(), requestUrl: pathnameOf(response.url()) };

    if (request.isNavigationRequest() && request.resourceType() === "document") {
      // dead-link owns document navigations exclusively so one bad landing
      // can't double-file as dead-link AND network-5xx. The allow-list is
      // checked against the redirect chain's ORIGINAL request (the anchor the
      // user followed), keyed by pathname+search — a real anchor redirecting
      // to a 404 fires; a brain-invented goto sharing only the pathname of a
      // real anchor (query stripped) does not.
      if (navAllowList && !navAllowList.has(pathSearchOf(chainStartUrl(request)))) return;
      push("dead-link", "navigation landed on HTTP " + status, response.url(), detail);
      return;
    }
    if (status >= 500) {
      push("network-5xx", "HTTP " + status + " " + request.method() + " " + detail.requestUrl, frameUrlOf(request), detail);
      return;
    }
    // fetch/xhr only for 4xx
    if (!FETCHY_TYPES.has(request.resourceType())) return;
    // A fetch/xhr 400 against an auth endpoint is validation rejection, not a
    // bug (empty signup fields → 400). Narrowly scoped: only status 400, only
    // the fetch/xhr family (document dead-links already returned above).
    if (status === 400 && AUTH_PATH_RE.test(pathnameOf(response.url()))) return;
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

// Allow-list key: pathname + query (hash-free). Pathname alone would let a
// brain-invented goto "/product" ride on a harvested "/product?id=1" anchor.
function pathSearchOf(url) {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return String(url);
  }
}

// First request of the redirect chain — the URL the anchor actually pointed at.
function chainStartUrl(request) {
  let r = request;
  try {
    while (r.redirectedFrom()) r = r.redirectedFrom();
    return r.url();
  } catch {
    try {
      return request.url();
    } catch {
      return "";
    }
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
