// tests/ci.test.mjs — CI mode: exit-code/severity gating (unit) + a hermetic
// `nightshift run --ci --sweep` integration run against the bundled Bugbox demo
// (no LLM, no network beyond a loopback server). Importing bin/nightshift.mjs
// is safe: its isMain guard keeps main() from running under the test runner.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  severityAtOrAbove,
  ciBlockingFindings,
  ciExitCode,
  buildCiSummary,
} from "../bin/nightshift.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = path.join(ROOT, "bin", "nightshift.mjs");

const confirmed = (id, severity) => ({
  id,
  title: `${id} title`,
  severity,
  status: "confirmed",
  source: "oracle:page-error",
  evidence: { url: "http://127.0.0.1/x" },
  reverify: { reproScript: `repro/${id}.mjs` },
});

// ---------------------------------------------------------------------------
// severity ordering
// ---------------------------------------------------------------------------
test("severityAtOrAbove: critical > major > minor, floor default major", () => {
  assert.equal(severityAtOrAbove("critical", "major"), true);
  assert.equal(severityAtOrAbove("major", "major"), true);
  assert.equal(severityAtOrAbove("minor", "major"), false);
  assert.equal(severityAtOrAbove("minor", "minor"), true);
  assert.equal(severityAtOrAbove("major", "critical"), false);
  // unknown severity never clears any floor
  assert.equal(severityAtOrAbove(undefined, "minor"), false);
});

// ---------------------------------------------------------------------------
// blocking set: only status "confirmed" at/above the floor
// ---------------------------------------------------------------------------
test("ciBlockingFindings: confirmed at/above floor only, ignores weaker statuses", () => {
  const findings = [
    confirmed("NS-001", "critical"),
    confirmed("NS-002", "minor"), // confirmed but below the major floor
    { id: "NS-003", severity: "critical", status: "text-verified" }, // not confirmed
    { id: "NS-004", severity: "critical", status: "flaky" }, // not confirmed
    { id: "NS-005", severity: "major", status: "unconfirmed" },
  ];
  const blocking = ciBlockingFindings(findings, "major");
  assert.deepEqual(blocking.map((f) => f.id), ["NS-001"]);

  // Lowering the floor to minor pulls in the minor-severity confirmed one.
  assert.deepEqual(ciBlockingFindings(findings, "minor").map((f) => f.id), ["NS-001", "NS-002"]);
});

// ---------------------------------------------------------------------------
// exit code
// ---------------------------------------------------------------------------
test("ciExitCode: 0 on a healthy run with no blocking findings", () => {
  assert.equal(ciExitCode({ findings: [confirmed("NS-001", "minor")], runState: "healthy", severityFloor: "major" }), 0);
  assert.equal(ciExitCode({ findings: [], runState: "healthy", severityFloor: "major" }), 0);
  assert.equal(ciExitCode({ findings: [], runState: "degraded", severityFloor: "major" }), 0);
});

test("ciExitCode: nonzero when a confirmed finding meets the floor", () => {
  assert.equal(ciExitCode({ findings: [confirmed("NS-001", "critical")], runState: "healthy", severityFloor: "major" }), 1);
  assert.equal(ciExitCode({ findings: [confirmed("NS-001", "major")], runState: "healthy", severityFloor: "major" }), 1);
});

test("ciExitCode: nonzero when exploration did not happen, even with no findings", () => {
  // A false green on an app that never loaded is the dangerous case.
  assert.equal(ciExitCode({ findings: [], runState: "inconclusive", severityFloor: "major" }), 1);
  assert.equal(ciExitCode({ findings: [], runState: "failed", severityFloor: "major" }), 1);
});

// ---------------------------------------------------------------------------
// summary.json shape
// ---------------------------------------------------------------------------
test("buildCiSummary: machine-readable summary with blocking findings and repro paths", () => {
  const findings = [confirmed("NS-001", "critical"), confirmed("NS-002", "minor")];
  const summary = buildCiSummary({
    runId: "20260715-030000",
    target: { name: "Preview", url: "https://preview.example.com" },
    findings,
    runState: "healthy",
    severityFloor: "major",
    generatedAt: "2026-07-15T03:00:00.000Z",
  });

  assert.equal(summary.runId, "20260715-030000");
  assert.equal(summary.runState, "healthy");
  assert.equal(summary.severityFloor, "major");
  assert.equal(summary.exitCode, 1);
  assert.equal(summary.pass, false);
  assert.deepEqual(summary.target, { name: "Preview", url: "https://preview.example.com" });
  assert.equal(summary.counts.confirmed, 2);

  // Only the critical confirmed finding blocks; it carries its repro path.
  assert.equal(summary.blocking.length, 1);
  assert.equal(summary.blocking[0].id, "NS-001");
  assert.equal(summary.blocking[0].severity, "critical");
  assert.equal(summary.blocking[0].reproScript, "repro/NS-001.mjs");

  // The whole thing round-trips as JSON (it is written to summary.json).
  assert.deepEqual(JSON.parse(JSON.stringify(summary)), summary);
});

test("buildCiSummary: pass=true / exitCode 0 on a clean healthy run", () => {
  const summary = buildCiSummary({
    runId: "20260715-040000",
    target: { name: "Preview", url: "https://preview.example.com" },
    findings: [confirmed("NS-001", "minor")],
    runState: "healthy",
    severityFloor: "major",
    generatedAt: "2026-07-15T04:00:00.000Z",
  });
  assert.equal(summary.exitCode, 0);
  assert.equal(summary.pass, true);
  assert.deepEqual(summary.blocking, []);
});

// ---------------------------------------------------------------------------
// integration: `nightshift run --ci --sweep` against the bundled Bugbox demo
// ---------------------------------------------------------------------------
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

test("run --ci rejects an unknown --severity-floor before crawling (exit 2)", async () => {
  const workDir = path.join(ROOT, "node_modules", ".cache", `nightshift-ci-floor-${crypto.randomUUID()}`);
  await fs.mkdir(workDir, { recursive: true });
  try {
    const configPath = path.join(workDir, "config.json");
    // An unreachable target: if the floor were NOT validated first, the crawl
    // would fail on connection instead of on the bad flag.
    await fs.writeFile(configPath, JSON.stringify({ target: { name: "X", url: "http://127.0.0.1:9/", routes: ["/"] }, report: { dir: workDir } }));
    const res = await run(process.execPath, [BIN, "run", "--config", configPath, "--ci", "--sweep", "--severity-floor", "bogus"], { cwd: ROOT });
    assert.equal(res.code, 2, `expected exit 2 for a bad floor\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stderr, /--severity-floor must be one of minor, major, critical/);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
});

test("run --ci --sweep against Bugbox: nonzero exit, machine summary.json next to report.json", { timeout: 300_000 }, async () => {
  const { startBugbox } = await import(new URL("../demo-app/server.mjs", import.meta.url).href);
  const bugbox = await startBugbox(0);

  const workDir = path.join(ROOT, "node_modules", ".cache", `nightshift-ci-${crypto.randomUUID()}`);
  const reportDir = path.join(workDir, "reports");
  await fs.mkdir(reportDir, { recursive: true });

  try {
    const configPath = path.join(workDir, "config.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({ target: { name: "Bugbox", url: `http://127.0.0.1:${bugbox.port}`, routes: ["/"] }, report: { dir: reportDir } }),
    );

    const res = await run(process.execPath, [BIN, "run", "--config", configPath, "--ci", "--sweep"], { cwd: ROOT });

    // Bugbox seeds confirmed critical bugs (page-error, network-5xx) -> gate fails.
    assert.notEqual(res.code, 0, `expected nonzero CI exit for confirmed criticals\n${res.stdout}\n${res.stderr}`);

    // stdout is a single machine-readable JSON object (human logs go to stderr).
    const emitted = JSON.parse(res.stdout);
    assert.equal(emitted.pass, false);
    assert.equal(emitted.severityFloor, "major");
    assert.equal(emitted.exitCode, res.code);
    assert.ok(emitted.blocking.length >= 1, "at least one blocking finding");

    const runDirs = (await fs.readdir(reportDir, { withFileTypes: true })).filter((d) => d.isDirectory());
    assert.equal(runDirs.length, 1, `expected one run dir, got ${runDirs.map((d) => d.name)}`);
    const runDir = path.join(reportDir, runDirs[0].name);

    // summary.json sits next to report.json and matches what was emitted.
    const onDisk = JSON.parse(await fs.readFile(path.join(runDir, "summary.json"), "utf8"));
    assert.deepEqual(onDisk, emitted);
    await fs.access(path.join(runDir, "report.json"));

    // Every blocking finding names a repro script that actually exists on disk.
    for (const b of onDisk.blocking) {
      assert.equal(b.status, "confirmed");
      assert.ok(severityAtOrAbove(b.severity, "major"), `blocking ${b.id} is below the floor`);
      assert.ok(b.reproScript, `blocking ${b.id} has no reproScript`);
      await fs.access(path.join(runDir, b.reproScript));
    }
  } finally {
    await bugbox.close();
    await fs.rm(workDir, { recursive: true, force: true });
  }
});
