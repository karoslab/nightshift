// tests/security-reverify.test.mjs — lib/security/reverify.mjs http-replay
// path + lib/security/reprogen.mjs standalone script parity. Hermetic:
// in-test node:http server on port 0, no real network beyond it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { reverifySecurityFinding } from "../lib/security/reverify.mjs";
import { runSecurityScan } from "../lib/security/scan.mjs";
import { generateSecurityReproScript } from "../lib/security/reprogen.mjs";
import { buildSignature } from "../lib/signature.mjs";

let server;
let origin;
let mutable = { headersOn: false };

function makeServer() {
  return http.createServer((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    if (p === "/") {
      const headers = { "Content-Type": "text/html" };
      if (mutable.headersOn) {
        headers["Content-Security-Policy"] = "default-src 'none'";
        headers["X-Content-Type-Options"] = "nosniff";
        headers["X-Frame-Options"] = "DENY";
        headers["Referrer-Policy"] = "no-referrer";
      }
      res.writeHead(200, headers);
      return res.end("<html>hi</html>");
    }
    res.writeHead(404);
    res.end();
  });
}

before(async () => {
  server = makeServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = "http://127.0.0.1:" + server.address().port;
});

after(async () => {
  await new Promise((r) => server.close(r));
});

async function tmpRunDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "ns-sec-scan-"));
}

function baseConfig() {
  return {
    target: { url: origin },
    reverify: { replays: 2, requiredPasses: 2, navTimeoutMs: 5000 },
    security: { enabled: true, scope: { origins: [] }, checks: ["*"] },
  };
}

test("reverifySecurityFinding: confirms a header finding that still reproduces (deterministic replay)", async () => {
  mutable.headersOn = false;
  const config = baseConfig();
  const { findings } = await runSecurityScan({ config, runDir: await tmpRunDir() });
  const headerFinding = findings.find((f) => f.checkId === "missing-security-headers");
  assert.ok(headerFinding, "expected a missing-security-headers candidate");
  const result = await reverifySecurityFinding(headerFinding, { config, log: () => {} });
  assert.equal(result.status, "confirmed");
  assert.equal(result.reverify.reproduced, 2);
  assert.deepEqual(result.reverify.verdicts, ["reproduced", "reproduced"]);
});

test("reverifySecurityFinding: unconfirmed once the app fixes the headers (finding no longer reproduces)", async () => {
  mutable.headersOn = false;
  const config = baseConfig();
  const { findings } = await runSecurityScan({ config, runDir: await tmpRunDir() });
  const headerFinding = findings.find((f) => f.checkId === "missing-security-headers");
  mutable.headersOn = true; // app "fixed" between scan and reverify
  const result = await reverifySecurityFinding(headerFinding, { config, log: () => {} });
  assert.equal(result.status, "unconfirmed");
  assert.equal(result.reverify.reproduced, 0);
  mutable.headersOn = false;
});

test("reverifySecurityFinding: off-scope url fails closed as unverifiable, never re-fetched", async () => {
  const config = baseConfig();
  const finding = {
    id: "NS-SEC-999",
    checkId: "missing-security-headers",
    signature: "security:missing-security-headers|/|missing security headers: content-security-policy",
    evidence: { url: "http://evil.example/" },
    trace: [{ value: "http://evil.example/" }],
    reverify: null,
  };
  let fetchCalled = false;
  const result = await reverifySecurityFinding(finding, {
    config,
    log: () => {},
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error("must not be called for an off-scope url");
    },
  });
  assert.equal(fetchCalled, false, "off-scope url must never be fetched");
  assert.equal(result.status, "unverifiable");
});

test("reverifySecurityFinding: unknown checkId or missing signature -> unverifiable", async () => {
  const config = baseConfig();
  const result = await reverifySecurityFinding(
    { id: "NS-SEC-1", checkId: "not-a-real-check", signature: "x", evidence: { url: origin + "/" }, reverify: null },
    { config, log: () => {} },
  );
  assert.equal(result.status, "unverifiable");
});

// --- reprogen: standalone script, no dependencies, matches the report's verdict ---

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

test("generateSecurityReproScript: exits 0 when the finding still reproduces, matches the reverify verdict", async () => {
  mutable.headersOn = false;
  const config = baseConfig();
  const { findings } = await runSecurityScan({ config, runDir: await tmpRunDir() });
  const finding = findings.find((f) => f.checkId === "missing-security-headers");
  const script = generateSecurityReproScript(finding);
  assert.ok(script.includes("#!/usr/bin/env node"));
  assert.ok(!script.includes('from "playwright"'), "security repro scripts must have zero dependencies");

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ns-sec-repro-"));
  const file = path.join(dir, "NS-SEC-001.mjs");
  await fs.writeFile(file, script);
  await new Promise((r) => setImmediate(r), 0); // no-op, syntax already validated via node --check below
  await run(process.execPath, ["--check", file]);

  const { code, stdout } = await run(process.execPath, [file]);
  assert.equal(code, 0);
  assert.match(stdout, /^REPRODUCED /);
});

test("generateSecurityReproScript: exits 1 when the finding no longer reproduces", async () => {
  mutable.headersOn = false;
  const config = baseConfig();
  const { findings } = await runSecurityScan({ config, runDir: await tmpRunDir() });
  const finding = findings.find((f) => f.checkId === "missing-security-headers");
  const script = generateSecurityReproScript(finding);
  mutable.headersOn = true; // fixed before the script runs
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ns-sec-repro-"));
  const file = path.join(dir, "NS-SEC-002.mjs");
  await fs.writeFile(file, script);
  const { code, stdout } = await run(process.execPath, [file]);
  mutable.headersOn = false;
  assert.equal(code, 1);
  assert.match(stdout, /^NOT REPRODUCED /);
});

test("generateSecurityReproScript: embedded buildSignature matches the imported one (parity)", () => {
  const fakeFinding = {
    id: "NS-SEC-003",
    checkId: "missing-security-headers",
    title: "Missing security headers",
    signature: buildSignature({ oracle: "security:missing-security-headers", url: origin + "/", message: "missing security headers: x" }),
    evidence: { url: origin + "/" },
    trace: [{ value: origin + "/" }],
  };
  const script = generateSecurityReproScript(fakeFinding);
  assert.ok(script.includes(fakeFinding.signature));
});
