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

// Pinned log shape: (level, message) => void, levels "info" | "warn" | "error".
const log = (level, message) => console.error("[" + level + "] " + message);

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));

const USAGE = `NightShift QA — the overnight QA employee that only files bugs it can prove.

usage: nightshift <command> [options]

commands:
  init                       write nightshift.config.json into the current directory
  doctor [--config path]     check config, target reachability, brain auth, browser
  run [--config path] [--brain mock]
                             one QA session -> reverify candidates -> report
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
async function makeBrain(config) {
  if (config.brain.mode === "mock") {
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

// candidates -> reverify each -> repro script for confirmed/flaky -> writeReport
async function reverifyAndReport({ config, findings, stats, brainMeta: meta, runDir, log }) {
  const { reverifyFinding } = await import("../lib/reverify.mjs");
  const { generateReproScript } = await import("../lib/reprogen.mjs");
  const { writeReport } = await import("../lib/report.mjs");

  const finals = [];
  for (const candidate of findings) {
    const finding = await reverifyFinding(candidate, { config, log });
    if (finding.status === "confirmed" || finding.status === "flaky") {
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
  return { jsonPath, mdPath, findings: finals };
}

function printSummary(findings, mdPath) {
  const pad = (s, n) => String(s).padEnd(n);
  console.log("");
  console.log("NightShift findings");
  console.log("-------------------");
  if (findings.length === 0) {
    console.log("(none — clean run)");
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
    startedAt: now,
    endedAt: now,
    durationMs: 0,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
  };
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

async function cmdRun(flags) {
  const config = loadConfig(flags.config);
  if (flags.brain === "mock") config.brain.mode = "mock";

  await withBrain(config, async (brain) => {
    const { createRun } = await import("../lib/runstore.mjs");
    const { runSession } = await import("../lib/session.mjs");
    const { runDir } = await createRun(config);
    log("info", `run: starting session against ${config.target.url}`);
    const { findings, stats } = await runSession({ config, brain, runDir, log });
    log("info", `run: session done — ${findings.length} candidate(s), reverifying`);
    const { mdPath, findings: finals } = await reverifyAndReport({
      config,
      findings,
      stats,
      brainMeta: brainMeta(config, brain),
      runDir,
      log,
    });
    printSummary(finals, mdPath);
  });
  // exit 0 regardless of bugs found — bugs are the product, not an error
}

async function cmdOvernight(flags) {
  const config = loadConfig(flags.config);
  if (flags.brain === "mock") config.brain.mode = "mock";

  const { createNightBudget } = await import("../lib/budget.mjs");
  const { createRun } = await import("../lib/runstore.mjs");
  const { runSession } = await import("../lib/session.mjs");
  const night = createNightBudget(config.budget); // created ONCE for the whole night

  await withBrain(config, async (brain) => {
    const { runDir } = await createRun(config); // one run dir aggregates all sessions
    const all = [];
    const seenSignatures = new Set();
    let stats = null;
    let sessions = 0;

    // runSession creates a fresh session budget from config.budget each call.
    while (night.sessionAllowed(sessions) && night.beforeStopHour()) {
      log("info", `overnight: starting session ${sessions + 1}`);
      const result = await runSession({ config, brain, runDir, log });
      for (const finding of result.findings) {
        if (finding.signature && seenSignatures.has(finding.signature)) continue;
        if (finding.signature) seenSignatures.add(finding.signature);
        all.push(finding);
      }
      stats = mergeStats(stats, result.stats);
      sessions++;
    }
    log("info", `overnight: ${sessions} session(s) complete — ${all.length} candidate(s), reverifying`);

    const { mdPath, findings: finals } = await reverifyAndReport({
      config,
      findings: all,
      stats: stats ?? emptyStats(),
      brainMeta: brainMeta(config, brain),
      runDir,
      log,
    });
    printSummary(finals, mdPath);
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
  process.exitCode = verified.status === "confirmed" ? 0 : 1;
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
      const { mdPath, findings: finals } = await reverifyAndReport({
        config,
        findings,
        stats,
        brainMeta: brainMeta(config, brain),
        runDir,
        log,
      });
      printSummary(finals, mdPath);
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
