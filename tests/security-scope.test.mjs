// tests/security-scope.test.mjs — lib/security/scope.mjs: egress containment
// + audit receipt. Hermetic: pure functions + tmp-dir file writes, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createScopeGate } from "../lib/security/scope.mjs";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ns-scope-"));
}

const CONFIG = { target: { url: "http://127.0.0.1:4185" }, security: { scope: { origins: [] } } };

test("assertInScope: allows the target origin by default", () => {
  const gate = createScopeGate({ config: CONFIG, log: () => {} });
  assert.equal(gate.assertInScope("http://127.0.0.1:4185/"), true);
  assert.equal(gate.assertInScope("http://127.0.0.1:4185/api/x"), true);
});

test("assertInScope: refuses any other origin, never fetched", () => {
  const gate = createScopeGate({ config: CONFIG, log: () => {} });
  assert.equal(gate.assertInScope("http://evil.example/"), false);
  assert.equal(gate.assertInScope("http://127.0.0.1:9999/"), false); // same host, different port -> different origin
});

test("assertInScope: extends via config.security.scope.origins", () => {
  const gate = createScopeGate({
    config: { target: { url: "http://127.0.0.1:4185" }, security: { scope: { origins: ["https://cdn.example"] } } },
    log: () => {},
  });
  assert.equal(gate.assertInScope("https://cdn.example/lib.js"), true);
  assert.equal(gate.assertInScope("https://other.example/lib.js"), false);
});

test("assertInScope: unparseable URL is never in scope", () => {
  const gate = createScopeGate({ config: CONFIG, log: () => {} });
  assert.equal(gate.assertInScope("not a url"), false);
});

test("assertInScope: logs a warn on refusal", () => {
  const logs = [];
  const gate = createScopeGate({ config: CONFIG, log: (level, msg) => logs.push({ level, msg }) });
  gate.assertInScope("http://evil.example/");
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, "warn");
  assert.match(logs[0].msg, /off-scope/);
});

test("receipt(): records authorized origins and every probe with timestamps", () => {
  const gate = createScopeGate({ config: CONFIG, log: () => {} });
  gate.assertInScope("http://127.0.0.1:4185/");
  gate.assertInScope("http://evil.example/");
  const receipt = gate.receipt();
  assert.deepEqual(receipt.authorizedOrigins, ["http://127.0.0.1:4185"]);
  assert.equal(receipt.probed.length, 2);
  assert.equal(receipt.probed[0].inScope, true);
  assert.equal(receipt.probed[1].inScope, false);
  assert.ok(Number.isFinite(receipt.probed[0].ts));
  assert.ok(typeof receipt.generatedAt === "string");
});

test("writeReceipt: persists scope-receipt.json into the run dir", () => {
  const gate = createScopeGate({ config: CONFIG, log: () => {} });
  gate.assertInScope("http://127.0.0.1:4185/");
  const runDir = tmpDir();
  const rel = gate.writeReceipt(runDir);
  assert.equal(rel, "scope-receipt.json");
  const written = JSON.parse(fs.readFileSync(path.join(runDir, rel), "utf8"));
  assert.equal(written.probed.length, 1);
  assert.deepEqual(written.authorizedOrigins, ["http://127.0.0.1:4185"]);
});
