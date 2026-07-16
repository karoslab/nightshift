// lib/evidence.mjs — local-only evidence snapshot for confirmed findings.
// captureEvidenceSnapshot writes <evidenceDir>/snapshot.tar.gz (repo-state.json
// + diff.patch — HEAD sha, branch, and the uncommitted worktree diff; NOT a
// full tree copy) and <evidenceDir>/manifest.json (sha256 of the archive +
// capture timestamp). Reads git state via execFile; never writes to the
// target repo, never touches the network. execFileImpl is injectable so
// callers/tests don't depend on a real git binary.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

// Tracked paths under these directories are dropped from the diff even if
// committed (defence in depth — they are normally gitignored already).
const EXCLUDE_DIRS = ["node_modules", ".next", "dist", ".git"];

function defaultExecFile(cmd, args, opts) {
  return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
}

function git(execFileImpl, repoDir, args) {
  return execFileImpl("git", args, { cwd: repoDir });
}

function excludePathspecs() {
  return EXCLUDE_DIRS.map((dir) => `:(exclude)${dir}`);
}

// Deterministic ustar tar builder for a small fixed set of in-memory files —
// no full working-tree copy, so only regular-file entries are needed.
function ustarHeader(name, size) {
  const buf = Buffer.alloc(512);
  buf.write(name.slice(0, 100), 0, "utf8");
  buf.write("0000644\0", 100, "ascii");
  buf.write("0000000\0", 108, "ascii");
  buf.write("0000000\0", 116, "ascii");
  buf.write(size.toString(8).padStart(11, "0") + "\0", 124, "ascii");
  buf.write("00000000000\0", 136, "ascii"); // mtime pinned to 0 for determinism
  buf.write("        ", 148, "ascii"); // checksum placeholder while computing
  buf.write("0", 156, "ascii"); // typeflag: regular file
  buf.write("ustar\0", 257, "ascii");
  buf.write("00", 263, "ascii");
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[i];
  buf.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return buf;
}

function tarEntry(name, content) {
  const data = Buffer.from(content, "utf8");
  const header = ustarHeader(name, data.length);
  const pad = (512 - (data.length % 512)) % 512;
  return Buffer.concat([header, data, Buffer.alloc(pad)]);
}

function buildTar(files) {
  const parts = files.map(([name, content]) => tarEntry(name, content));
  parts.push(Buffer.alloc(1024)); // two zero-filled end-of-archive records
  return Buffer.concat(parts);
}

export function captureEvidenceSnapshot({
  repoDir = process.cwd(),
  evidenceDir,
  execFileImpl = defaultExecFile,
} = {}) {
  if (!evidenceDir) throw new Error("captureEvidenceSnapshot: evidenceDir is required");

  let headSha = null;
  let branch = null;
  let diff = "";
  try {
    headSha = git(execFileImpl, repoDir, ["rev-parse", "HEAD"]).trim();
  } catch {
    headSha = null;
  }
  try {
    branch = git(execFileImpl, repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  } catch {
    branch = null;
  }
  try {
    diff = git(execFileImpl, repoDir, ["diff", "HEAD", "--", ".", ...excludePathspecs()]);
  } catch {
    diff = "";
  }

  const repoState = { headSha, branch, capturedFrom: path.resolve(repoDir) };
  const tar = buildTar([
    ["repo-state.json", JSON.stringify(repoState, null, 2) + "\n"],
    ["diff.patch", diff],
  ]);
  const gz = zlib.gzipSync(tar, { level: 9 });

  fs.mkdirSync(evidenceDir, { recursive: true });
  const archivePath = path.join(evidenceDir, "snapshot.tar.gz");
  fs.writeFileSync(archivePath, gz);

  const sha256 = crypto.createHash("sha256").update(gz).digest("hex");
  const manifest = {
    archive: "snapshot.tar.gz",
    sha256,
    capturedAt: new Date().toISOString(),
    headSha,
    branch,
  };
  const manifestPath = path.join(evidenceDir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  return { archivePath, manifestPath, manifest };
}
