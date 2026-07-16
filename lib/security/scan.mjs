// lib/security/scan.mjs — the security loadout's browse-and-check pass
// (security loadout P2/P3). Clean-room, from PLAN-security-loadout.md — no
// T3MP3ST source read or ported (see NOTICE).
//
// runSecurityScan({config, runDir, log}) -> {findings, stats}
// Visits config.target.routes (the same seeds functional sessions use) via a
// plain HTTP request per route — no browser, no offensive probing, no new
// network capability beyond reading the response NightShift is authorized to
// see. Every URL is gated through createScopeGate FIRST: off-scope, never
// fetched. Every finding starts "candidate"; lib/security/reverify.mjs
// confirms it deterministically before the report ever calls it confirmed.

import fs from "node:fs";
import { createScopeGate } from "./scope.mjs";
import { runChecks } from "./checks.mjs";
import { buildSignature } from "../signature.mjs";

const defaultLog = (level, message) => console.error("[" + level + "] " + message);

export function createSecurityIdMinter(start = 1) {
  let next = start;
  return () => "NS-SEC-" + String(next++).padStart(3, "0");
}

// Fetches one URL and shapes it into the SecurityFinding-check ctx. Returns
// null when the url is off-scope (never fetched) — callers must check for
// null before treating the result as "scanned".
export async function fetchCtx(url, { scopeGate, fetchImpl = fetch } = {}) {
  if (scopeGate && !scopeGate.assertInScope(url)) return null;
  const res = await fetchImpl(url, { redirect: "manual" });
  const headers = {};
  for (const [k, v] of res.headers.entries()) headers[k.toLowerCase()] = v;
  // Node's Headers merges multiple Set-Cookie lines under one accessor;
  // getSetCookie() (Node >= 19 / undici) returns them un-merged. Fall back to
  // the single merged header when unavailable (still enough to flag flags).
  const setCookie =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : headers["set-cookie"]
        ? [headers["set-cookie"]]
        : [];
  let body = "";
  try {
    body = await res.text();
  } catch {
    body = "";
  }
  return { url, status: res.status, headers, setCookie, body: body.slice(0, 200000) };
}

export async function runSecurityScan({ config, runDir, log = defaultLog, mintId = createSecurityIdMinter(), fetchImpl = fetch }) {
  if (!config.security?.enabled) {
    return { findings: [], stats: { scanned: 0, skipped: 0 } };
  }
  const scopeGate = createScopeGate({ config, log });
  const checkIds = config.security.checks ?? ["*"];
  const origin = new URL(config.target.url).origin;
  const routes = config.target.routes?.length ? config.target.routes : ["/"];

  const visitedUrls = new Set();
  const seenSignatures = new Set();
  const findings = [];
  let scanned = 0;
  let skipped = 0;

  for (const route of routes) {
    const url = new URL(route, origin).href;
    if (visitedUrls.has(url)) continue;
    visitedUrls.add(url);

    let ctx;
    try {
      ctx = await fetchCtx(url, { scopeGate, fetchImpl });
    } catch (err) {
      log("warn", "security scan: fetch failed for " + url + ": " + String(err && err.message ? err.message : err));
      continue;
    }
    if (ctx === null) {
      skipped += 1;
      continue;
    }
    scanned += 1;

    for (const raw of runChecks(ctx, checkIds)) {
      let signature;
      try {
        signature = buildSignature(raw.signatureInput);
      } catch (err) {
        log("warn", "security scan: buildSignature failed for " + raw.checkId + ": " + String(err && err.message ? err.message : err));
        continue;
      }
      if (seenSignatures.has(signature)) continue;
      seenSignatures.add(signature);

      const id = mintId();
      findings.push({
        id,
        checkId: raw.checkId,
        source: "security:" + raw.checkId,
        title: titleFor(raw.checkId, raw.url),
        severity: raw.severity,
        signature,
        evidence: { ...raw.evidence, url: raw.url },
        // A single-step goto "trace" so report.mjs's generic repro-steps
        // renderer and the Finding contract's shape apply unchanged.
        trace: [
          {
            i: 0,
            kind: "goto",
            locator: null,
            value: raw.url,
            url: origin,
            postUrl: raw.url,
            ok: true,
            error: null,
            tMs: 0,
            settle: { condition: "networkidle", waitedMs: 0 },
          },
        ],
        reproKind: raw.reproKind,
        status: "candidate",
        reverify: null,
      });
      log("info", "security candidate " + id + " (" + raw.checkId + "): " + raw.url);
    }
  }

  // Consent-first audit trail: what was authorized, what was actually probed.
  if (runDir) {
    try {
      fs.mkdirSync(runDir, { recursive: true });
      scopeGate.writeReceipt(runDir);
    } catch (err) {
      log("warn", "security scan: failed to write scope-receipt.json: " + String(err && err.message ? err.message : err));
    }
  }

  return { findings, stats: { scanned, skipped } };
}

const TITLE_LABELS = {
  "missing-security-headers": "Missing security headers",
  "insecure-cookie-flags": "Insecure cookie flags",
  "mixed-content": "Mixed content (http subresource on an https page)",
  "tls-downgrade-link": "In-app link drops to http on an https origin",
  "verbose-error-leakage": "Verbose error page leaks internal detail",
  "open-redirect-candidate": "Open-redirect candidate",
};

function titleFor(checkId, url) {
  return (TITLE_LABELS[checkId] ?? checkId) + " — " + safePath(url);
}

function safePath(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return String(url);
  }
}
