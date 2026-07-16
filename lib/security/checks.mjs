// lib/security/checks.mjs — deterministic, observe-only security checks
// (security loadout P2). Clean-room, from PLAN-security-loadout.md section
// 2.1 — no T3MP3ST source read or ported (see NOTICE). Defensive only: every
// check reads a response NightShift already fetched in-scope; none of them
// send anything beyond the plain request needed to observe the response.
//
// Each check is (ctx) => SecurityFinding | null.
// ctx: { url, status, headers (lowercased keys), setCookie (string[] raw
//       Set-Cookie header lines), body (response text, may be "") }
// SecurityFinding (pre-mint/pre-reverify):
//   { checkId, severity: "critical"|"major"|"minor", url,
//     evidence: {...check-specific...}, reproKind: "http-replay",
//     signatureInput: {oracle: "security:"+checkId, url, message} }
// signatureInput is shaped like a FailureEvent (lib/oracles.mjs) so
// lib/signature.mjs's buildSignature/signaturesMatch work UNCHANGED.
//
// CONSTRAINT (mirrors lib/signature.mjs): every exported check function is
// dependency-free and self-contained — no imports, no closures over module
// state, all helpers declared INSIDE the function body. lib/security/reprogen.mjs
// embeds these functions into generated repro scripts via
// Function.prototype.toString(); a parity test asserts identical behavior
// between the embedded and imported copies.

export function checkMissingSecurityHeaders(ctx) {
  const isHttps = (() => {
    try {
      return new URL(ctx.url).protocol === "https:";
    } catch {
      return false;
    }
  })();
  const headers = ctx.headers ?? {};
  const csp = headers["content-security-policy"] ?? "";
  const missing = [];
  if (!headers["content-security-policy"]) missing.push("Content-Security-Policy");
  if (!headers["x-content-type-options"]) missing.push("X-Content-Type-Options");
  if (!headers["x-frame-options"] && !/frame-ancestors/i.test(csp)) missing.push("X-Frame-Options (or CSP frame-ancestors)");
  if (!headers["referrer-policy"]) missing.push("Referrer-Policy");
  if (isHttps && !headers["strict-transport-security"]) missing.push("Strict-Transport-Security");
  if (missing.length === 0) return null;
  const message = "missing security headers: " + missing.join(", ");
  return {
    checkId: "missing-security-headers",
    severity: "minor",
    url: ctx.url,
    evidence: { headers, missing },
    reproKind: "http-replay",
    signatureInput: { oracle: "security:missing-security-headers", url: ctx.url, message },
  };
}

export function checkInsecureCookieFlags(ctx) {
  const isHttps = (() => {
    try {
      return new URL(ctx.url).protocol === "https:";
    } catch {
      return false;
    }
  })();
  const setCookie = ctx.setCookie ?? [];
  if (setCookie.length === 0) return null;
  const offenders = [];
  for (const raw of setCookie) {
    const name = String(raw).split("=")[0].trim();
    const attrs = String(raw)
      .split(";")
      .slice(1)
      .map((s) => s.trim().split("=")[0].toLowerCase());
    const missing = [];
    // Secure is only meaningful once the origin is https (an http-only origin
    // has no TLS channel for Secure to protect); HttpOnly/SameSite matter
    // regardless of scheme.
    if (isHttps && !attrs.includes("secure")) missing.push("Secure");
    if (!attrs.includes("httponly")) missing.push("HttpOnly");
    if (!attrs.includes("samesite")) missing.push("SameSite");
    if (missing.length > 0) offenders.push({ name, missing });
  }
  if (offenders.length === 0) return null;
  const message = "insecure cookie flag(s): " + offenders.map((o) => o.name + " missing " + o.missing.join("/")).join("; ");
  return {
    checkId: "insecure-cookie-flags",
    severity: "major",
    url: ctx.url,
    evidence: { cookies: offenders },
    reproKind: "http-replay",
    signatureInput: { oracle: "security:insecure-cookie-flags", url: ctx.url, message },
  };
}

export function checkMixedContent(ctx) {
  const isHttps = (() => {
    try {
      return new URL(ctx.url).protocol === "https:";
    } catch {
      return false;
    }
  })();
  if (!isHttps || typeof ctx.body !== "string") return null;
  const re = /\b(?:src|href)\s*=\s*["'](http:\/\/[^"']+)["']/gi;
  const found = new Set();
  let m;
  while ((m = re.exec(ctx.body))) found.add(m[1]);
  if (found.size === 0) return null;
  const urls = [...found].slice(0, 10);
  const message = "https page loads http subresource(s): " + urls.join(", ");
  return {
    checkId: "mixed-content",
    severity: "major",
    url: ctx.url,
    evidence: { subresources: urls },
    reproKind: "http-replay",
    signatureInput: { oracle: "security:mixed-content", url: ctx.url, message },
  };
}

export function checkTlsDowngradeLink(ctx) {
  let host = null;
  let isHttps = false;
  try {
    const u = new URL(ctx.url);
    host = u.hostname;
    isHttps = u.protocol === "https:";
  } catch {
    // leave host null -> no match below
  }
  if (!isHttps || !host || typeof ctx.body !== "string") return null;
  const re = /<a\b[^>]*\bhref\s*=\s*["'](http:\/\/[^"']+)["'][^>]*>/gi;
  const found = new Set();
  let m;
  while ((m = re.exec(ctx.body))) {
    try {
      if (new URL(m[1]).hostname === host) found.add(m[1]);
    } catch {
      // malformed href — skip
    }
  }
  if (found.size === 0) return null;
  const urls = [...found].slice(0, 10);
  const message = "in-app link(s) drop to http on an https origin: " + urls.join(", ");
  return {
    checkId: "tls-downgrade-link",
    severity: "minor",
    url: ctx.url,
    evidence: { links: urls },
    reproKind: "http-replay",
    signatureInput: { oracle: "security:tls-downgrade-link", url: ctx.url, message },
  };
}

export function checkVerboseErrorLeakage(ctx) {
  if (typeof ctx.body !== "string" || ctx.body.length === 0) return null;
  const patterns = [
    /at\s+[\w.$]+\s+\(.*:\d+:\d+\)/, // node/js stack trace frame
    /Traceback \(most recent call last\)/, // python
    /Whitelabel Error Page/, // spring boot
    /Fatal error:.*on line \d+/i, // php
    /System\.Exception/, // .net
    /\bat System\./, // .net stack frame
    /django\.core\.exceptions/i, // django
    /org\.springframework/, // spring
    /\bStack trace:/i,
  ];
  let hitIndex = -1;
  let hitPattern = null;
  for (const p of patterns) {
    const m = p.exec(ctx.body);
    if (m && (hitIndex === -1 || m.index < hitIndex)) {
      hitIndex = m.index;
      hitPattern = p;
    }
  }
  if (!hitPattern) return null;
  const snippet = ctx.body.slice(Math.max(0, hitIndex - 40), hitIndex + 160).replace(/\s+/g, " ").trim();
  const message = "response leaks internal error detail (status " + ctx.status + ")";
  return {
    checkId: "verbose-error-leakage",
    severity: "major",
    url: ctx.url,
    evidence: { snippet, status: ctx.status },
    reproKind: "http-replay",
    signatureInput: { oracle: "security:verbose-error-leakage", url: ctx.url, message },
  };
}

export function checkOpenRedirectCandidate(ctx) {
  const REDIRECT_PARAMS = ["redirect", "redirect_uri", "redirect_url", "url", "next", "return", "return_to", "continue", "dest", "destination"];
  let u;
  try {
    u = new URL(ctx.url);
  } catch {
    return null;
  }
  for (const p of REDIRECT_PARAMS) {
    const val = u.searchParams.get(p);
    if (!val) continue;
    let target;
    try {
      target = new URL(val, ctx.url);
    } catch {
      continue;
    }
    if (/^https?:$/.test(target.protocol) && target.hostname !== u.hostname) {
      const message = 'redirect param "' + p + '" reflects external URL: ' + target.href;
      return {
        checkId: "open-redirect-candidate",
        severity: "minor",
        url: ctx.url,
        evidence: { param: p, target: target.href },
        reproKind: "http-replay",
        signatureInput: { oracle: "security:open-redirect-candidate", url: ctx.url, message },
      };
    }
  }
  return null;
}

// Stable, statically-known check ids (used by config validation and the
// loadout selector) — deliberately independent of ALL_CHECKS's function
// references below so config.mjs can import just the id list.
export const CHECK_IDS = [
  "missing-security-headers",
  "insecure-cookie-flags",
  "mixed-content",
  "tls-downgrade-link",
  "verbose-error-leakage",
  "open-redirect-candidate",
];

export const ALL_CHECKS = {
  "missing-security-headers": checkMissingSecurityHeaders,
  "insecure-cookie-flags": checkInsecureCookieFlags,
  "mixed-content": checkMixedContent,
  "tls-downgrade-link": checkTlsDowngradeLink,
  "verbose-error-leakage": checkVerboseErrorLeakage,
  "open-redirect-candidate": checkOpenRedirectCandidate,
};

// runChecks(ctx, checkIds=['*']) -> SecurityFinding[] — applies the
// configured subset of checks (or all of them) to one captured response.
export function runChecks(ctx, checkIds = ["*"]) {
  const ids = checkIds.includes("*") ? CHECK_IDS : checkIds;
  const out = [];
  for (const id of ids) {
    const fn = ALL_CHECKS[id];
    if (!fn) continue;
    const finding = fn(ctx);
    if (finding) out.push(finding);
  }
  return out;
}
