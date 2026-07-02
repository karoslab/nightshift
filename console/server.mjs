// console/server.mjs — localhost report console. Zero deps.
// Routes: / (landing), /runs/<id>, /api/health, 404 else. EVERY response
// carries the four pinned security headers. Binds 127.0.0.1 EXPLICITLY —
// a bare listen(port) would bind 0.0.0.0 and expose buyer-app bug evidence
// (screenshots, console tails) to the whole LAN.

import http from "node:http";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { listRuns, readRun } from "../lib/runstore.mjs";
import { renderLanding, renderRunPage, renderNotFound } from "./page.mjs";

export const DEFAULT_PORT = 4184;

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:",
};

function handleRequest(dataDir, req, res) {
  const send = (status, contentType, body) => {
    res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": contentType });
    res.end(body);
  };
  try {
    const { pathname } = new URL(req.url, "http://127.0.0.1");
    if (pathname === "/") {
      return send(200, "text/html; charset=utf-8", renderLanding({ runs: listRuns(dataDir) }));
    }
    if (pathname === "/api/health") {
      // Side-effect-free: only counts run directories on disk.
      const payload = { ok: true, service: "nightshift-console", runs: listRuns(dataDir).length };
      return send(200, "application/json", JSON.stringify(payload));
    }
    const match = pathname.match(/^\/runs\/([^/]+)$/);
    if (match) {
      const run = readRun(dataDir, match[1]);
      if (run) return send(200, "text/html; charset=utf-8", renderRunPage(run));
    }
    return send(404, "text/html; charset=utf-8", renderNotFound(pathname));
  } catch (err) {
    return send(500, "text/plain; charset=utf-8", `console error: ${err.message}`);
  }
}

export function startConsole({ port = DEFAULT_PORT, dataDir } = {}) {
  const resolvedDataDir = path.resolve(dataDir ?? ".nightshift");
  const server = http.createServer((req, res) => handleRequest(resolvedDataDir, req, res));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve({
        server,
        port: server.address().port,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function argValue(argv, name) {
  const i = argv.indexOf(name);
  if (i !== -1 && argv[i + 1] !== undefined) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}

export function resolvePort(argv = [], env = {}) {
  const raw = argValue(argv, "--port") ?? env.NIGHTSHIFT_CONSOLE_PORT;
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid console port: ${raw}`);
  }
  return port;
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const argv = process.argv.slice(2);
  const port = resolvePort(argv, process.env);
  const dataDir = argValue(argv, "--data-dir") ?? path.resolve(".nightshift");
  const { port: boundPort } = await startConsole({ port, dataDir });
  console.log(`NightShift console listening on http://127.0.0.1:${boundPort} (data: ${path.resolve(dataDir)})`);
}
