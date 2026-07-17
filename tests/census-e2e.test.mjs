// tests/census-e2e.test.mjs — browser-driven end-to-end for the expected-element
// oracle against the bundled Bugbox demo. Proves the short4movies case: seed a
// baseline, land a CSS change that hides one control at tablet width only, and
// the next sweep confirms exactly ONE expected-element finding naming that
// control and viewport class, with a repro script that exits 0 while broken and
// non-zero once reverted. Also proves two unchanged runs never flake.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = path.join(ROOT, "bin", "nightshift.mjs");

function run(cmd, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function newestRunDir(reportDir) {
  const dirs = fsSync
    .readdirSync(reportDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{8}-\d{6}$/.test(d.name))
    .map((d) => d.name)
    .sort();
  return path.join(reportDir, dirs.at(-1));
}

async function sweepAndRead(configPath, reportDir, cwd) {
  const res = await run(process.execPath, [BIN, "run", "--config", configPath, "--sweep"], { cwd });
  assert.equal(res.code, 0, `sweep failed (exit ${res.code})\n${res.stdout}\n${res.stderr}`);
  const runDir = newestRunDir(reportDir);
  const report = JSON.parse(await fs.readFile(path.join(runDir, "report.json"), "utf8"));
  return { runDir, report };
}

const expectedElementFindings = (report) => report.findings.filter((f) => f.source === "oracle:expected-element");

async function setup() {
  const { startBugbox } = await import(new URL("../demo-app/server.mjs", import.meta.url).href);
  const state = { hideTabletControl: false };
  const bugbox = await startBugbox(0, state);
  const workDir = path.join(ROOT, "node_modules", ".cache", `nightshift-census-${crypto.randomUUID()}`);
  const reportDir = path.join(workDir, "reports");
  await fs.mkdir(reportDir, { recursive: true });
  const configPath = path.join(workDir, "config.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({
      target: { name: "Bugbox", url: `http://127.0.0.1:${bugbox.port}`, routes: ["/responsive"], maxRoutes: 1 },
      report: { dir: reportDir },
      oracles: { expectedElements: { enabled: true, ignoreSelectors: [] } },
    }),
  );
  return { bugbox, state, workDir, reportDir, configPath };
}

test("seed -> hide a control at tablet width -> exactly one confirmed finding + working repro", { timeout: 300_000 }, async () => {
  const { bugbox, state, workDir, reportDir, configPath } = await setup();
  try {
    // 1) First enabled run SEEDS the baseline and reports nothing.
    const seed = await sweepAndRead(configPath, reportDir, ROOT);
    assert.deepEqual(expectedElementFindings(seed.report), [], "a seeding run must not flag anything");
    assert.ok(fsSync.existsSync(path.join(reportDir, "baselines", "meta.json")), "baseline meta.json seeded");

    // 2) A CSS change hides "Search" at the tablet band (640–900px) only.
    state.hideTabletControl = true;
    const broken = await sweepAndRead(configPath, reportDir, ROOT);
    const findings = expectedElementFindings(broken.report);
    assert.equal(findings.length, 1, `expected exactly one expected-element finding, got ${JSON.stringify(findings.map((f) => f.title))}`);
    const finding = findings[0];
    assert.equal(finding.status, "confirmed", `finding must confirm on reverify (was ${finding.status})`);
    assert.equal(finding.severity, "major");
    assert.equal(finding.census.viewport.name, "tablet", "the disappearance is at the tablet class");
    assert.equal(finding.census.element.name, "Search", "the finding names the vanished control");
    assert.match(finding.title, /Search/);
    assert.match(finding.title, /tablet/);

    // 3) The repro script exits 0 while the control is missing...
    const rel = finding.reverify?.reproScript;
    assert.ok(rel, "confirmed finding must carry a repro script");
    const scriptPath = path.isAbsolute(rel) ? rel : path.join(broken.runDir, rel);
    const reproBroken = await run(process.execPath, [scriptPath], { cwd: broken.runDir });
    assert.equal(reproBroken.code, 0, `repro must exit 0 while broken\n${reproBroken.stdout}\n${reproBroken.stderr}`);
    assert.match(reproBroken.stdout, /REPRODUCED/);

    // 4) ...and flips to non-zero once the CSS is reverted (control restored).
    state.hideTabletControl = false;
    const reproFixed = await run(process.execPath, [scriptPath], { cwd: broken.runDir });
    assert.equal(reproFixed.code, 1, `repro must exit non-zero once restored\n${reproFixed.stdout}\n${reproFixed.stderr}`);
    assert.match(reproFixed.stdout, /NOT REPRODUCED/);
  } finally {
    await bugbox.close();
    await fs.rm(workDir, { recursive: true, force: true });
  }
});

test("two consecutive unchanged runs produce ZERO expected-element findings (no flake)", { timeout: 300_000 }, async () => {
  const { bugbox, workDir, reportDir, configPath } = await setup();
  try {
    const first = await sweepAndRead(configPath, reportDir, ROOT); // seeds
    assert.deepEqual(expectedElementFindings(first.report), []);
    const second = await sweepAndRead(configPath, reportDir, ROOT); // unchanged
    assert.deepEqual(expectedElementFindings(second.report), [], "an unchanged run must never manufacture a disappearance");
  } finally {
    await bugbox.close();
    await fs.rm(workDir, { recursive: true, force: true });
  }
});

test("baseline accept drops an intentional removal so it never re-flags", { timeout: 300_000 }, async () => {
  const { bugbox, state, workDir, reportDir, configPath } = await setup();
  try {
    await sweepAndRead(configPath, reportDir, ROOT); // seed
    state.hideTabletControl = true;
    const broken = await sweepAndRead(configPath, reportDir, ROOT);
    const finding = expectedElementFindings(broken.report)[0];
    assert.ok(finding, "a finding to accept");

    // Accept the disappearance as intended.
    const runId = path.basename(broken.runDir);
    const accept = await run(process.execPath, [BIN, "baseline", "accept", finding.id, "--run", runId, "--config", configPath], { cwd: ROOT });
    assert.equal(accept.code, 0, `baseline accept failed\n${accept.stdout}\n${accept.stderr}`);

    // A subsequent run with the control still hidden no longer flags it.
    const after = await sweepAndRead(configPath, reportDir, ROOT);
    assert.deepEqual(expectedElementFindings(after.report), [], "an accepted disappearance must not re-flag");
  } finally {
    await bugbox.close();
    await fs.rm(workDir, { recursive: true, force: true });
  }
});
