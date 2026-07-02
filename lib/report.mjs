// lib/report.mjs — report.json/report.md writer.
// Contract: writeReport(runDir, {config, findings, stats, brainMeta}) ->
// {jsonPath, mdPath}. Confirmed bugs first; flaky/unconfirmed/unverifiable in
// labelled sections; numbered English repro steps derived from the trace;
// softened positioning line in the header. The marketing phrases banned by
// DESIGN.md (cost/limit over-promises; see tests/e2e.test.mjs) never appear.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { finalizeRun } from "./runstore.mjs";

export const POSITIONING_LINE =
  "Runs on the Claude subscription you already have — today, subject to Anthropic's usage limits and policies, which can change.";

export const STATUS_ORDER = [
  "confirmed",
  "flaky",
  "unconfirmed",
  "unverifiable",
  "candidate",
];

export const SECTION_LABELS = {
  confirmed: "Confirmed bugs",
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

function findingToMd(f) {
  const lines = [];
  lines.push(`### ${f.id} — ${f.title}`);
  lines.push("");
  lines.push(`- Severity: **${f.severity}** · Status: **${f.status}** · Source: ${f.source}`);
  if (f.signature) lines.push(`- Signature: \`${f.signature}\``);
  if (f.evidence?.url) lines.push(`- Page: ${f.evidence.url}`);
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
    lines.push(`${idx + 1}. ${describeStep(step)}`);
  });
  if (trace.length === 0) lines.push("_(no trace recorded)_");
  lines.push("");
  lines.push("Evidence:");
  lines.push("");
  if (f.failure?.message) {
    lines.push(`- Failure (${f.failure.oracle}): ${f.failure.message}`);
  }
  if (f.semantic?.expected) lines.push(`- Expected: ${f.semantic.expected}`);
  if (f.semantic?.actual) lines.push(`- Actual: ${f.semantic.actual}`);
  if (f.check) {
    lines.push(`- Deterministic check: ${f.check.kind} "${f.check.text}" in ${f.check.selector ?? "page body"}`);
  }
  if (f.evidence?.excerpt) lines.push(`- Matched excerpt: ${f.evidence.excerpt}`);
  if (f.evidence?.consoleTail?.length) {
    lines.push("- Console tail:");
    lines.push("");
    lines.push("  ```");
    for (const entry of f.evidence.consoleTail.slice(-10)) {
      lines.push(`  ${String(entry)}`);
    }
    lines.push("  ```");
  }
  if (f.evidence?.screenshot) lines.push(`- Screenshot: ${f.evidence.screenshot}`);
  if (f.reverify?.reproScript) {
    lines.push(`- Repro script: ${f.reverify.reproScript} (exits 0 when the bug reproduces)`);
  }
  lines.push("");
  return lines.join("\n");
}

function buildMd({ runId, config, findings, stats, brainMeta, generatedAt }) {
  const target = config?.target ?? {};
  const counts = countsByStatus(findings);
  const lines = [];
  lines.push(`# NightShift QA report — ${target.name ?? "target"}`);
  lines.push("");
  lines.push(`- Run: ${runId}`);
  lines.push(`- Generated: ${generatedAt}`);
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
    `**Findings:** ${counts.confirmed} confirmed · ${counts.flaky} flaky · ` +
      `${counts.unconfirmed} unconfirmed · ${counts.unverifiable} unverifiable` +
      (counts.candidate ? ` · ${counts.candidate} candidate` : "")
  );
  lines.push("");

  const groups = groupFindings(findings);
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
  return lines.join("\n");
}

// The report layer owns writing repro scripts (DESIGN: reprogen generates the
// string, report writes <runDir>/repro/<id>.mjs). reprogen is loaded lazily
// and defensively: if it is absent or a finding trips it up, the report is
// still written — a missing repro script must not sink the whole run.
function withReproScripts(runDir, findings, config) {
  let generateReproScript;
  try {
    const require = createRequire(import.meta.url);
    ({ generateReproScript } = require("./reprogen.mjs"));
  } catch {
    return findings;
  }
  if (typeof generateReproScript !== "function") return findings;
  fs.mkdirSync(path.join(runDir, "repro"), { recursive: true });
  return findings.map((f) => {
    const eligible = f.trace?.length && f.reverify && f.status !== "unverifiable";
    if (!eligible) return f;
    try {
      const script = generateReproScript(f, config);
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

  const reportJson = {
    runId,
    generatedAt,
    positioning: POSITIONING_LINE,
    brain: { mode: brainMeta.mode ?? null, model: brainMeta.model ?? null },
    target: config?.target ?? null,
    config,
    stats,
    counts: countsByStatus(finalFindings),
    findings: finalFindings,
  };

  const jsonPath = path.join(absRunDir, "report.json");
  const mdPath = path.join(absRunDir, "report.md");
  fs.writeFileSync(jsonPath, JSON.stringify(reportJson, null, 2) + "\n");
  fs.writeFileSync(
    mdPath,
    buildMd({ runId, config, findings: finalFindings, stats, brainMeta, generatedAt }) + "\n"
  );
  finalizeRun(absRunDir);
  return { jsonPath, mdPath };
}
