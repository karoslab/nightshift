// lib/security/reverify.mjs — deterministic http-replay reverification for
// security findings (security loadout P3). Clean-room, from
// PLAN-security-loadout.md section 2.2 — no T3MP3ST source read or ported
// (see NOTICE).
//
// Reuses lib/reverify.mjs's discipline (LLM out of the loop, fresh replay per
// config.reverify.replays, requiredPasses decides confirmed/flaky/unconfirmed)
// but replays via a fresh HTTP fetch instead of a browser trace: every check
// in lib/security/checks.mjs is fully determined by one HTTP response, so a
// fresh fetch through the SAME scope gate IS the fresh context. A finding is
// "confirmed" only when the SAME check fires again with the SAME signature.

import { createScopeGate } from "./scope.mjs";
import { fetchCtx } from "./scan.mjs";
import { ALL_CHECKS } from "./checks.mjs";
import { buildSignature, signaturesMatch } from "../signature.mjs";

const defaultLog = (level, message) => console.error("[" + level + "] " + message);

export async function reverifySecurityFinding(finding, { config, log = defaultLog, fetchImpl = fetch } = {}) {
  const { replays, requiredPasses } = config.reverify;
  const checkFn = ALL_CHECKS[finding.checkId];
  const url = finding.evidence?.url ?? finding.trace?.[0]?.value ?? null;

  if (!checkFn || !url || typeof finding.signature !== "string" || finding.signature.length === 0) {
    log("info", finding.id + ": no deterministic http-replay possible — unverifiable");
    return finalize(finding, [], null);
  }

  const scopeGate = createScopeGate({ config, log });
  const verdicts = [];
  for (let n = 0; n < replays; n++) {
    let verdict;
    try {
      const ctx = await fetchCtx(url, { scopeGate, fetchImpl });
      if (ctx === null) {
        // Off-scope on replay should never happen (the finding's own scan
        // already passed the gate); fail closed rather than confirm blind.
        verdict = "replay-broken";
      } else {
        const result = checkFn(ctx);
        if (result) {
          const sig = buildSignature(result.signatureInput);
          verdict = signaturesMatch(sig, finding.signature) ? "reproduced" : "not-reproduced";
        } else {
          verdict = "not-reproduced";
        }
      }
    } catch (err) {
      log("warn", finding.id + ": replay fetch failed: " + String(err && err.message ? err.message : err));
      verdict = "replay-broken";
    }
    verdicts.push(verdict);
    log("info", finding.id + ": replay " + (n + 1) + "/" + replays + " -> " + verdict);
  }
  return finalize(finding, verdicts, requiredPasses);
}

function finalize(finding, verdicts, requiredPasses) {
  const reproduced = verdicts.filter((v) => v === "reproduced").length;
  let status;
  if (verdicts.length === 0) status = "unverifiable";
  else if (reproduced >= requiredPasses) status = "confirmed";
  else if (reproduced > 0) status = "flaky";
  else if (verdicts.every((v) => v === "replay-broken")) status = "unverifiable";
  else status = "unconfirmed";
  return {
    ...finding,
    status,
    reverify: {
      replays: verdicts.length,
      reproduced,
      verdicts,
      minimized: false,
      // the report layer writes <runDir>/repro/<id>.mjs and fills this in
      reproScript: finding.reverify?.reproScript ?? null,
    },
  };
}
