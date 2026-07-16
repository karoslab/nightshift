// console/page.mjs — server-rendered HTML strings for the report console.
// Zero client JS (the CSP forbids it anyway); inline styles only.

import {
  POSITIONING_LINE,
  SECTION_LABELS,
  groupFindings,
  describeStep,
  countsByStatus,
} from "../lib/report.mjs";

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2.5rem 1.5rem 4rem;
    background: #0b0e14; color: #d7dce3;
    font: 15px/1.65 -apple-system, "Segoe UI", "Helvetica Neue", sans-serif;
  }
  main { max-width: 900px; margin: 0 auto; }
  h1 { font-size: 1.7rem; letter-spacing: .02em; margin: 0 0 .4rem; color: #f2f4f8; }
  h2 { font-size: 1.15rem; margin: 2.2rem 0 .8rem; color: #e8ebf0; }
  h3 { font-size: 1rem; margin: 0 0 .5rem; color: #f2f4f8; }
  a { color: #86b3f7; text-decoration: none; }
  a:hover { text-decoration: underline; }
  code, .mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: .86em; }
  code { background: #161b24; padding: .1em .35em; border-radius: 4px; }
  .tagline { color: #9aa3b2; margin: 0 0 1rem; }
  .pitch {
    border-left: 3px solid #b98a2f; background: #14110a; color: #d8c79a;
    padding: .7rem 1rem; border-radius: 0 6px 6px 0; margin: 1.2rem 0;
  }
  .compliance ul { margin: .4rem 0 0; padding-left: 1.2rem; color: #aeb6c2; }
  .compliance li { margin: .3rem 0; }
  table { border-collapse: collapse; width: 100%; margin-top: .6rem; }
  th, td { text-align: left; padding: .45rem .7rem; border-bottom: 1px solid #1d2430; }
  th { color: #8b94a3; font-weight: 600; font-size: .82rem; text-transform: uppercase; letter-spacing: .05em; }
  .card {
    background: #10151d; border: 1px solid #1d2430; border-radius: 8px;
    padding: 1rem 1.2rem; margin: .9rem 0;
  }
  .badge {
    display: inline-block; font-size: .72rem; font-weight: 700; letter-spacing: .06em;
    text-transform: uppercase; padding: .12rem .5rem; border-radius: 999px; margin-right: .4rem;
  }
  .sev-critical { background: #3d1214; color: #f2a6a6; }
  .sev-major { background: #3a2a10; color: #ecc07a; }
  .sev-minor { background: #17222e; color: #92b6d8; }
  .st-confirmed { background: #10281a; color: #7fd3a1; }
  .st-text-verified { background: #102428; color: #7fc4d3; }
  .st-flaky { background: #2c2410; color: #d8bd76; }
  .st-unconfirmed { background: #1c2027; color: #9aa3b2; }
  .st-unverifiable { background: #241a2a; color: #c1a3d6; }
  .st-candidate { background: #1c2027; color: #9aa3b2; }
  ol { padding-left: 1.4rem; }
  ol li { margin: .2rem 0; }
  pre {
    background: #0e1218; border: 1px solid #1d2430; border-radius: 6px;
    padding: .7rem .9rem; overflow-x: auto; color: #c4cbd6;
  }
  .meta { color: #8b94a3; font-size: .86rem; }
  .empty { color: #8b94a3; font-style: italic; }
  footer { margin-top: 3rem; color: #5d6674; font-size: .8rem; }
`;

function layout({ title, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
<footer>NightShift QA console — localhost report viewer only. Nothing here is hosted or transmitted anywhere.</footer>
</main>
</body>
</html>`;
}

function badge(cls, text) {
  return `<span class="badge ${cls}">${escapeHtml(text)}</span>`;
}

function runRow(run) {
  const r = run.report;
  const target = r?.target?.name ?? "—";
  const generated = r?.generatedAt ?? "—";
  const confirmed = r?.counts?.confirmed ?? "—";
  const total = r?.counts?.total ?? "—";
  return `<tr>
    <td class="mono"><a href="/runs/${escapeHtml(run.runId)}">${escapeHtml(run.runId)}</a></td>
    <td>${escapeHtml(target)}</td>
    <td class="mono">${escapeHtml(String(generated))}</td>
    <td>${escapeHtml(String(confirmed))}</td>
    <td>${escapeHtml(String(total))}</td>
  </tr>`;
}

export function renderLanding({ runs = [] } = {}) {
  const runList = runs.length
    ? `<table>
        <tr><th>Run</th><th>Target</th><th>Generated</th><th>Confirmed</th><th>Findings</th></tr>
        ${runs.map(runRow).join("\n")}
      </table>`
    : `<p class="empty">No runs yet. Start one with <code>nightshift run</code> (or <code>nightshift demo</code> for the zero-cost demo).</p>`;

  const body = `
<h1>NightShift QA</h1>
<p class="tagline">The overnight QA employee you run on your own machine, with your own Claude —
it only files bugs it can deterministically reproduce, with the LLM out of the loop.</p>
<p class="pitch">${escapeHtml(POSITIONING_LINE)} Prefer metered billing? Bring your own Anthropic API key with one config line.</p>
<section class="compliance">
  <h2>How it stays inside the lines</h2>
  <ul>
    <li>100% local — no hosted service, no pooled credentials. This console is a localhost report viewer only.</li>
    <li>Subscription mode drives your own unmodified official <code>claude</code> CLI; NightShift never reads, stores, logs, or transmits OAuth tokens or anything under <code>~/.claude/</code>.</li>
    <li>API-key mode is a first-class toggle (<code>brain.mode: "api-key"</code>) using your own key from an env var — switching is a config edit, not a rewrite.</li>
    <li>No telemetry. Network calls go only to your app under test (and api.anthropic.com in api-key mode).</li>
    <li>Conservative default budgets keep usage within ordinary individual territory; you remain responsible for your own Anthropic account and limits.</li>
  </ul>
</section>
<section>
  <h2>Runs</h2>
  ${runList}
</section>`;
  return layout({ title: "NightShift QA — console", body });
}

function findingCard(f) {
  const sev = badge(`sev-${escapeHtml(f.severity ?? "minor")}`, f.severity ?? "?");
  const st = badge(`st-${escapeHtml(f.status ?? "candidate")}`, f.status ?? "?");
  const steps = (f.trace ?? [])
    .map((step) => `<li>${escapeHtml(describeStep(step))}</li>`)
    .join("\n");
  const evidence = [];
  if (f.failure?.message) {
    evidence.push(`<li>Failure (${escapeHtml(f.failure.oracle ?? "?")}): ${escapeHtml(f.failure.message)}</li>`);
  }
  if (f.semantic?.expected) evidence.push(`<li>Expected: ${escapeHtml(f.semantic.expected)}</li>`);
  if (f.semantic?.actual) evidence.push(`<li>Actual: ${escapeHtml(f.semantic.actual)}</li>`);
  if (f.evidence?.excerpt) evidence.push(`<li>Matched excerpt: <code>${escapeHtml(f.evidence.excerpt)}</code></li>`);
  if (f.evidence?.screenshot) evidence.push(`<li>Screenshot: <code>${escapeHtml(f.evidence.screenshot)}</code></li>`);
  if (f.reverify?.reproScript) {
    evidence.push(`<li>Repro script: <code>${escapeHtml(f.reverify.reproScript)}</code> (exits 0 when the bug reproduces)</li>`);
  }
  const consoleTail = f.evidence?.consoleTail?.length
    ? `<pre>${escapeHtml(f.evidence.consoleTail.slice(-10).join("\n"))}</pre>`
    : "";
  const reverifyLine = f.reverify
    ? `<p class="meta">Re-verified: reproduced ${escapeHtml(String(f.reverify.reproduced))}/${escapeHtml(
        String(f.reverify.replays)
      )} replays${f.reverify.minimized ? " · trace minimized" : ""}</p>`
    : "";
  return `<div class="card">
  <h3>${escapeHtml(f.id ?? "?")} — ${escapeHtml(f.title ?? "untitled finding")}</h3>
  <p>${sev}${st}<span class="meta mono">${escapeHtml(f.signature ?? "")}</span></p>
  ${reverifyLine}
  <p class="meta">Steps to reproduce:</p>
  <ol>${steps || "<li>(no trace recorded)</li>"}</ol>
  <p class="meta">Evidence:</p>
  <ul>${evidence.join("\n") || "<li>(none)</li>"}</ul>
  ${consoleTail}
</div>`;
}

export function renderRunPage(run) {
  const r = run.report;
  if (!r) {
    const body = `
<p class="meta"><a href="/">&larr; All runs</a></p>
<h1>Run ${escapeHtml(run.runId)}</h1>
<p class="empty">This run has no report.json yet — it may still be in progress.</p>`;
    return layout({ title: `NightShift — run ${run.runId}`, body });
  }
  const counts = r.counts ?? countsByStatus(r.findings ?? []);
  const groups = groupFindings(r.findings ?? []);
  const sections = groups
    .map(
      (g) => `<h2>${escapeHtml(SECTION_LABELS[g.status] ?? g.status)} (${g.findings.length})</h2>
${g.findings.map(findingCard).join("\n")}`
    )
    .join("\n");
  const usage = r.stats?.usage ?? {};
  const body = `
<p class="meta"><a href="/">&larr; All runs</a></p>
<h1>Run ${escapeHtml(run.runId)} — ${escapeHtml(r.target?.name ?? "target")}</h1>
<p class="meta">
  Target: <code>${escapeHtml(r.target?.url ?? "?")}</code> ·
  Brain: ${escapeHtml(r.brain?.mode ?? "?")} (model: ${escapeHtml(r.brain?.model ?? "?")}) ·
  Tokens: ${escapeHtml(String(usage.inputTokens ?? 0))} in / ${escapeHtml(String(usage.outputTokens ?? 0))} out ·
  Generated: ${escapeHtml(r.generatedAt ?? "?")}
</p>
<p class="pitch">${escapeHtml(POSITIONING_LINE)}</p>
<p><strong>${escapeHtml(String(counts.confirmed ?? 0))} confirmed</strong> ·
${escapeHtml(String(counts["text-verified"] ?? 0))} text-verified ·
${escapeHtml(String(counts.flaky ?? 0))} flaky ·
${escapeHtml(String(counts.unconfirmed ?? 0))} unconfirmed ·
${escapeHtml(String(counts.unverifiable ?? 0))} unverifiable</p>
${sections || '<p class="empty">No findings recorded for this run.</p>'}`;
  return layout({ title: `NightShift — run ${run.runId}`, body });
}

export function renderNotFound(pathname) {
  const body = `
<h1>404 — not found</h1>
<p class="meta">No route matches <code>${escapeHtml(pathname)}</code>.</p>
<p><a href="/">&larr; Back to the console</a></p>`;
  return layout({ title: "NightShift — not found", body });
}
