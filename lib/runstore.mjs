// lib/runstore.mjs — run directory management (.nightshift/<runId>/).
// Owns: createRun, finalizeRun (latest.json pointer), listRuns/readRun (console).

import fs from "node:fs";
import path from "node:path";

const RUN_ID_RE = /^\d{8}-\d{6}$/;

function pad(n) {
  return String(n).padStart(2, "0");
}

export function formatRunId(date = new Date()) {
  return (
    String(date.getFullYear()) +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    "-" +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  );
}

export function isRunId(id) {
  return RUN_ID_RE.test(String(id));
}

export function createRun(config) {
  const baseDir = path.resolve(config?.report?.dir ?? ".nightshift");
  fs.mkdirSync(baseDir, { recursive: true });
  // Same-second collision bumps the timestamp forward so the pinned
  // YYYYMMDD-HHmmss id format is preserved.
  let at = Date.now();
  let runId = formatRunId(new Date(at));
  while (fs.existsSync(path.join(baseDir, runId))) {
    at += 1000;
    runId = formatRunId(new Date(at));
  }
  const runDir = path.join(baseDir, runId);
  fs.mkdirSync(path.join(runDir, "shots"), { recursive: true });
  fs.mkdirSync(path.join(runDir, "repro"), { recursive: true });
  return { runId, runDir };
}

// Called at finalize (writeReport does this): updates the latest.json pointer
// in the data dir so `nightshift console` and `verify` can find the last run.
export function finalizeRun(runDir) {
  const abs = path.resolve(runDir);
  const pointer = {
    runId: path.basename(abs),
    runDir: abs,
    finalizedAt: new Date().toISOString(),
  };
  const file = path.join(path.dirname(abs), "latest.json");
  fs.writeFileSync(file, JSON.stringify(pointer, null, 2) + "\n");
  return file;
}

function readReportJson(runDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(runDir, "report.json"), "utf8"));
  } catch {
    return null; // no report yet, or unreadable — caller renders a stub
  }
}

// Newest first. `report` is the parsed report.json or null.
export function listRuns(dataDir) {
  const base = path.resolve(dataDir ?? ".nightshift");
  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && RUN_ID_RE.test(e.name))
    .map((e) => {
      const runDir = path.join(base, e.name);
      return { runId: e.name, runDir, report: readReportJson(runDir) };
    })
    .sort((a, b) => (a.runId < b.runId ? 1 : -1));
}

export function readRun(dataDir, runId) {
  if (!isRunId(runId)) return null; // also rejects path-traversal ids
  const runDir = path.join(path.resolve(dataDir ?? ".nightshift"), runId);
  let stat;
  try {
    stat = fs.statSync(runDir);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return null;
  return { runId, runDir, report: readReportJson(runDir) };
}
