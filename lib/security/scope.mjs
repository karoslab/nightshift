// lib/security/scope.mjs — egress containment + audit receipt (security
// loadout P1). Clean-room, from PLAN-security-loadout.md section 2.3 — no
// T3MP3ST source read or ported (see NOTICE).
//
// createScopeGate({config, log}) -> {assertInScope(url), receipt(), writeReceipt(runDir)}
// Default scope is the target app's own origin only; config.security.scope.origins
// extends the allowlist with operator-authorized origins. Every check that
// would touch the network passes its URL through assertInScope FIRST —
// off-scope URLs are skipped and logged, NEVER fetched. writeReceipt persists
// a scope-receipt.json: what was authorized, what was probed, when — the
// consent-first audit trail.

import fs from "node:fs";
import path from "node:path";

const defaultLog = (level, message) => console.error("[" + level + "] " + message);

export function createScopeGate({ config, log = defaultLog }) {
  const targetOrigin = new URL(config.target.url).origin;
  const extra = config.security?.scope?.origins ?? [];
  const origins = new Set([targetOrigin, ...extra]);
  const probed = [];

  // Every URL a security check would touch flows through here first. Returns
  // false (and logs + records the refusal) instead of ever fetching an
  // off-scope origin.
  function assertInScope(url) {
    let origin = null;
    try {
      origin = new URL(url).origin;
    } catch {
      // unparseable URL is never in scope
    }
    const inScope = origin !== null && origins.has(origin);
    probed.push({ url: String(url), origin, inScope, ts: Date.now() });
    if (!inScope) log("warn", "security scope: skipped off-scope url " + url);
    return inScope;
  }

  function receipt() {
    return {
      authorizedOrigins: [...origins],
      probed: probed.map((p) => ({ ...p })),
      generatedAt: new Date().toISOString(),
    };
  }

  function writeReceipt(runDir) {
    const rel = "scope-receipt.json";
    fs.writeFileSync(path.join(runDir, rel), JSON.stringify(receipt(), null, 2) + "\n");
    return rel;
  }

  return { assertInScope, receipt, writeReceipt, origins };
}
