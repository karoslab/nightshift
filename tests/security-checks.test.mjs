// tests/security-checks.test.mjs — lib/security/checks.mjs against fixture
// ctx objects (no browser, no network — pure functions).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkMissingSecurityHeaders,
  checkInsecureCookieFlags,
  checkMixedContent,
  checkTlsDowngradeLink,
  checkVerboseErrorLeakage,
  checkOpenRedirectCandidate,
  runChecks,
  CHECK_IDS,
  ALL_CHECKS,
} from "../lib/security/checks.mjs";

// --- missing-security-headers ---

test("checkMissingSecurityHeaders: flags every absent header on an https doc response", () => {
  const finding = checkMissingSecurityHeaders({ url: "https://example.com/", status: 200, headers: {}, setCookie: [], body: "" });
  assert.equal(finding.checkId, "missing-security-headers");
  assert.equal(finding.reproKind, "http-replay");
  assert.ok(finding.evidence.missing.includes("Content-Security-Policy"));
  assert.ok(finding.evidence.missing.includes("X-Content-Type-Options"));
  assert.ok(finding.evidence.missing.includes("X-Frame-Options (or CSP frame-ancestors)"));
  assert.ok(finding.evidence.missing.includes("Referrer-Policy"));
  assert.ok(finding.evidence.missing.includes("Strict-Transport-Security"), "HSTS only required on https");
});

test("checkMissingSecurityHeaders: HSTS not required on plain http", () => {
  const finding = checkMissingSecurityHeaders({ url: "http://127.0.0.1:4185/", status: 200, headers: {}, setCookie: [], body: "" });
  assert.ok(!finding.evidence.missing.includes("Strict-Transport-Security"));
});

test("checkMissingSecurityHeaders: frame-ancestors CSP directive satisfies X-Frame-Options", () => {
  const finding = checkMissingSecurityHeaders({
    url: "http://x/",
    status: 200,
    headers: {
      "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
    setCookie: [],
    body: "",
  });
  assert.equal(finding, null);
});

test("checkMissingSecurityHeaders: all four headers present on http -> null", () => {
  const finding = checkMissingSecurityHeaders({
    url: "http://x/",
    status: 200,
    headers: {
      "content-security-policy": "default-src 'none'",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
    },
    setCookie: [],
    body: "",
  });
  assert.equal(finding, null);
});

// --- insecure-cookie-flags ---

test("checkInsecureCookieFlags: no Set-Cookie -> null", () => {
  assert.equal(checkInsecureCookieFlags({ url: "https://x/", status: 200, headers: {}, setCookie: [], body: "" }), null);
});

test("checkInsecureCookieFlags: http origin still flags missing HttpOnly/SameSite (not Secure)", () => {
  const finding = checkInsecureCookieFlags({
    url: "http://127.0.0.1:4185/",
    status: 200,
    headers: {},
    setCookie: ["bugbox_session=demo; Path=/"],
    body: "",
  });
  assert.equal(finding.checkId, "insecure-cookie-flags");
  assert.deepEqual(finding.evidence.cookies[0].missing.sort(), ["HttpOnly", "SameSite"]);
});

test("checkInsecureCookieFlags: https origin also requires Secure", () => {
  const finding = checkInsecureCookieFlags({
    url: "https://example.com/",
    status: 200,
    headers: {},
    setCookie: ["sid=abc; Path=/"],
    body: "",
  });
  assert.deepEqual(finding.evidence.cookies[0].missing.sort(), ["HttpOnly", "SameSite", "Secure"]);
});

test("checkInsecureCookieFlags: fully-flagged cookie -> null", () => {
  const finding = checkInsecureCookieFlags({
    url: "https://example.com/",
    status: 200,
    headers: {},
    setCookie: ["sid=abc; Secure; HttpOnly; SameSite=Strict"],
    body: "",
  });
  assert.equal(finding, null);
});

// --- mixed-content ---

test("checkMixedContent: https page with an http <script src> fires", () => {
  const finding = checkMixedContent({
    url: "https://example.com/",
    status: 200,
    headers: {},
    setCookie: [],
    body: '<html><script src="http://cdn.example/x.js"></script></html>',
  });
  assert.equal(finding.checkId, "mixed-content");
  assert.deepEqual(finding.evidence.subresources, ["http://cdn.example/x.js"]);
});

test("checkMixedContent: http page (not https) never fires", () => {
  assert.equal(
    checkMixedContent({ url: "http://x/", status: 200, headers: {}, setCookie: [], body: '<img src="http://y/z.png">' }),
    null,
  );
});

test("checkMixedContent: https-only subresources -> null", () => {
  assert.equal(
    checkMixedContent({ url: "https://x/", status: 200, headers: {}, setCookie: [], body: '<img src="https://y/z.png">' }),
    null,
  );
});

// --- tls-downgrade-link ---

test("checkTlsDowngradeLink: same-host anchor dropping to http fires", () => {
  const finding = checkTlsDowngradeLink({
    url: "https://example.com/",
    status: 200,
    headers: {},
    setCookie: [],
    body: '<a href="http://example.com/legacy">legacy</a>',
  });
  assert.equal(finding.checkId, "tls-downgrade-link");
  assert.deepEqual(finding.evidence.links, ["http://example.com/legacy"]);
});

test("checkTlsDowngradeLink: cross-host http anchor does not fire (external link, not a downgrade)", () => {
  assert.equal(
    checkTlsDowngradeLink({
      url: "https://example.com/",
      status: 200,
      headers: {},
      setCookie: [],
      body: '<a href="http://other.example/">other</a>',
    }),
    null,
  );
});

// --- verbose-error-leakage ---

test("checkVerboseErrorLeakage: python traceback body fires", () => {
  const finding = checkVerboseErrorLeakage({
    url: "https://x/error",
    status: 500,
    headers: {},
    setCookie: [],
    body: "Traceback (most recent call last):\n  File x.py line 3\nKeyError: 'oops'",
  });
  assert.equal(finding.checkId, "verbose-error-leakage");
  assert.match(finding.evidence.snippet, /Traceback/);
});

test("checkVerboseErrorLeakage: ordinary error page (no stack-trace markers) -> null", () => {
  assert.equal(
    checkVerboseErrorLeakage({ url: "https://x/error", status: 500, headers: {}, setCookie: [], body: "<h1>Something went wrong</h1>" }),
    null,
  );
});

// --- open-redirect-candidate ---

test("checkOpenRedirectCandidate: redirect param reflecting an external absolute URL fires", () => {
  const finding = checkOpenRedirectCandidate({
    url: "https://example.com/login?next=https://evil.example/phish",
    status: 200,
    headers: {},
    setCookie: [],
    body: "",
  });
  assert.equal(finding.checkId, "open-redirect-candidate");
  assert.equal(finding.evidence.target, "https://evil.example/phish");
});

test("checkOpenRedirectCandidate: same-host redirect param is not a candidate", () => {
  assert.equal(
    checkOpenRedirectCandidate({ url: "https://example.com/login?next=https://example.com/dashboard", status: 200, headers: {}, setCookie: [], body: "" }),
    null,
  );
});

test("checkOpenRedirectCandidate: relative redirect param is not a candidate", () => {
  assert.equal(
    checkOpenRedirectCandidate({ url: "https://example.com/login?next=/dashboard", status: 200, headers: {}, setCookie: [], body: "" }),
    null,
  );
});

// --- runChecks / registry ---

test("CHECK_IDS matches ALL_CHECKS keys exactly", () => {
  assert.deepEqual(CHECK_IDS.slice().sort(), Object.keys(ALL_CHECKS).sort());
});

test("runChecks('*'): runs every registered check and returns only the ones that fire", () => {
  const ctx = { url: "https://x/", status: 200, headers: {}, setCookie: ["sid=1"], body: "" };
  const findings = runChecks(ctx, ["*"]);
  const ids = findings.map((f) => f.checkId).sort();
  assert.deepEqual(ids, ["insecure-cookie-flags", "missing-security-headers"]);
});

test("runChecks: explicit subset only runs the named checks", () => {
  const ctx = { url: "https://x/", status: 200, headers: {}, setCookie: ["sid=1"], body: "" };
  const findings = runChecks(ctx, ["insecure-cookie-flags"]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].checkId, "insecure-cookie-flags");
});

// --- signatureInput shape (must work unchanged with lib/signature.mjs) ---

test("every check's signatureInput is FailureEvent-shaped (oracle string + url + message)", async () => {
  const { buildSignature } = await import("../lib/signature.mjs");
  const ctx = {
    url: "https://example.com/?next=https://evil.example/x",
    status: 500,
    headers: {},
    setCookie: ["sid=1"],
    body: '<a href="http://example.com/old">old</a><img src="http://cdn/x.png">Traceback (most recent call last):',
  };
  for (const id of CHECK_IDS) {
    const finding = ALL_CHECKS[id](ctx);
    if (!finding) continue;
    assert.equal(finding.signatureInput.oracle, "security:" + id);
    const sig = buildSignature(finding.signatureInput);
    assert.equal(typeof sig, "string");
    assert.ok(sig.startsWith("security:" + id + "|"));
  }
});
