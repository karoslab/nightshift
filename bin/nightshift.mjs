#!/usr/bin/env node
// bin/nightshift.mjs — CLI entry. Commands: init/doctor/run/overnight/verify/console/demo.
// Pipeline modules (session, reverify, report, ...) are imported lazily inside
// each command so init/doctor keep working while the rest of the tree builds.
import { existsSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig, ConfigError } from "../lib/config.mjs";
// countsByStatus is dependency-free (report.mjs only pulls in fs/runstore/reprogen,
// never playwright), so a static import here is safe and keeps buildCiSummary
// unit-testable without booting a browser.
import { countsByStatus } from "../lib/report.mjs";

// Pinned log shape: (level, message) => void, levels "info" | "warn" | "error".
const log = (level, message) => console.error("[" + level + "] " + message);

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));

const USAGE = `NightShift QA — the overnight QA employee that only files bugs it can prove.

usage: nightshift <command> [options]

commands:
  init                       write nightshift.config.json into the current directory
  doctor [--config path]     check config, target reachability, brain auth, browser
  run [--config path] [--brain mock] [--sweep] [--resume <runId>]
      [--ci] [--severity-floor minor|major|critical]
                             one QA session -> reverify candidates -> report
                             --sweep: deterministic exhaustive crawl (no LLM);
                             --resume: continue an interrupted sweep run dir;
                             --ci: machine-readable summary.json + exit nonzero
                             when a confirmed finding meets --severity-floor
                             (default major) or exploration did not happen
  overnight [--config path]  sessions in a loop within budget until stop hour
  verify <findingId> [--run <runId>] [--config path]
                             replay one finding from an existing report
  console [--port 4184] [--config path]
                             serve the localhost report console
  demo                       boot the seeded-bug demo app, run a scripted session (no LLM)`;

function parseArgs(args) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals };
}

// ---------------------------------------------------------------------------
// Demo mock brain script — drives Bugbox (demo-app/server.mjs). Element ids
// assume Bugbox's pinned DOM/enumeration order (document order, DESIGN.md):
//   0 nav link "About", 1 "Choose color", 2 "Add to cart", 3 "Load deals",
//   4 "Apply coupon", 5 footer link "Warranty info".
// tests/e2e.test.mjs verifies these ids against the real Bugbox.
// ---------------------------------------------------------------------------
const BUGBOX_IDS = { about: 0, chooseColor: 1, addToCart: 2, loadDeals: 3, applyCoupon: 4, warranty: 5 };

function demoMockScript() {
  return [
    { action: { kind: "click", elementId: BUGBOX_IDS.chooseColor, why: "try the color picker" }, findings: [], done: false },
    { action: { kind: "click", elementId: BUGBOX_IDS.addToCart, why: "add the item to the cart" }, findings: [], done: false },
    { action: { kind: "click", elementId: BUGBOX_IDS.loadDeals, why: "load the deals list" }, findings: [], done: false },
    { action: { kind: "click", elementId: BUGBOX_IDS.applyCoupon, why: "apply a coupon to the cart" }, findings: [], done: false },
    {
      // No action this turn: the semantic finding must snapshot the post-coupon
      // page state, so the trace ends at the "Apply coupon" click.
      action: null,
      findings: [
        {
          title: 'Applying a coupon renders "Total: NaN"',
          severity: "major",
          expected: "Applying the coupon shows a numeric order total",
          actual: 'The order total reads "Total: NaN"',
          check: { kind: "text-present", selector: "#total", text: "Total: NaN" },
        },
      ],
      done: false,
    },
    { action: { kind: "click", elementId: BUGBOX_IDS.warranty, why: "open the warranty info page" }, findings: [], done: false },
    // Next page visit (/about, the false-positive canary): nothing to report.
    { action: null, findings: [], done: true },
  ];
}

// ---------------------------------------------------------------------------
// Shared pipeline plumbing
// ---------------------------------------------------------------------------
// demoMockScript()'s elementIds are pinned to Bugbox's exact DOM order (see
// the comment above BUGBOX_IDS) — running it against any other app clicks
// whatever elements happen to land on those ids. Fail closed: verify the
// target actually serves Bugbox before wiring the scripted brain to it.
const BUGBOX_MARKERS = ["<title>Bugbox</title>", 'id="choose-color"', 'id="add-to-cart"', 'id="load-deals"', 'id="apply-coupon"'];

export async function assertMockBrainTargetIsBugbox(url) {
  let body;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    body = await res.text();
  } catch (err) {
    throw new Error(
      `--brain mock refuses to run against ${url}: could not reach it to verify it is the bundled Bugbox demo (${err?.message ?? err})`
    );
  }
  if (!BUGBOX_MARKERS.every((marker) => body.includes(marker))) {
    throw new Error(
      `--brain mock refuses to run against ${url}: it does not look like the bundled Bugbox demo. ` +
        `The mock brain's scripted clicks are pinned to Bugbox's exact DOM and would click random elements on a real app — use a real brain.mode instead, or drop --brain mock.`
    );
  }
}

async function makeBrain(config) {
  if (config.brain.mode === "mock") {
    await assertMockBrainTargetIsBugbox(config.target.url);
    const { createMockBrain } = await import("../lib/brain/mock.mjs");
    return createMockBrain(demoMockScript());
  }
  const { createBrain } = await import("../lib/brain/index.mjs");
  return createBrain(config);
}

async function withBrain(config, fn) {
  const brain = await makeBrain(config);
  try {
    return await fn(brain);
  } finally {
    await brain.close?.();
  }
}

const brainMeta = (config, brain) => ({
  mode: brain.mode ?? config.brain.mode,
  model: brain.model ?? config.brain.model,
});

// candidates -> reverify each -> repro script for confirmed/text-verified/flaky -> writeReport
async function reverifyAndReport({ config, findings, stats, brainMeta: meta, runDir, log }) {
  const { reverifyFinding } = await import("../lib/reverify.mjs");
  const { generateReproScript } = await import("../lib/reprogen.mjs");
  const { writeReport, computeRunState } = await import("../lib/report.mjs");

  const finals = [];
  for (const candidate of findings) {
    const finding = await reverifyFinding(candidate, { config, log });
    if (finding.status === "confirmed" || finding.status === "text-verified" || finding.status === "flaky") {
      const source = await generateReproScript(finding, config);
      const rel = path.join("repro", `${finding.id}.mjs`);
      await fs.mkdir(path.join(runDir, "repro"), { recursive: true });
      await fs.writeFile(path.join(runDir, rel), source);
      finding.reverify ??= {};
      finding.reverify.reproScript ??= rel;
    }
    finals.push(finding);
  }

  const { jsonPath, mdPath } = await writeReport(runDir, { config, findings: finals, stats, brainMeta: meta });
  return { jsonPath, mdPath, findings: finals, runState: computeRunState(stats) };
}

// runState "failed"/"inconclusive" means meaningful exploration did not
// happen (brain turns mostly failed, or the session never executed a single
// action) — a zero-finding report in that case is not a "clean run", it's a
// run that produced no evidence either way, and must not read like a pass.
export function exitCodeForRunState(runState) {
  return runState === "failed" || runState === "inconclusive" ? 1 : 0;
}

// ---------------------------------------------------------------------------
// CI mode (nightshift run --ci) — machine-readable gating for GitHub Actions.
// Severity ordering matches lib/collector.mjs (SEVERITY_BY_ORACLE) and the
// brain prompt: critical > major > minor. A CI run "fails" (nonzero exit) when
// a *confirmed* finding meets the severity floor — confirmed is the only status
// with a deterministic repro (text-verified/flaky/unconfirmed are weaker and do
// not gate). A run that never explored (runState failed/inconclusive) also
// fails: a zero-finding report from an app that never loaded is a false green.
// ---------------------------------------------------------------------------
export const SEVERITY_FLOORS = ["minor", "major", "critical"];
const SEVERITY_RANK = { minor: 1, major: 2, critical: 3 };

export function severityAtOrAbove(severity, floor) {
  const s = SEVERITY_RANK[severity] ?? 0; // unknown severity clears no floor
  const f = SEVERITY_RANK[floor] ?? SEVERITY_RANK.major;
  return s >= f;
}

export function ciBlockingFindings(findings = [], severityFloor = "major") {
  return findings.filter((f) => f.status === "confirmed" && severityAtOrAbove(f.severity, severityFloor));
}

export function ciExitCode({ findings = [], runState, severityFloor = "major" }) {
  if (exitCodeForRunState(runState) !== 0) return 1;
  return ciBlockingFindings(findings, severityFloor).length > 0 ? 1 : 0;
}

// Pure, JSON-serializable CI summary written to <runDir>/summary.json and
// echoed to stdout. blocking[] carries the repro script path for each gating
// finding so the PR comment can link runnable proof.
export function buildCiSummary({ runId, target = {}, findings = [], runState, severityFloor = "major", generatedAt }) {
  const blocking = ciBlockingFindings(findings, severityFloor).map((f) => ({
    id: f.id,
    title: f.title ?? null,
    severity: f.severity ?? null,
    status: f.status,
    source: f.source ?? null,
    page: f.evidence?.url ?? null,
    reproScript: f.reverify?.reproScript ?? null,
  }));
  const exitCode = ciExitCode({ findings, runState, severityFloor });
  return {
    schemaVersion: 1,
    runId: runId ?? null,
    generatedAt: generatedAt ?? null,
    target: { name: target.name ?? null, url: target.url ?? null },
    runState: runState ?? null,
    severityFloor,
    exitCode,
    pass: exitCode === 0,
    counts: countsByStatus(findings),
    blocking,
  };
}

function normalizeSeverityFloor(value) {
  if (value === undefined) return "major";
  if (!SEVERITY_FLOORS.includes(value)) {
    throw new ConfigError(`--severity-floor must be one of ${SEVERITY_FLOORS.join(", ")} — got ${JSON.stringify(value)}`);
  }
  return value;
}

// Terminal step for `run`/`run --sweep`: in --ci mode write summary.json next
// to report.json and emit it as the single stdout object; otherwise print the
// human findings table. Sets process.exitCode either way.
async function finishRun({ flags, config, runDir, findings, runState, mdPath }) {
  if (!flags.ci) {
    printSummary(findings, mdPath, runState);
    process.exitCode = exitCodeForRunState(runState);
    return;
  }
  const severityFloor = normalizeSeverityFloor(flags["severity-floor"]);
  const summary = buildCiSummary({
    runId: path.basename(path.resolve(runDir)),
    target: config.target,
    findings,
    runState,
    severityFloor,
    generatedAt: new Date().toISOString(),
  });
  await fs.writeFile(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  // Machine-friendly: stdout is exactly this JSON object; all human logs go to stderr.
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  process.exitCode = summary.exitCode;
}

function printSummary(findings, mdPath, runState) {
  const pad = (s, n) => String(s).padEnd(n);
  console.log("");
  console.log("NightShift findings");
  console.log("-------------------");
  if (findings.length === 0) {
    if (exitCodeForRunState(runState) !== 0) {
      console.log(`(no findings — run state: ${runState}, exploration did not complete; see report.json for stats)`);
    } else {
      console.log("(none — clean run)");
    }
  }
  const counts = {};
  for (const f of findings) {
    counts[f.status] = (counts[f.status] ?? 0) + 1;
    console.log(`${pad(f.id, 8)} ${pad(f.status, 13)} ${pad(f.severity ?? "-", 9)} ${f.title}`);
  }
  const tally = Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join("  ");
  if (tally) console.log("\n" + tally);
  console.log(`\nReport: ${mdPath}`);
}

function mergeStats(a, b) {
  if (!a) return b;
  return {
    routesVisited: a.routesVisited + b.routesVisited,
    actionsExecuted: a.actionsExecuted + b.actionsExecuted,
    llmCalls: a.llmCalls + b.llmCalls,
    turnsOk: (a.turnsOk ?? 0) + (b.turnsOk ?? 0),
    turnsFailed: (a.turnsFailed ?? 0) + (b.turnsFailed ?? 0),
    startedAt: a.startedAt,
    endedAt: b.endedAt,
    durationMs: a.durationMs + b.durationMs,
    usage: {
      inputTokens: a.usage.inputTokens + b.usage.inputTokens,
      outputTokens: a.usage.outputTokens + b.usage.outputTokens,
      costUsd:
        a.usage.costUsd == null && b.usage.costUsd == null
          ? null
          : (a.usage.costUsd ?? 0) + (b.usage.costUsd ?? 0),
    },
  };
}

function emptyStats() {
  const now = new Date().toISOString();
  return {
    routesVisited: 0,
    actionsExecuted: 0,
    llmCalls: 0,
    turnsOk: 0,
    turnsFailed: 0,
    startedAt: now,
    endedAt: now,
    durationMs: 0,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
  };
}

// Overnight loop core (exported for tests). Per-session error containment is
// load-bearing: one transient session crash at 3am (chromium.launch hiccup,
// navigation racing a page call) must NOT discard the candidates earlier
// sessions already collected — contain it, stop launching sessions, and let
// the caller fall through to reverify + report with everything gathered so far.
export async function collectOvernightFindings({ night, runOneSession, log }) {
  const all = [];
  const seenSignatures = new Set();
  let stats = null;
  let sessions = 0;
  while (night.sessionAllowed(sessions) && night.beforeStopHour()) {
    log("info", `overnight: starting session ${sessions + 1}`);
    let result;
    try {
      result = await runOneSession();
    } catch (e) {
      log(
        "error",
        `overnight: session ${sessions + 1} crashed — keeping the ${all.length} candidate(s) from completed sessions: ` +
          (e?.stack ?? String(e))
      );
      break;
    }
    for (const finding of result.findings) {
      if (finding.signature && seenSignatures.has(finding.signature)) continue;
      if (finding.signature) seenSignatures.add(finding.signature);
      all.push(finding);
    }
    stats = mergeStats(stats, result.stats);
    sessions++;
  }
  return { findings: all, stats, sessions };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
async function cmdInit() {
  const dest = path.resolve("nightshift.config.json");
  if (existsSync(dest)) {
    console.error("nightshift.config.json already exists — not overwriting.");
    process.exitCode = 1;
    return;
  }
  await fs.copyFile(here("../examples/nightshift.config.json"), dest);
  console.log(`wrote ${dest}`);
  console.log("edit target.url, then run: nightshift doctor");
}

async function cmdDoctor(flags) {
  const { runDoctor } = await import("../lib/doctor.mjs");
  const { ok, checks } = await runDoctor({ configPath: flags.config });
  for (const check of checks) {
    console.log(`[${check.status.padEnd(4)}] ${check.name}: ${check.message}`);
  }
  console.log(ok ? "\ndoctor: all checks passed" : "\ndoctor: FAILED — fix the [fail] lines above");
  process.exitCode = ok ? 0 : 1;
}

// Resolve the run dir: --resume <runId> continues an existing run dir (sweep
// checkpoint lives there); otherwise a fresh run dir is minted.
async function resolveRunDir(config, flags) {
  const { createRun } = await import("../lib/runstore.mjs");
  if (flags.resume) {
    const runDir = path.join(path.resolve(config.report.dir), String(flags.resume));
    if (!existsSync(runDir)) throw new Error(`--resume: run dir not found: ${runDir}`);
    return { runDir };
  }
  return createRun(config);
}

async function cmdRun(flags) {
  const config = loadConfig(flags.config);
  if (flags.ci) normalizeSeverityFloor(flags["severity-floor"]); // fail fast before a full crawl
  if (flags.sweep) config.target.sweep = true;

  // Sweep mode is deterministic and LLM-free — it never constructs a brain
  // (skipping subscription/api auth and the mock-brain Bugbox guard entirely).
  if (config.target.sweep) return await cmdRunSweep(config, flags);

  if (flags.brain === "mock") config.brain.mode = "mock";

  await withBrain(config, async (brain) => {
    const { createRun } = await import("../lib/runstore.mjs");
    const { runSession } = await import("../lib/session.mjs");
    const { runDir } = await createRun(config);
    log("info", `run: starting session against ${config.target.url}`);
    const { findings, stats } = await runSession({ config, brain, runDir, log });
    log("info", `run: session done — ${findings.length} candidate(s), reverifying`);
    const { mdPath, findings: finals, runState } = await reverifyAndReport({
      config,
      findings,
      stats,
      brainMeta: brainMeta(config, brain),
      runDir,
      log,
    });
    await finishRun({ flags, config, runDir, findings: finals, runState, mdPath });
  });
  // exit 0 regardless of bugs found — bugs are the product, not an error.
  // Nonzero only when runState says exploration itself didn't happen.
}

// Deterministic sweep: exhaustive same-origin crawl, every interactive element
// exercised, three input passes per form — no brain. Findings are shaped like
// explorer findings, so reverify + report run unchanged.
async function cmdRunSweep(config, flags) {
  const { runSweep } = await import("../lib/sweep.mjs");
  const { runDir } = await resolveRunDir(config, flags);
  log("info", `run: starting deterministic sweep against ${config.target.url}${flags.resume ? " (resume)" : ""}`);
  const { findings, stats } = await runSweep({ config, runDir, log });
  log(
    "info",
    `run: sweep done — ${findings.length} candidate(s), ${stats.coverage?.totals?.coveragePct ?? 0}% element coverage, reverifying`,
  );
  const { mdPath, findings: finals, runState } = await reverifyAndReport({
    config,
    findings,
    stats,
    brainMeta: { mode: "sweep", model: "deterministic" },
    runDir,
    log,
  });
  await finishRun({ flags, config, runDir, findings: finals, runState, mdPath });
}

async function cmdOvernight(flags) {
  const config = loadConfig(flags.config);
  if (flags.brain === "mock") config.brain.mode = "mock";

  const { createNightBudget } = await import("../lib/budget.mjs");
  const { createRun } = await import("../lib/runstore.mjs");
  const { runSession, createIdMinter } = await import("../lib/session.mjs");
  const night = createNightBudget(config.budget); // created ONCE for the whole night

  await withBrain(config, async (brain) => {
    const { runDir } = await createRun(config); // one run dir aggregates all sessions
    // ONE id minter for the whole night: the sessions share runDir, so a
    // per-session counter would mint NS-001 twice — colliding screenshots,
    // repro scripts, and report entries (misattributed evidence).
    const mintId = createIdMinter();

    // runSession creates a fresh session budget from config.budget each call.
    const { findings: all, stats, sessions } = await collectOvernightFindings({
      night,
      runOneSession: () => runSession({ config, brain, runDir, log, mintId }),
      log,
    });
    log("info", `overnight: ${sessions} session(s) complete — ${all.length} candidate(s), reverifying`);

    const { mdPath, findings: finals, runState } = await reverifyAndReport({
      config,
      findings: all,
      stats: stats ?? emptyStats(),
      brainMeta: brainMeta(config, brain),
      runDir,
      log,
    });
    printSummary(finals, mdPath, runState);
    process.exitCode = exitCodeForRunState(runState);
  });
}

async function readLatestRunId(reportDir) {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(reportDir, "latest.json"), "utf8"));
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed === "object") return parsed.runId ?? parsed.id ?? parsed.latest ?? null;
  } catch {
    // fall through to directory scan
  }
  try {
    const dirs = (await fs.readdir(reportDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    return dirs.at(-1) ?? null;
  } catch {
    return null;
  }
}

async function cmdVerify(flags, positionals) {
  const findingId = positionals[0];
  if (!findingId) {
    console.error("usage: nightshift verify <findingId> [--run <runId>] [--config path]");
    process.exitCode = 2;
    return;
  }
  const config = loadConfig(flags.config);
  const reportDir = path.resolve(config.report.dir);
  const runId = flags.run ?? (await readLatestRunId(reportDir));
  if (!runId) throw new Error(`no runs found in ${reportDir} — run \`nightshift run\` first`);

  const runDir = path.join(reportDir, String(runId));
  const reportPath = path.join(runDir, "report.json");
  const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
  const findings = Array.isArray(report.findings) ? report.findings : [];
  const finding = findings.find((f) => f.id === findingId);
  if (!finding) throw new Error(`finding ${findingId} not found in ${reportPath}`);

  const { reverifyFinding } = await import("../lib/reverify.mjs");
  log("info", `verify: replaying ${findingId} against ${config.target.url}`);
  const verified = await reverifyFinding(finding, { config, log });
  const rv = verified.reverify ?? {};
  console.log(`${verified.id}: ${verified.status} (${rv.reproduced ?? "?"}/${rv.replays ?? "?"} replays reproduced)`);
  if (Array.isArray(rv.verdicts)) console.log(`verdicts: ${rv.verdicts.join(", ")}`);
  process.exitCode = verified.status === "confirmed" || verified.status === "text-verified" ? 0 : 1;
}

async function cmdConsole(flags) {
  const args = [here("../console/server.mjs")];
  if (flags.port) args.push("--port", String(flags.port));
  if (flags.config !== undefined || existsSync(path.resolve("nightshift.config.json"))) {
    const config = loadConfig(flags.config);
    args.push("--data-dir", path.resolve(config.report.dir));
  }
  const child = spawn(process.execPath, args, { stdio: "inherit" });
  process.exitCode = await new Promise((resolve) => child.on("exit", (code) => resolve(code ?? 0)));
}

function waitForBugboxPort(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(
      () => finish(reject, new Error(`demo app did not print "BUGBOX LISTENING <port>" within ${timeoutMs}ms`)),
      timeoutMs
    );
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const match = buffer.match(/^BUGBOX LISTENING (\d+)/m);
      if (match) finish(resolve, Number(match[1]));
    });
    child.on("exit", (code) => finish(reject, new Error(`demo app exited early (code ${code})`)));
    child.on("error", (e) => finish(reject, e));
  });
}

async function killChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const hardKill = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }, 3000);
  await exited;
  clearTimeout(hardKill);
}

// In-memory demo config: pinned defaults + Bugbox target + mock brain, built
// through loadConfig (via a throwaway temp file) so it is validated/merged
// exactly like a real config.
async function demoConfig(port) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nightshift-demo-"));
  try {
    const file = path.join(dir, "nightshift.config.json");
    await fs.writeFile(
      file,
      JSON.stringify({
        target: { name: "Bugbox (demo)", url: `http://127.0.0.1:${port}`, routes: ["/"] },
        brain: { mode: "mock" },
      })
    );
    return loadConfig(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function cmdDemo() {
  const child = spawn(process.execPath, [here("../demo-app/server.mjs"), "--port", "0"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.resume(); // drain — Bugbox owns its own logging
  try {
    const port = await waitForBugboxPort(child, 10_000);
    log("info", `demo: Bugbox listening on 127.0.0.1:${port}`);
    const config = await demoConfig(port);

    await withBrain(config, async (brain) => {
      const { createRun } = await import("../lib/runstore.mjs");
      const { runSession } = await import("../lib/session.mjs");
      const { runDir } = await createRun(config);
      const { findings, stats } = await runSession({ config, brain, runDir, log });
      const { mdPath, findings: finals, runState } = await reverifyAndReport({
        config,
        findings,
        stats,
        brainMeta: brainMeta(config, brain),
        runDir,
        log,
      });
      printSummary(finals, mdPath, runState);
      process.exitCode = exitCodeForRunState(runState);
      log("info", "demo: repro scripts replay against the demo port — restart Bugbox on that port to rerun them");
    });
  } finally {
    await killChild(child); // SIGTERM, SIGKILL after 3s
  }
}

// ---------------------------------------------------------------------------
async function main(argv) {
  const [cmd, ...rest] = argv;
  const { flags, positionals } = parseArgs(rest);
  try {
    switch (cmd) {
      case "init":
        return await cmdInit();
      case "doctor":
        return await cmdDoctor(flags);
      case "run":
        return await cmdRun(flags);
      case "overnight":
        return await cmdOvernight(flags);
      case "verify":
        return await cmdVerify(flags, positionals);
      case "console":
        return await cmdConsole(flags);
      case "demo":
        return await cmdDemo();
      case undefined:
        console.error(USAGE);
        process.exitCode = 1;
        return;
      case "help":
      case "--help":
      case "-h":
        console.log(USAGE);
        return;
      default:
        console.error(`unknown command: ${cmd}\n\n${USAGE}`);
        process.exitCode = 1;
        return;
    }
  } catch (e) {
    if (e instanceof ConfigError) {
      log("error", e.message);
    } else {
      log("error", e?.stack ?? String(e));
    }
    process.exitCode = 2;
  }
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isMain) await main(process.argv.slice(2));
