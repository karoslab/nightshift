// Tests for console/server.mjs + console/page.mjs (agent D). Hermetic:
// ephemeral port (0), temp data dir, loopback only.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startConsole, resolvePort, DEFAULT_PORT } from "../console/server.mjs";
import { writeReport, POSITIONING_LINE } from "../lib/report.mjs";
import { createRun } from "../lib/runstore.mjs";

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:",
};

const BANNED = [/free forever/i, /zero marginal cost/i, /unlimited/i];

let dataDir;
let runId;
let handle;
let base;

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nightshift-console-test-"));
  const run = createRun({ report: { dir: dataDir } });
  runId = run.runId;
  writeReport(run.runDir, {
    config: { target: { name: "Bugbox", url: "http://127.0.0.1:4185" } },
    findings: [
      {
        id: "NS-001",
        source: "oracle:page-error",
        title: "Add to cart crashes with TypeError",
        severity: "critical",
        signature: "page-error|/|typeerror: cart.total is not a function",
        failure: { oracle: "page-error", message: "TypeError: cart.total is not a function", url: "http://127.0.0.1:4185/", detail: {}, atStep: 1, ts: 1 },
        semantic: null,
        trace: [
          { i: 0, kind: "goto", locator: null, value: "http://127.0.0.1:4185/", url: "about:blank", postUrl: "http://127.0.0.1:4185/", ok: true, error: null, tMs: 100, settle: { condition: "networkidle", waitedMs: 200 } },
          { i: 1, kind: "click", locator: { strategy: "role", role: "button", name: "Add to cart", nth: 0 }, value: null, url: "http://127.0.0.1:4185/", postUrl: "http://127.0.0.1:4185/", ok: true, error: null, tMs: 30, settle: { condition: "timeout", waitedMs: 1500 } },
        ],
        evidence: { screenshot: "shots/NS-001.png", consoleTail: ["boom"], url: "http://127.0.0.1:4185/" },
        status: "confirmed",
        reverify: { replays: 2, reproduced: 2, verdicts: ["reproduced", "reproduced"], minimized: false, reproScript: "repro/NS-001.mjs" },
      },
    ],
    stats: { routesVisited: 1, actionsExecuted: 2, llmCalls: 2, durationMs: 60000, usage: { inputTokens: 100, outputTokens: 50, costUsd: null } },
    brainMeta: { mode: "mock", model: "scripted" },
  });
  handle = await startConsole({ port: 0, dataDir });
  base = `http://127.0.0.1:${handle.port}`;
});

test.after(async () => {
  await handle?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("binds 127.0.0.1 explicitly (never 0.0.0.0)", () => {
  assert.equal(handle.server.address().address, "127.0.0.1");
  assert.ok(handle.port > 0);
});

test("/api/health returns the pinned shape", async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /application\/json/);
  const body = await res.json();
  assert.deepEqual(body, { ok: true, status: "ok", service: "nightshift-console", runs: 1 });
});

test("every response carries the four security headers (incl. 404)", async () => {
  const paths = ["/", "/api/health", `/runs/${runId}`, "/definitely-not-a-route", "/runs/../../etc"];
  for (const p of paths) {
    const res = await fetch(base + p);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      assert.equal(res.headers.get(name), value, `${name} wrong on ${p} (status ${res.status})`);
    }
  }
});

test("landing page: softened pitch, compliance bullets, run list; no banned strings", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  // Positioning line (HTML-escaped apostrophes — match an unescaped fragment).
  assert.ok(html.includes("Runs on the Claude subscription you already have"));
  assert.ok(html.includes("usage limits and policies, which can change"));
  assert.ok(/telemetry/i.test(html), "compliance bullets missing");
  assert.ok(html.includes("localhost report viewer"));
  assert.ok(html.includes(`/runs/${runId}`), "run list missing the run link");
  for (const banned of BANNED) assert.ok(!banned.test(html), `banned: ${banned}`);
});

test("/runs/<id> renders the report; unknown and malformed ids 404", async () => {
  const ok = await fetch(`${base}/runs/${runId}`);
  assert.equal(ok.status, 200);
  const html = await ok.text();
  assert.ok(html.includes("NS-001"));
  assert.ok(html.includes("Add to cart crashes with TypeError"));
  assert.ok(html.includes("Click the button"));
  assert.ok(html.includes("repro/NS-001.mjs"));

  assert.equal((await fetch(`${base}/runs/20990101-000000`)).status, 404);
  assert.equal((await fetch(`${base}/runs/nope`)).status, 404);
  assert.equal((await fetch(`${base}/runs/${runId}/extra`)).status, 404);
});

test("unknown routes 404 with an HTML body", async () => {
  const res = await fetch(`${base}/whatever`);
  assert.equal(res.status, 404);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.ok((await res.text()).includes("404"));
});

test("resolvePort: --port beats env beats default 4184; rejects garbage", () => {
  assert.equal(resolvePort([], {}), DEFAULT_PORT);
  assert.equal(DEFAULT_PORT, 4184);
  assert.equal(resolvePort([], { NIGHTSHIFT_CONSOLE_PORT: "5000" }), 5000);
  assert.equal(resolvePort(["--port", "0"], { NIGHTSHIFT_CONSOLE_PORT: "5000" }), 0);
  assert.equal(resolvePort(["--port=7777"], {}), 7777);
  assert.throws(() => resolvePort(["--port", "banana"], {}));
});
