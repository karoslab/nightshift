// Tests for lib/evidence.mjs (local-only evidence snapshot for confirmed
// findings). Hermetic: temp git repos only, no network.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { captureEvidenceSnapshot } from "../lib/evidence.mjs";

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nightshift-evidence-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

// A minimal real git repo fixture (local `git init` only — no network).
function makeRepo(t) {
  const dir = tmpDir(t);
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(dir, "app.js"), "console.log('v1');\n");
  git(dir, ["add", "app.js"]);
  git(dir, ["commit", "-q", "-m", "initial"]);
  return dir;
}

function readTarEntries(archivePath) {
  const gz = fs.readFileSync(archivePath);
  const tar = zlib.gunzipSync(gz);
  const entries = {};
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    if (!name) break;
    const size = parseInt(header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim(), 8);
    offset += 512;
    entries[name] = tar.subarray(offset, offset + size).toString("utf8");
    offset += Math.ceil(size / 512) * 512;
  }
  return entries;
}

test("captureEvidenceSnapshot writes snapshot.tar.gz + manifest.json with matching sha256", async (t) => {
  const repoDir = makeRepo(t);
  const evidenceDir = path.join(tmpDir(t), "evidence", "NS-001");

  const { archivePath, manifest } = await captureEvidenceSnapshot({ repoDir, evidenceDir });

  assert.equal(archivePath, path.join(evidenceDir, "snapshot.tar.gz"));
  assert.ok(fs.existsSync(archivePath));
  const manifestPath = path.join(evidenceDir, "manifest.json");
  assert.ok(fs.existsSync(manifestPath));

  const onDisk = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.deepEqual(onDisk, manifest);

  const actualSha = crypto.createHash("sha256").update(fs.readFileSync(archivePath)).digest("hex");
  assert.equal(manifest.sha256, actualSha);
  assert.match(manifest.headSha, /^[0-9a-f]{40}$/);
  assert.ok(manifest.capturedAt);
});

test("captureEvidenceSnapshot's archive records HEAD sha, branch, and the uncommitted diff (not a full tree copy)", async (t) => {
  const repoDir = makeRepo(t);
  fs.writeFileSync(path.join(repoDir, "app.js"), "console.log('v2 — buggy');\n");
  const evidenceDir = path.join(tmpDir(t), "evidence", "NS-002");

  const { archivePath, manifest } = await captureEvidenceSnapshot({ repoDir, evidenceDir });

  const entries = readTarEntries(archivePath);
  assert.deepEqual(Object.keys(entries).sort(), ["diff.patch", "repo-state.json"]);

  const repoState = JSON.parse(entries["repo-state.json"]);
  assert.equal(repoState.headSha, manifest.headSha);
  assert.equal(repoState.branch, manifest.branch);

  assert.match(entries["diff.patch"], /app\.js/);
  assert.match(entries["diff.patch"], /v2 — buggy/);
  assert.doesNotMatch(entries["diff.patch"], /^v1$/m);
});

test("captureEvidenceSnapshot excludes node_modules/.next/dist from the diff", async (t) => {
  const repoDir = makeRepo(t);
  fs.mkdirSync(path.join(repoDir, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "node_modules", "pkg", "index.js"), "tracked-noise\n");
  git(repoDir, ["add", "-f", "node_modules/pkg/index.js"]);
  git(repoDir, ["commit", "-q", "-m", "add vendored file (test-only)"]);
  fs.writeFileSync(path.join(repoDir, "node_modules", "pkg", "index.js"), "tracked-noise-changed\n");

  const evidenceDir = path.join(tmpDir(t), "evidence", "NS-003");
  const { archivePath } = await captureEvidenceSnapshot({ repoDir, evidenceDir });
  const entries = readTarEntries(archivePath);

  assert.doesNotMatch(entries["diff.patch"], /node_modules/);
});

test("captureEvidenceSnapshot is deterministic for the same repo state", async (t) => {
  const repoDir = makeRepo(t);
  const evidenceDir1 = path.join(tmpDir(t), "e1");
  const evidenceDir2 = path.join(tmpDir(t), "e2");

  const r1 = await captureEvidenceSnapshot({ repoDir, evidenceDir: evidenceDir1 });
  const r2 = await captureEvidenceSnapshot({ repoDir, evidenceDir: evidenceDir2 });

  assert.deepEqual(
    fs.readFileSync(r1.archivePath),
    fs.readFileSync(r2.archivePath),
  );
});

test("captureEvidenceSnapshot requires evidenceDir", () => {
  assert.throws(() => captureEvidenceSnapshot({ repoDir: process.cwd() }));
});
