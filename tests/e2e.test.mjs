// tests/e2e.test.mjs — THE flagship test (DESIGN.md pinned e2e contract).
// Boots Bugbox in-process on an ephemeral port, runs the full pipeline via
// `nightshift run --brain mock` (scripted demo brain), and asserts the
// confirmed findings, the /about false-positive canary, executable repro
// scripts, and a marketing-string-free report.
//
// Hermetic: localhost only, no real claude CLI, port 0 everywhere.
// NOTE: depends on every agent's modules (demo-app, session, reverify,
// report, ...) being in place — it fails honestly until the tree is complete.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = path.join(ROOT, "bin", "nightshift.mjs");
const BANNED = ["free forever", "zero marginal cost", "unlimited"];

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

function pathnameOf(url) {
  try {
    return new URL(url, "http://placeholder.invalid").pathname;
  } catch {
    return String(url);
  }
}

test("e2e: full pipeline against Bugbox proves real bugs and stays quiet on /about", { timeout: 300_000 }, async () => {
  // Pinned: boot Bugbox via the startBugbox export, ephemeral port.
  const { startBugbox } = await import(new URL("../demo-app/server.mjs", import.meta.url).href);
  const bugbox = await startBugbox(0);

  // The report dir must live under the repo so generated repro scripts (which
  // `import "playwright"`) can resolve it by walking up to node_modules.
  const workDir = path.join(ROOT, "node_modules", ".cache", `nightshift-e2e-${crypto.randomUUID()}`);
  const reportDir = path.join(workDir, "reports");
  await fs.mkdir(reportDir, { recursive: true });

  try {
    const configPath = path.join(workDir, "config.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        target: { name: "Bugbox", url: `http://127.0.0.1:${bugbox.port}`, routes: ["/"] },
        report: { dir: reportDir },
      })
    );

    const res = await run(process.execPath, [BIN, "run", "--config", configPath, "--brain", "mock"], { cwd: ROOT });
    assert.equal(res.code, 0, `nightshift run failed (exit ${res.code})\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

    const runDirs = (await fs.readdir(reportDir, { withFileTypes: true })).filter((d) => d.isDirectory());
    assert.equal(runDirs.length, 1, `expected exactly one run dir, got ${runDirs.map((d) => d.name)}`);
    const runDir = path.join(reportDir, runDirs[0].name);

    const report = JSON.parse(await fs.readFile(path.join(runDir, "report.json"), "utf8"));
    const findings = report.findings;
    assert.ok(Array.isArray(findings), "report.json must contain a findings array");

    // >= 3 confirmed findings covering page-error + network-5xx + dead-link.
    const confirmed = findings.filter((f) => f.status === "confirmed");
    assert.ok(
      confirmed.length >= 3,
      `expected >= 3 confirmed findings, got ${confirmed.length}: ${JSON.stringify(findings.map((f) => [f.id, f.source, f.status]))}`
    );
    for (const source of ["oracle:page-error", "oracle:network-5xx", "oracle:dead-link"]) {
      assert.ok(
        confirmed.some((f) => f.source === source),
        `missing confirmed finding with source ${source}; confirmed: ${JSON.stringify(confirmed.map((f) => f.source))}`
      );
    }

    // The Total: NaN semantic finding, text-verified via its text-present
    // check — a text assertion proves presence/absence only, so it gets its
    // own tier rather than "confirmed" (reserved for deterministic oracle
    // signatures).
    const nan = findings.find((f) => f.source === "brain:semantic" && /total:\s*nan/i.test(f.signature ?? ""));
    assert.ok(nan, `semantic Total: NaN finding missing; findings: ${JSON.stringify(findings.map((f) => [f.source, f.signature]))}`);
    assert.ok(String(nan.signature).startsWith("text-present|"), `semantic signature not check-keyed: ${nan.signature}`);
    assert.equal(nan.status, "text-verified", `semantic NaN finding not text-verified: ${JSON.stringify(nan.reverify)}`);

    // ZERO findings for /about — the false-positive canary.
    for (const f of findings) {
      const urls = [f.evidence?.url, f.failure?.url, f.failure?.detail?.requestUrl].filter(Boolean);
      for (const u of urls) {
        assert.notEqual(pathnameOf(u), "/about", `finding ${f.id} (${f.source}) references the clean /about page`);
      }
    }

    // Every confirmed (or text-verified) finding's repro script exits 0 while
    // Bugbox is still up.
    for (const f of [...confirmed, nan]) {
      const rel = f.reverify?.reproScript;
      assert.ok(rel, `confirmed finding ${f.id} has no reproScript`);
      const scriptPath = path.isAbsolute(rel) ? rel : path.join(runDir, rel);
      await fs.access(scriptPath);
      const repro = await run(process.execPath, [scriptPath], { cwd: runDir });
      assert.equal(repro.code, 0, `repro ${f.id} exited ${repro.code}\nstdout:\n${repro.stdout}\nstderr:\n${repro.stderr}`);
    }

    // report.md exists and contains no banned marketing strings.
    const md = await fs.readFile(path.join(runDir, "report.md"), "utf8");
    const lower = md.toLowerCase();
    for (const banned of BANNED) {
      assert.ok(!lower.includes(banned), `report.md contains banned marketing string "${banned}"`);
    }
  } finally {
    await bugbox.close();
    await fs.rm(workDir, { recursive: true, force: true });
  }
});

// Hermetic side-check that already passes: the shipped docs honor the
// softened positioning too.
test("docs: README.md and TERMS.md contain no banned marketing strings", async () => {
  for (const file of ["README.md", "TERMS.md"]) {
    const text = (await fs.readFile(path.join(ROOT, file), "utf8")).toLowerCase();
    for (const banned of BANNED) {
      assert.ok(!text.includes(banned), `${file} contains banned marketing string "${banned}"`);
    }
  }
});
