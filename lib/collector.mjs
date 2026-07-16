// lib/collector.mjs — the shared candidate-finding collector.
// Both the LLM-guided session (lib/session.mjs) and the deterministic sweep
// (lib/sweep.mjs) build findings through this ONE collector, so a sweep finding
// has the exact same shape as an explorer finding and replays identically
// through the reverify pipeline. Findings are candidates (status "candidate")
// deduped in-session by signature, with a screenshot taken at detection.

import fs from "node:fs";
import path from "node:path";
import { buildSignature } from "./signature.mjs";
import { safePageUrl } from "./trace.mjs";

export const SEVERITY_BY_ORACLE = {
  "page-error": "critical",
  "network-5xx": "critical",
  "console-error": "major",
  "network-4xx": "major",
  "request-failed": "major",
  "nav-failure": "major",
  "dead-link": "minor",
};

// initialFindings pre-populates the collector (sweep resume rehydrates the
// findings persisted in the checkpoint so pre-interruption bugs survive). Their
// signatures seed the in-session dedupe set, so a resumed route that re-fires an
// already-recorded failure does not double-file it.
// `tag` is spread onto every finding this collector produces (e.g. { role }).
// The role defaults to the implicit "anonymous" default role so every finding
// is attributable even when no auth is configured.
export function createFindingCollector({ oracles, consoleTail, runDir, log, mintId, initialFindings = [], tag = {} }) {
  const stamp = { role: "anonymous", journey: null, ...tag };
  const findings = [...initialFindings];
  const seenSignatures = new Set();
  for (const f of initialFindings) if (f && f.signature) seenSignatures.add(f.signature);
  let consumedEvents = 0;

  const snapshot = async (page, id) => {
    const rel = "shots/" + id + ".png";
    try {
      await page.screenshot({ path: path.join(runDir, rel) });
    } catch (err) {
      log("warn", "screenshot failed for " + id + ": " + String(err && err.message ? err.message : err));
    }
    return rel;
  };

  const evidence = (page, screenshot) => ({
    screenshot,
    consoleTail: [...consoleTail],
    url: safePageUrl(page),
  });

  const collectOracleFindings = async (page, trace) => {
    while (consumedEvents < oracles.events.length) {
      const event = oracles.events[consumedEvents++];
      let signature;
      try {
        signature = buildSignature(event);
      } catch (err) {
        log("warn", "buildSignature failed, using fallback: " + String(err && err.message ? err.message : err));
        signature = fallbackSignature(event.oracle, event.url, event.message);
      }
      if (seenSignatures.has(signature)) continue;
      seenSignatures.add(signature);
      const id = mintId();
      const shot = await snapshot(page, id);
      findings.push({
        id,
        ...stamp,
        source: "oracle:" + event.oracle,
        title: oracleTitle(event),
        severity: SEVERITY_BY_ORACLE[event.oracle] ?? "major",
        signature,
        failure: event,
        semantic: null,
        check: null,
        trace: structuredClone(trace),
        evidence: evidence(page, shot),
        status: "candidate",
        reverify: null,
      });
      log("info", "candidate " + id + ": " + oracleTitle(event));
    }
  };

  const collectSemanticFinding = async (page, trace, raw) => {
    if (!raw || typeof raw !== "object") return;
    const url = safePageUrl(page);
    const check = normalizeCheck(raw.check);
    let signature;
    if (check) {
      try {
        signature = buildSignature({ ...check, url });
      } catch {
        signature = fallbackSignature(check.kind, url, check.text);
      }
    } else {
      signature = fallbackSignature("semantic", url, String(raw.title ?? ""));
    }
    if (seenSignatures.has(signature)) return;
    seenSignatures.add(signature);
    const id = mintId();
    const shot = await snapshot(page, id);
    findings.push({
      id,
      ...stamp,
      source: "brain:semantic",
      title: String(raw.title ?? "semantic finding").slice(0, 120),
      severity: ["critical", "major", "minor"].includes(raw.severity) ? raw.severity : "minor",
      signature,
      failure: null,
      semantic: { expected: String(raw.expected ?? ""), actual: String(raw.actual ?? "") },
      check,
      trace: structuredClone(trace),
      evidence: evidence(page, shot),
      // no mechanical assertion -> never presented as confirmable
      status: check ? "candidate" : "unverifiable",
      reverify: null,
    });
    log("info", "candidate " + id + " (semantic" + (check ? "" : ", unverifiable") + "): " + String(raw.title ?? ""));
  };

  return { findings, collectOracleFindings, collectSemanticFinding };
}

function normalizeCheck(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.kind !== "text-present" && raw.kind !== "text-absent") return null;
  if (typeof raw.text !== "string" || raw.text.length === 0) return null;
  return { kind: raw.kind, selector: typeof raw.selector === "string" ? raw.selector : null, text: raw.text };
}

// Local last-resort signature (dedupe-only) when buildSignature can't apply.
function fallbackSignature(kind, url, message) {
  return (String(kind) + "|" + pathnameOf(url) + "|" + String(message))
    .toLowerCase()
    .replace(/\s+/g, " ")
    .slice(0, 200);
}

function oracleTitle(event) {
  const where = event.detail && event.detail.requestUrl ? event.detail.requestUrl : pathnameOf(event.url);
  return (event.oracle + " at " + where + ": " + firstLine(event.message)).slice(0, 120);
}

function pathnameOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return String(url);
  }
}

function firstLine(s) {
  return String(s ?? "").split("\n", 1)[0];
}
