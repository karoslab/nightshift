// lib/report.mjs — report.json/report.md writer.
// Contract: writeReport(runDir, {config, findings, stats, brainMeta}) ->
// {jsonPath, mdPath}. Confirmed bugs first; flaky/unconfirmed/unverifiable in
// labelled sections; numbered English repro steps derived from the trace;
// softened positioning line in the header. The marketing phrases banned by
// DESIGN.md (cost/limit over-promises; see tests/e2e.test.mjs) never appear.

import fs from "node:fs";
import path from "node:path";
import { finalizeRun } from "./runstore.mjs";
// Static import (NOT createRequire): require() of an ES module only works on
// Node >= 22.12, but engines allows >= 22 — on 22.0-22.11 a lazy require threw
// ERR_REQUIRE_ESM and the catch silently wrote zero repro scripts. reprogen
// (and its imports signature.mjs/trace.mjs) is dependency-free, so a static
// import costs nothing and cannot fail per Node version.
import { generateReproScript } from "./reprogen.mjs";
import { generateSecurityReproScript } from "./security/reprogen.mjs";

export const POSITIONING_LINE =
  "Runs on the Claude subscription you already have — today, subject to Anthropic's usage limits and policies, which can change.";

export const STATUS_ORDER = [
  "confirmed",
  "text-verified",
  "flaky",
  "unconfirmed",
  "unverifiable",
  "candidate",
];

export const SECTION_LABELS = {
  confirmed: "Confirmed bugs",
  "text-verified":
    "Text-verified (a text substring reliably reproduced — this proves presence/absence, not ordering, counts, or full correctness)",
  flaky: "Flaky (reproduced, but below the confirmation threshold)",
  unconfirmed: "Unconfirmed (did not reproduce on deterministic replay)",
  unverifiable: "Unverifiable (no deterministic check — never presented as confirmed)",
  candidate: "Candidates (not yet re-verified)",
};

// Groups findings by status in report order (confirmed first). Unknown
// statuses are appended after the known ones so nothing silently vanishes.
export function groupFindings(findings = []) {
  const byStatus = new Map();
  for (const f of findings) {
    const status = STATUS_ORDER.includes(f.status) ? f.status : "candidate";
    if (!byStatus.has(status)) byStatus.set(status, []);
    byStatus.get(status).push(f);
  }
  return STATUS_ORDER.filter((s) => byStatus.has(s)).map((s) => ({
    status: s,
    label: SECTION_LABELS[s],
    findings: byStatus.get(s),
  }));
}

function describeLocator(locator) {
  if (!locator) return "the page";
  if (locator.strategy === "role") {
    const nth = locator.nth > 0 ? ` (occurrence ${locator.nth + 1})` : "";
    return `the ${locator.role} "${locator.name}"${nth}`;
  }
  if (locator.strategy === "text") {
    return `the element with text "${locator.text ?? locator.name}"`;
  }
  return `the element matching \`${locator.css ?? locator.selector ?? "?"}\``;
}

// One TraceStep -> one plain-English instruction a human can follow.
export function describeStep(step) {
  const target = describeLocator(step.locator);
  switch (step.kind) {
    case "goto":
      return `Go to ${step.value}`;
    case "back":
      return "Go back to the previous page";
    case "click":
      return `Click ${target}`;
    case "fill":
      return `Fill ${target} with "${step.value}"`;
    case "select":
      return `Select "${step.value}" in ${target}`;
    case "press":
      return `Press "${step.value}" with focus on ${target}`;
    default:
      return `${step.kind} ${target}`;
  }
}

// healthy: all brain turns succeeded and at least one action was executed.
// degraded: some turns failed (>=50% succeeded) but exploration still happened.
// failed: fewer than half the attempted turns succeeded.
// inconclusive: no brain turns were attempted, or turns succeeded but the
// session never executed a single action — there's no exploration to judge.
// Sweep mode makes no brain turns by design, so its health is judged purely on
// whether it exercised any element: llmCalls==0 must NOT read as inconclusive.
export function computeRunState(stats = {}) {
  const actions = stats.actionsExecuted ?? 0;
  if (stats.mode === "sweep") return actions === 0 ? "inconclusive" : "healthy";
  const total = stats.llmCalls ?? 0;
  const ok = stats.turnsOk ?? 0;
  if (total === 0 || actions === 0) return "inconclusive";
  const ratio = ok / total;
  if (ratio < 0.5) return "failed";
  if (ratio < 1) return "degraded";
  return "healthy";
}

export function countsByStatus(findings = []) {
  const counts = { total: findings.length };
  for (const s of STATUS_ORDER) counts[s] = 0;
  for (const f of findings) {
    const status = STATUS_ORDER.includes(f.status) ? f.status : "candidate";
    counts[status] += 1;
  }
  return counts;
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms)) return "n/a";
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? `${min}m ${sec}s` : `${sec}s`;
}

function fmtUsage(usage = {}) {
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cost = usage.costUsd == null ? "n/a" : `$${Number(usage.costUsd).toFixed(4)}`;
  return `${input} input / ${output} output tokens · cost: ${cost}`;
}

// Markdown is a rendering context too. report.md is the buyer-facing
// deliverable that gets pasted into wikis/Jira and opened in previews that
// render inline HTML — every string that originated in the page under test
// (console text, element accessible names, excerpts, fill values, URLs) is
// untrusted there, exactly as it is in the HTML console (which escapes it).
// mdInline neutralizes the block-level and inline injection vectors: newlines
// (fresh headings/fences/list items), angle brackets (inline HTML / stored
// XSS), and square brackets (forged links).
function mdInline(value) {
  return String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

// Backtick-wrapped evidence (code span): a backtick inside would close the
// span early and hand the rest of the line back to the Markdown parser.
function mdCode(value) {
  return "`" + String(value ?? "").replace(/\r?\n/g, " ").replace(/`/g, "'") + "`";
}

// Fenced block whose fence is always longer than any backtick run in the
// body, so untrusted content (console tails) can never terminate the fence.
function mdFence(entries, indent = "  ") {
  const body = entries.map((e) => String(e ?? "")).join("\n");
  const longestRun = (body.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  const out = [indent + fence];
  for (const line of body.split("\n")) out.push(indent + line);
  out.push(indent + fence);
  return out;
}

function findingToMd(f) {
  const lines = [];
  lines.push(`### ${f.id} — ${mdInline(f.title)}`);
  lines.push("");
  lines.push(`- Severity: **${mdInline(f.severity)}** · Status: **${mdInline(f.status)}** · Source: ${mdInline(f.source)}`);
  if (f.status === "text-verified") {
    lines.push(
      "- Caveat: verified by a text substring check only — this confirms the text was " +
        "(or was not) present, not ordering, counts, or correctness beyond that."
    );
  }
  if (f.signature) lines.push(`- Signature: ${mdCode(f.signature)}`);
  if (f.evidence?.url) lines.push(`- Page: ${mdInline(f.evidence.url)}`);
  if (f.reverify) {
    const r = f.reverify;
    const verdicts = (r.verdicts ?? []).join(", ");
    const minimized = r.minimized ? " · trace minimized" : "";
    lines.push(`- Re-verification: reproduced ${r.reproduced}/${r.replays} replays (${verdicts})${minimized}`);
  }
  lines.push("");
  lines.push("Steps to reproduce:");
  lines.push("");
  const trace = f.trace ?? [];
  trace.forEach((step, idx) => {
    lines.push(`${idx + 1}. ${mdInline(describeStep(step))}`);
  });
  if (trace.length === 0) lines.push("_(no trace recorded)_");
  lines.push("");
  lines.push("Evidence:");
  lines.push("");
  if (f.failure?.message) {
    lines.push(`- Failure (${mdInline(f.failure.oracle)}): ${mdInline(f.failure.message)}`);
  }
  if (f.semantic?.expected) lines.push(`- Expected: ${mdInline(f.semantic.expected)}`);
  if (f.semantic?.actual) lines.push(`- Actual: ${mdInline(f.semantic.actual)}`);
  if (f.check) {
    lines.push(`- Deterministic check: ${mdInline(f.check.kind)} "${mdInline(f.check.text)}" in ${mdInline(f.check.selector ?? "page body")}`);
  }
  if (f.checkId) lines.push(`- Security check: ${mdInline(f.checkId)} (reproKind: ${mdInline(f.reproKind)})`);
  if (f.evidence?.missing?.length) lines.push(`- Missing: ${mdInline(f.evidence.missing.join(", "))}`);
  if (f.evidence?.cookies?.length) {
    lines.push(
      `- Cookies: ${mdInline(f.evidence.cookies.map((c) => c.name + " (missing " + c.missing.join("/") + ")").join("; "))}`,
    );
  }
  if (f.evidence?.excerpt) lines.push(`- Matched excerpt: ${mdInline(f.evidence.excerpt)}`);
  if (f.evidence?.consoleTail?.length) {
    lines.push("- Console tail:");
    lines.push("");
    lines.push(...mdFence(f.evidence.consoleTail.slice(-10)));
  }
  if (f.evidence?.screenshot) lines.push(`- Screenshot: ${f.evidence.screenshot}`);
  if (f.reverify?.reproScript) {
    lines.push(`- Repro script: ${f.reverify.reproScript} (exits 0 when the bug reproduces)`);
  }
  lines.push("");
  return lines.join("\n");
}

// Sweep coverage block: per-route element accounting + a totals row. Route
// URLs are untrusted (they can carry a same-origin path with markdown/HTML
// metacharacters), so they go through mdInline.
function buildCoverageMd(coverage) {
  const lines = [];
  const t = coverage.totals ?? {};
  lines.push(`## Sweep coverage — ${t.coveragePct ?? 0}% of interactive elements exercised`);
  lines.push("");
  lines.push("| Route | Found | Exercised | Skipped (denied) | Failed | Form passes | Coverage |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const r of coverage.routes ?? []) {
    lines.push(
      `| ${mdInline(r.url)} | ${r.found} | ${r.exercised} | ${r.skipped} | ${r.failed} | ${r.forms} | ${r.coveragePct}% |`,
    );
  }
  lines.push(
    `| **Total** | ${t.found ?? 0} | ${t.exercised ?? 0} | ${t.skipped ?? 0} | ${t.failed ?? 0} | ${t.forms ?? 0} | **${t.coveragePct ?? 0}%** |`,
  );
  return lines;
}

function buildMd({ runId, config, findings, stats, brainMeta, generatedAt, runState }) {
  const target = config?.target ?? {};
  const counts = countsByStatus(findings);
  const lines = [];
  lines.push(`# NightShift QA report — ${target.name ?? "target"}`);
  lines.push("");
  lines.push(`- Run: ${runId}`);
  lines.push(`- Generated: ${generatedAt}`);
  lines.push(`- Run state: **${runState}**`);
  lines.push(`- Target: ${target.name ?? "?"} — ${target.url ?? "?"}`);
  lines.push(`- Brain: ${brainMeta.mode ?? "?"} (model: ${brainMeta.model ?? "?"})`);
  lines.push(`- Token usage: ${fmtUsage(stats.usage)}`);
  lines.push(
    `- Session: ${stats.routesVisited ?? 0} routes visited · ` +
      `${stats.actionsExecuted ?? 0} actions · ${stats.llmCalls ?? 0} LLM calls · ` +
      `${fmtDuration(stats.durationMs)}`
  );
  lines.push("");
  lines.push(`> ${POSITIONING_LINE}`);
  lines.push("");
  lines.push(
    `**Findings:** ${counts.confirmed} confirmed · ${counts["text-verified"]} text-verified · ` +
      `${counts.flaky} flaky · ${counts.unconfirmed} unconfirmed · ${counts.unverifiable} unverifiable` +
      (counts.candidate ? ` · ${counts.candidate} candidate` : "")
  );
  lines.push("");

  if (stats.coverage) lines.push(...buildCoverageMd(stats.coverage), "");

  // Security findings (security.enabled loadout) get their own top-level
  // section, distinct from functional NS-* findings — DESIGN section 2.5.
  // Recognized by the presence of checkId, set only by lib/security/scan.mjs.
  const functional = findings.filter((f) => !f.checkId);
  const security = findings.filter((f) => f.checkId);

  const groups = groupFindings(functional);
  const hasConfirmed = groups.some((g) => g.status === "confirmed");
  if (!hasConfirmed) {
    lines.push(`## ${SECTION_LABELS.confirmed} (0)`);
    lines.push("");
    lines.push("No confirmed bugs this run.");
    lines.push("");
  }
  for (const group of groups) {
    lines.push(`## ${group.label} (${group.findings.length})`);
    lines.push("");
    for (const f of group.findings) lines.push(findingToMd(f));
  }

  if (security.length > 0) {
    lines.push(`## Security (${security.length})`);
    lines.push("");
    for (const group of groupFindings(security)) {
      lines.push(`### ${group.label} (${group.findings.length})`);
      lines.push("");
      for (const f of group.findings) lines.push(findingToMd(f));
    }
  }

  return lines.join("\n");
}

// The report layer owns writing repro scripts (DESIGN: reprogen generates the
// string, report writes <runDir>/repro/<id>.mjs). Defensive per finding: if
// one finding trips reprogen up, the report is still written — a missing repro
// script must not sink the whole run.
function withReproScripts(runDir, findings, config) {
  fs.mkdirSync(path.join(runDir, "repro"), { recursive: true });
  return findings.map((f) => {
    const eligible = f.trace?.length && f.reverify && f.status !== "unverifiable";
    if (!eligible) return f;
    try {
      // Security findings (NS-SEC-*, tagged with checkId by lib/security/scan.mjs)
      // get their own dependency-free fetch-based repro script; functional
      // findings keep the playwright trace-replay generator.
      const script = f.checkId ? generateSecurityReproScript(f) : generateReproScript(f, config);
      const rel = `repro/${f.id}.mjs`;
      fs.writeFileSync(path.join(runDir, rel), script);
      return { ...f, reverify: { ...f.reverify, reproScript: f.reverify.reproScript ?? rel } };
    } catch {
      return f;
    }
  });
}

export function writeReport(runDir, { config = {}, findings = [], stats = {}, brainMeta = {} }) {
  const absRunDir = path.resolve(runDir);
  fs.mkdirSync(path.join(absRunDir, "shots"), { recursive: true });
  fs.mkdirSync(path.join(absRunDir, "repro"), { recursive: true });

  const runId = path.basename(absRunDir);
  const generatedAt = new Date().toISOString();
  const finalFindings = withReproScripts(absRunDir, findings, config);
  const runState = computeRunState(stats);

  const reportJson = {
    runId,
    generatedAt,
    positioning: POSITIONING_LINE,
    brain: { mode: brainMeta.mode ?? null, model: brainMeta.model ?? null },
    target: config?.target ?? null,
    config,
    stats,
    runState,
    counts: countsByStatus(finalFindings),
    findings: finalFindings,
  };

  const jsonPath = path.join(absRunDir, "report.json");
  const mdPath = path.join(absRunDir, "report.md");
  fs.writeFileSync(jsonPath, JSON.stringify(reportJson, null, 2) + "\n");
  fs.writeFileSync(
    mdPath,
    buildMd({ runId, config, findings: finalFindings, stats, brainMeta, generatedAt, runState }) + "\n"
  );
  finalizeRun(absRunDir);
  return { jsonPath, mdPath };
}
