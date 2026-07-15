// tests/sweep-e2e.test.mjs — browser-driven sweep-mode integration.
// Boots the bundled Bugbox demo and drives `nightshift run --sweep` end to end
// (no LLM), asserting it finds the seeded oracle bugs with >90% element
// coverage and stays quiet on /about. Two focused runSweep tests cover the
// three-pass form input path and checkpoint resume against local servers.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runSweep } from "../lib/sweep.mjs";
import { saveCheckpoint } from "../lib/sweep-coverage.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = path.join(ROOT, "bin", "nightshift.mjs");
const quietLog = () => {};

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

function baseConfig(url, reportDir, extra = {}) {
  return {
    target: {
      name: "T",
      url,
      routes: ["/"],
      maxRoutes: 12,
      selectorDenylist: [],
      denyActionKinds: [],
      sweep: true,
      ...extra,
    },
    budget: { maxLlmCalls: 40, maxMinutes: 45, maxSessionsPerNight: 4, stopAtHour: 6 },
    oracles: { expectedStatuses: [401, 403], ignoreConsole: [] },
    reverify: { replays: 2, requiredPasses: 2, navTimeoutMs: 15000 },
    report: { dir: reportDir },
  };
}

test("sweep --sweep against Bugbox proves the seeded bugs (no LLM) with >90% element coverage", { timeout: 300_000 }, async () => {
  const { startBugbox } = await import(new URL("../demo-app/server.mjs", import.meta.url).href);
  const bugbox = await startBugbox(0);

  const workDir = path.join(ROOT, "node_modules", ".cache", `nightshift-sweep-${crypto.randomUUID()}`);
  const reportDir = path.join(workDir, "reports");
  await fs.mkdir(reportDir, { recursive: true });

  try {
    const configPath = path.join(workDir, "config.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({ target: { name: "Bugbox", url: `http://127.0.0.1:${bugbox.port}`, routes: ["/"] }, report: { dir: reportDir } }),
    );

    const res = await run(process.execPath, [BIN, "run", "--config", configPath, "--sweep"], { cwd: ROOT });
    assert.equal(res.code, 0, `nightshift run --sweep failed (exit ${res.code})\n${res.stdout}\n${res.stderr}`);

    const runDirs = (await fs.readdir(reportDir, { withFileTypes: true })).filter((d) => d.isDirectory());
    assert.equal(runDirs.length, 1, `expected one run dir, got ${runDirs.map((d) => d.name)}`);
    const runDir = path.join(reportDir, runDirs[0].name);

    const report = JSON.parse(await fs.readFile(path.join(runDir, "report.json"), "utf8"));
    const findings = report.findings;

    // The three deterministically-detectable seeded bugs, confirmed on replay.
    // (The Total: NaN bug is semantic — it needs a brain, so a zero-LLM sweep
    // legitimately does not surface it.)
    const confirmed = findings.filter((f) => f.status === "confirmed");
    for (const source of ["oracle:page-error", "oracle:network-5xx", "oracle:dead-link"]) {
      assert.ok(
        confirmed.some((f) => f.source === source),
        `missing confirmed ${source}; confirmed: ${JSON.stringify(confirmed.map((f) => f.source))}`,
      );
    }

    // The page-error is the multi-step bug (Choose color THEN Add to cart) — a
    // deterministic in-DOM-order sweep reaches it without any LLM guidance.
    const pageError = confirmed.find((f) => f.source === "oracle:page-error");
    assert.match(pageError.failure.message, /cart\.total is not a function/);

    // Coverage block: present in report.json, >90%, and rendered in report.md.
    assert.ok(report.stats.coverage, "report.json must carry a sweep coverage block");
    assert.ok(
      report.stats.coverage.totals.coveragePct > 90,
      `expected >90% element coverage, got ${report.stats.coverage.totals.coveragePct}%`,
    );
    assert.equal(report.stats.mode, "sweep");
    const md = await fs.readFile(path.join(runDir, "report.md"), "utf8");
    assert.match(md, /## Sweep coverage/);
    assert.match(md, /\| Route \| Found \| Exercised \|/);

    // ZERO findings for the clean /about canary.
    for (const f of findings) {
      const urls = [f.evidence?.url, f.failure?.url, f.failure?.detail?.requestUrl].filter(Boolean);
      for (const u of urls) {
        assert.notEqual(pathnameOf(u), "/about", `finding ${f.id} references the clean /about page`);
      }
    }

    // A sweep finding replays exactly like an explorer finding: repro exits 0.
    for (const f of confirmed) {
      const rel = f.reverify?.reproScript;
      assert.ok(rel, `confirmed ${f.id} has no reproScript`);
      const scriptPath = path.isAbsolute(rel) ? rel : path.join(runDir, rel);
      const repro = await run(process.execPath, [scriptPath], { cwd: runDir });
      assert.equal(repro.code, 0, `repro ${f.id} exited ${repro.code}\n${repro.stdout}\n${repro.stderr}`);
    }
  } finally {
    await bugbox.close();
    await fs.rm(workDir, { recursive: true, force: true });
  }
});

test("sweep runs three input passes (empty, hostile, valid) against every form", { timeout: 120_000 }, async (t) => {
  const submissions = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/submit") {
      submissions.push(u.searchParams.get("q") ?? "");
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body>received</body></html>");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      `<html><body><h1>Form</h1>
       <form action="/submit" method="get">
         <input name="q" type="text" placeholder="query">
         <button type="submit">Search</button>
       </form></body></html>`,
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const runDir = fsSync.mkdtempSync(path.join(ROOT, "node_modules", ".cache", "ns-form-"));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    fsSync.rmSync(runDir, { recursive: true, force: true });
  });
  fsSync.mkdirSync(path.join(runDir, "shots"), { recursive: true });

  await runSweep({ config: baseConfig(origin, runDir, { maxRoutes: 1 }), runDir, log: quietLog });

  // The three form passes must each have reached the server: an empty submit,
  // a hostile submit (script-tag payload), and a plausible non-empty submit.
  assert.ok(submissions.includes(""), `expected an empty-input submit; got ${JSON.stringify(submissions)}`);
  assert.ok(submissions.some((v) => /<script/i.test(v)), `expected a hostile submit; got ${JSON.stringify(submissions)}`);
  assert.ok(
    submissions.some((v) => v.length > 0 && !v.includes("<")),
    `expected a plausible valid submit; got ${JSON.stringify(submissions)}`,
  );
});

test("sweep resumes from a checkpoint instead of re-sweeping a completed route", { timeout: 60_000 }, async (t) => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body><button>x</button></body></html>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const runDir = fsSync.mkdtempSync(path.join(ROOT, "node_modules", ".cache", "ns-resume-"));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    fsSync.rmSync(runDir, { recursive: true, force: true });
  });
  fsSync.mkdirSync(path.join(runDir, "shots"), { recursive: true });

  const route = origin + "/";
  // Pre-seed a checkpoint marking the only route already fully swept.
  saveCheckpoint(runDir, {
    version: 1,
    routesDone: [route],
    current: null,
    coverage: { routes: [{ url: route, found: 1, exercised: 1, skipped: 0, failed: 0, forms: 0 }] },
  });

  const { stats } = await runSweep({ config: baseConfig(origin, runDir, { maxRoutes: 1 }), runDir, log: quietLog });

  assert.equal(hits, 0, "a route marked done in the checkpoint must not be requested again");
  const restored = stats.coverage.routes.find((r) => r.url === route);
  assert.ok(restored, "restored route coverage must appear in the resumed stats");
  assert.equal(restored.exercised, 1);
});
