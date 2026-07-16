// lib/security/reprogen.mjs — standalone repro script generator for NS-SEC-*
// findings (security loadout P4). Clean-room, mirrors lib/reprogen.mjs's
// discipline — no T3MP3ST source read or ported (see NOTICE).
//
// generateSecurityReproScript(finding) -> string: a self-contained .mjs that
// uses ONLY Node's built-in fetch (no playwright, no dependencies at all,
// since every security check here is fully determined by one HTTP response).
// Embeds the actual check function and buildSignature/signaturesMatch via
// Function.prototype.toString() so the script can never disagree with the
// report's verdict. A parity test asserts embedded vs imported output is
// byte-identical.

import { buildSignature, signaturesMatch } from "../signature.mjs";
import { ALL_CHECKS } from "./checks.mjs";

export function generateSecurityReproScript(finding) {
  if (finding === null || typeof finding !== "object") {
    throw new Error("generateSecurityReproScript: finding must be an object");
  }
  const checkFn = ALL_CHECKS[finding.checkId];
  if (!checkFn) {
    throw new Error("generateSecurityReproScript: unknown checkId " + String(finding.checkId));
  }
  const url = finding.evidence?.url ?? finding.trace?.[0]?.value ?? null;
  if (!url) {
    throw new Error("generateSecurityReproScript: finding " + String(finding.id) + " has no url to replay");
  }
  if (typeof finding.signature !== "string" || finding.signature.length === 0) {
    throw new Error("generateSecurityReproScript: finding " + String(finding.id) + " has no signature");
  }

  const js = (value) => JSON.stringify(value ?? null, null, 2);
  const oneLine = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

  return `#!/usr/bin/env node
// NightShift QA security repro script — ${oneLine(finding.id)}: ${oneLine(finding.title)}
// Standalone: uses only Node's built-in fetch, no dependencies. Re-fetches the
// recorded URL in a fresh request and re-runs the deterministic check with
// the LLM out of the loop. Exit 0 = finding reproduced, exit 1 = not reproduced.

const URL_TO_CHECK = ${js(url)};
const SIGNATURE = ${js(finding.signature)};

// --- begin embedded lib/security/checks.mjs check (do not edit; parity-tested) ---
${fnSource(checkFn)}
// --- end embedded check ---

// --- begin embedded lib/signature.mjs (do not edit; parity-tested) ---
${fnSource(buildSignature)}

${fnSource(signaturesMatch)}
// --- end embedded lib/signature.mjs ---

async function main() {
  const res = await fetch(URL_TO_CHECK, { redirect: "manual" });
  const headers = {};
  for (const [k, v] of res.headers.entries()) headers[k.toLowerCase()] = v;
  const setCookie =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : (headers["set-cookie"] ? [headers["set-cookie"]] : []);
  let body = "";
  try {
    body = await res.text();
  } catch {}
  const ctx = { url: URL_TO_CHECK, status: res.status, headers, setCookie, body };
  const result = ${checkFn.name}(ctx);
  const reproduced = result ? signaturesMatch(buildSignature(result.signatureInput), SIGNATURE) : false;
  console.log((reproduced ? "REPRODUCED " : "NOT REPRODUCED ") + SIGNATURE);
  process.exitCode = reproduced ? 0 : 1;
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
