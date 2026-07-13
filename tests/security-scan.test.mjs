// tests/security-scan.test.mjs — security loadout acceptance criteria
// (PLAN-security-loadout.md section 5), run end-to-end against Bugbox:
//  - security.enabled: false -> zero behavior change (no findings, no fetch).
//  - security.enabled: true -> at least one header + one cookie finding,
//    both confirmed via deterministic replay, both with runnable repro scripts.
//  - no off-scope network request appears in the run log.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { startBugbox } from "../demo-app/server.mjs";
import { runSecurityScan } from "../lib/security/scan.mjs";
import { reverifySecurityFinding } from "../lib/security/reverify.mjs";
import { generateSecurityReproScript } from "../lib/security/reprogen.mjs";

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("close", (code) => resolve({ code, stdout }));
  });
}

test("security.enabled: false -> zero findings and zero network calls (default off)", async () => {
  const bugbox = await startBugbox(0);
  try {
    let fetchCalled = false;
    const config = {
      target: { url: `http://127.0.0.1:${bugbox.port}`, routes: ["/"] },
      reverify: { replays: 2, requiredPasses: 2, navTimeoutMs: 5000 },
      security: { enabled: false, scope: { origins: [] }, checks: ["*"] },
    };
    const { findings, stats } = await runSecurityScan({
      config,
      runDir: null,
      fetchImpl: async () => {
        fetchCalled = true;
        throw new Error("must never fetch when security.enabled is false");
      },
    });
    assert.deepEqual(findings, []);
    assert.deepEqual(stats, { scanned: 0, skipped: 0 });
    assert.equal(fetchCalled, false);
  } finally {
    await bugbox.close();
  }
});

test("security.enabled: true against Bugbox -> confirmed header + cookie findings, runnable repro scripts, in-scope-only log", { timeout: 60_000 }, async () => {
  const bugbox = await startBugbox(0);
  const runLog = [];
  const log = (level, message) => runLog.push({ level, message });
  try {
    const config = {
      target: { name: "Bugbox", url: `http://127.0.0.1:${bugbox.port}`, routes: ["/", "/about"] },
      reverify: { replays: 2, requiredPasses: 2, navTimeoutMs: 5000 },
      security: { enabled: true, scope: { origins: [] }, checks: ["*"] },
    };
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "ns-sec-e2e-"));

    const { findings } = await runSecurityScan({ config, runDir: workDir, log });
    const headerCandidate = findings.find((f) => f.checkId === "missing-security-headers");
    const cookieCandidate = findings.find((f) => f.checkId === "insecure-cookie-flags");
    assert.ok(headerCandidate, "expected at least one missing-security-headers candidate on Bugbox");
    assert.ok(cookieCandidate, "expected at least one insecure-cookie-flags candidate on Bugbox");

    const headerConfirmed = await reverifySecurityFinding(headerCandidate, { config, log });
    const cookieConfirmed = await reverifySecurityFinding(cookieCandidate, { config, log });
    assert.equal(headerConfirmed.status, "confirmed", JSON.stringify(headerConfirmed));
    assert.equal(cookieConfirmed.status, "confirmed", JSON.stringify(cookieConfirmed));

    // Runnable repro scripts for both.
    for (const finding of [headerConfirmed, cookieConfirmed]) {
      const script = generateSecurityReproScript(finding);
      const file = path.join(workDir, `${finding.id}.mjs`);
      await fs.writeFile(file, script);
      const { code, stdout } = await run(process.execPath, [file]);
      assert.equal(code, 0, `repro script for ${finding.id} must exit 0: ${stdout}`);
      assert.match(stdout, /^REPRODUCED /);
    }

    // No off-scope network request appears anywhere in the run log.
    const offScope = runLog.filter((l) => /off-scope/i.test(l.message));
    assert.equal(offScope.length, 0, JSON.stringify(offScope));

    // scope-receipt.json was written and only lists the authorized origin.
    const receipt = JSON.parse(await fs.readFile(path.join(workDir, "scope-receipt.json"), "utf8"));
    assert.deepEqual(receipt.authorizedOrigins, [`http://127.0.0.1:${bugbox.port}`]);
    assert.ok(receipt.probed.every((p) => p.inScope));
  } finally {
    await bugbox.close();
  }
});
