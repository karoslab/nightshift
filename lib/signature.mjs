// lib/signature.mjs — failure signature normalization + matching (DESIGN.md pinned).
// buildSignature(failureEventOrSemanticCheck) -> "<kind>|<subject>|<normalized-message>"
//   - network-5xx / network-4xx / request-failed / dead-link: subject is the
//     normalized REQUEST URL pathname + method + status (two failing endpoints
//     on one page are two distinct bugs; page URL stays in evidence only).
//   - console-error / page-error / nav-failure / semantic checks: subject is
//     the page URL pathname.
// signaturesMatch(a, b) -> exact string equality of built signatures.
//
// CONSTRAINT (load-bearing): every function here is dependency-free and
// self-contained — no imports, no closures over module state. lib/reprogen.mjs
// embeds these functions into generated repro scripts via
// Function.prototype.toString(), and a parity test asserts byte-identical
// behavior between the embedded and imported copies. All helpers must live
// INSIDE the function bodies.

export function buildSignature(input) {
  // Normalization (pinned): lowercase; strip query strings; replace uuids,
  // hex ids >= 8 chars, timestamps, and integers >= 3 digits with "#";
  // collapse whitespace; truncate 200 chars.
  const norm = (value) => {
    let s = String(value == null ? "" : value).toLowerCase();
    s = s.replace(/\?\S+/g, ""); // query strings
    s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "#"); // uuids
    s = s.replace(/\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?/g, "#"); // iso timestamps
    s = s.replace(/\d{4}-\d{2}-\d{2}/g, "#"); // bare dates
    s = s.replace(/\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g, "#"); // clock times
    s = s.replace(/\b[0-9a-f]{8,}\b/g, "#"); // hex ids >= 8 chars
    s = s.replace(/\d{3,}/g, "#"); // integers >= 3 digits
    s = s.replace(/\s+/g, " ").trim();
    return s.slice(0, 200);
  };
  const pathnameOf = (value) => {
    const raw = String(value == null ? "" : value);
    try {
      return new URL(raw).pathname;
    } catch {
      // relative path or bare fragment — resolve against a throwaway base
    }
    try {
      return new URL(raw, "http://nightshift.invalid").pathname;
    } catch {
      return raw;
    }
  };

  if (input === null || typeof input !== "object") {
    throw new Error("buildSignature: expected a FailureEvent or semantic check, got " + (input === null ? "null" : typeof input));
  }
  const isOracle = typeof input.oracle === "string" && input.oracle.length > 0;
  const isCheck = input.kind === "text-present" || input.kind === "text-absent";
  if (!isOracle && !isCheck) {
    throw new Error("buildSignature: input has neither a .oracle nor a semantic check .kind");
  }
  const kind = isOracle ? input.oracle : input.kind;
  const requestKeyed =
    isOracle &&
    (kind === "network-5xx" || kind === "network-4xx" || kind === "request-failed" || kind === "dead-link");

  let subject;
  let message;
  if (requestKeyed) {
    const detail = input.detail !== null && typeof input.detail === "object" ? input.detail : {};
    const requestUrl = detail.requestUrl != null ? detail.requestUrl : input.url;
    const parts = [norm(pathnameOf(requestUrl))];
    if (detail.method != null) parts.push(String(detail.method).toLowerCase());
    if (detail.status != null) parts.push(String(detail.status)); // status is a key component, never "#"-stripped
    subject = parts.join(" ");
    message = norm(input.message);
  } else if (isOracle) {
    subject = norm(pathnameOf(input.url));
    // console-error: Chromium reports the failing script/resource URL only in
    // msg.location() (captured as detail.location "url:line"), never in the
    // message text — fold its pathname into the subject so two distinct
    // sources with identical messages stay two distinct bugs (page pathname
    // alone would merge them, and reverify would cross-confirm the wrong one).
    // The trailing line number is dropped: it is churn, not identity.
    if (kind === "console-error") {
      const detail = input.detail !== null && typeof input.detail === "object" ? input.detail : {};
      const loc = typeof detail.location === "string" ? detail.location.replace(/:\d+$/, "") : "";
      if (loc) subject = subject + " " + norm(pathnameOf(loc));
    }
    message = norm(input.message);
  } else {
    subject = norm(pathnameOf(input.url));
    message = norm(input.text);
  }
  return (kind + "|" + subject + "|" + message).slice(0, 200);
}

export function signaturesMatch(a, b) {
  return typeof a === "string" && typeof b === "string" && a === b;
}
