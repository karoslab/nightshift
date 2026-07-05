// tests/reprogen.test.mjs — generated repro scripts are valid standalone JS,
// import only playwright, and embed the REAL signature functions (parity
// asserted byte-identical). Hermetic: in-test http server on port 0.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generateReproScript } from "../lib/reprogen.mjs";
import { buildSignature, signaturesMatch } from "../lib/signature.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// Sentinels pinned in lib/reprogen.mjs around the embedded signature functions.
const EMBED_BEGIN = "// --- begin embedded lib/signature.mjs (do not edit; parity-tested) ---";
const EMBED_END = "// --- end embedded lib/signature.mjs ---";

const CONFIG = {
  target: { name: "Test", url: "http://127.0.0.1:9999", routes: ["/"] },
  oracles: { expectedStatuses: [401, 403], ignoreConsole: ["ResizeObserver loop"] },
  reverify: { replays: 2, requiredPasses: 2, navTimeoutMs: 5000 },
};

const gotoStep = (i, url) => ({
  i, kind: "goto", locator: null, value: url, url: "", postUrl: url,
  ok: true, error: null, tMs: 10, settle: { condition: "networkidle", waitedMs: 0 },
});
const clickStep = (i, name, url) => ({
  i, kind: "click", locator: { strategy: "role", role: "button", name, nth: 0 }, value: null,
  url, postUrl: url, ok: true, error: null, tMs: 10, settle: { condition: "networkidle", waitedMs: 0 },
});

const oracleFinding = (origin = "http://127.0.0.1:9999") => {
  const event = {
    oracle: "network-5xx",
    message: "HTTP 500 GET /api/flaky",
    url: origin + "/bug",
    detail: { status: 500, method: "GET", requestUrl: "/api/flaky" },
    atStep: 1,
    ts: 1700000000000,
  };
  return {
    id: "NS-001",
    source: "oracle:network-5xx",
    title: 'Load deals 500s: "quotes" & <angles> survive',
    severity: "critical",
    signature: buildSignature(event),
    failure: event,
    semantic: null,
    check: null,
    trace: [gotoStep(0, origin + "/bug"), clickStep(1, "Load deals", origin + "/bug")],
    evidence: { screenshot: null, consoleTail: [], url: origin + "/bug" },
    status: "confirmed",
    reverify: { replays: 2, reproduced: 2, verdicts: ["reproduced", "reproduced"], minimized: false, reproScript: null },
  };
};

const semanticFinding = (origin = "http://127.0.0.1:9999") => {
  const check = { kind: "text-present", selector: "#total", text: "Total: NaN" };
  return {
    ...oracleFinding(origin),
    id: "NS-002",
    source: "brain:semantic",
    title: "coupon renders Total: NaN",
    signature: buildSignature({ ...check, url: origin + "/nan" }),
    failure: null,
    semantic: { expected: "numeric total", actual: "Total: NaN" },
    check,
    trace: [gotoStep(0, origin + "/nan")],
  };
};

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

test("generated scripts pass node --check (oracle and semantic variants)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ns-reprogen-"));
  try {
    for (const finding of [oracleFinding(), semanticFinding()]) {
      const script = generateReproScript(finding, CONFIG);
      assert.equal(typeof script, "string");
      const file = path.join(dir, finding.id + ".mjs");
      await fs.writeFile(file, script);
      const res = await run(process.execPath, ["--check", file]);
      assert.equal(res.code, 0, `node --check failed for ${finding.id}:\n${res.stderr}`);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("generated script imports ONLY playwright", () => {
  const script = generateReproScript(oracleFinding(), CONFIG);
  const imports = script.match(/^\s*import\b.*$/gm) ?? [];
  assert.equal(imports.length, 1, "exactly one import statement:\n" + imports.join("\n"));
  assert.match(imports[0], /from "playwright"/);
  assert.ok(!/\brequire\s*\(/.test(script), "no require() calls");
  assert.ok(!/from "node:/.test(script), "no node builtin imports");
});

test("parity: embedded normalizer output is byte-identical to lib/signature.mjs", () => {
  const script = generateReproScript(oracleFinding(), CONFIG);
  const start = script.indexOf(EMBED_BEGIN);
  const end = script.indexOf(EMBED_END);
  assert.ok(start !== -1 && end > start, "embed sentinels present in generated script");
  const embeddedSrc = script.slice(start + EMBED_BEGIN.length, end);
  const embedded = new Function(embeddedSrc + "; return { buildSignature, signaturesMatch };")();

  const table = [
    { oracle: "console-error", message: "TypeError: Total is not a function", url: "http://x/shop", detail: {} },
    { oracle: "console-error", message: "user 6f9619ff-8b86-d011-b42d-00cf4fc964ff at 2026-07-02T07:14:23.123Z", url: "http://x/shop?tab=2", detail: {} },
    { oracle: "page-error", message: "boom after 1500 ms hex deadbeef01cafe", url: "http://x/orders/98765", detail: {} },
    { oracle: "network-5xx", message: "HTTP 500 GET /api/flaky", url: "http://x/", detail: { status: 500, method: "GET", requestUrl: "/api/flaky?cache=1700000000000" } },
    { oracle: "network-4xx", message: "HTTP 422 POST /api/items/98765", url: "http://x/", detail: { status: 422, method: "POST", requestUrl: "/api/items/98765" } },
    { oracle: "request-failed", message: "net::ERR_CONNECTION_REFUSED", url: "http://x/", detail: { status: null, method: "GET", requestUrl: "/api/x" } },
    { oracle: "dead-link", message: "navigation landed on HTTP 404", url: "http://x/warranty", detail: { status: 404, method: "GET", requestUrl: "/warranty" } },
    { oracle: "nav-failure", message: "net::ERR_CONNECTION_REFUSED", url: "http://x/page", detail: { status: null, method: "GET", requestUrl: "/page" } },
    { kind: "text-present", selector: "#total", text: "Total: NaN", url: "http://x/" },
    { kind: "text-absent", selector: null, text: "Order confirmed", url: "http://x/cart" },
    { oracle: "console-error", message: "x".repeat(500), url: "http://x/long", detail: {} },
  ];
  for (const input of table) {
    const expected = buildSignature(input);
    const actual = embedded.buildSignature(input);
    assert.equal(actual, expected, "embedded buildSignature diverged for " + JSON.stringify(input).slice(0, 80));
    assert.equal(
      embedded.signaturesMatch(actual, expected),
      signaturesMatch(actual, expected),
      "embedded signaturesMatch diverged",
    );
  }
  assert.equal(embedded.signaturesMatch("a", "b"), false);
});

test("generateReproScript rejects findings it cannot assert", () => {
  const noTrace = { ...oracleFinding(), trace: [] };
  assert.throws(() => generateReproScript(noTrace, CONFIG), /trace is empty/);
  const noCheck = { ...semanticFinding(), check: null };
  assert.throws(() => generateReproScript(noCheck, CONFIG), /no deterministic check/);
  const noSignature = { ...oracleFinding(), signature: "" };
  assert.throws(() => generateReproScript(noSignature, CONFIG), /no signature/);
});

test("executed repro script: exit 0 when the bug fires, exit 1 when it does not", { timeout: 120_000 }, async () => {
  const server = http.createServer((req, res) => {
    const pathname = req.url.split("?")[0];
    if (pathname === "/api/flaky") {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("boom");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<html><body><button onclick="fetch('/api/flaky')">Load deals</button></body></html>`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = "http://127.0.0.1:" + server.address().port;
  // under node_modules so the script's bare `import "playwright"` resolves
  const dir = path.join(ROOT, "node_modules", ".cache", `ns-reprogen-${crypto.randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  try {
    const config = { ...CONFIG, target: { ...CONFIG.target, url: origin } };

    const live = oracleFinding(origin);
    const livePath = path.join(dir, "live.mjs");
    await fs.writeFile(livePath, generateReproScript(live, config));
    const reproduced = await run(process.execPath, [livePath]);
    assert.equal(reproduced.code, 0, `expected exit 0:\n${reproduced.stdout}\n${reproduced.stderr}`);
    assert.match(reproduced.stdout, /^REPRODUCED NS-001 /m);

    // same trace, but a signature the page never produces
    const stale = oracleFinding(origin);
    stale.signature = buildSignature({
      oracle: "network-5xx",
      message: "HTTP 500 GET /api/other",
      url: origin + "/bug",
      detail: { status: 500, method: "GET", requestUrl: "/api/other" },
    });
    const stalePath = path.join(dir, "stale.mjs");
    await fs.writeFile(stalePath, generateReproScript(stale, config));
    const notReproduced = await run(process.execPath, [stalePath]);
    assert.equal(notReproduced.code, 1, `expected exit 1:\n${notReproduced.stdout}\n${notReproduced.stderr}`);
    assert.match(notReproduced.stdout, /^NOT REPRODUCED NS-001 /m);
  } finally {
    await new Promise((r) => server.close(r));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// --- fixes: findings review 2026-07-02 ---

test("generated script mirrors the oracle/check fixes from lib/oracles.mjs and lib/reverify.mjs", () => {
  const script = generateReproScript(oracleFinding(), CONFIG);
  // F11: Chromium network-log console entries are filtered in the embedded
  // console listener too — otherwise a missing favicon would make the repro
  // script exit 0 on a healthy app.
  assert.match(script, /NETWORK_LOG_RE\s*=\s*\/\^Failed to load resource:\//);
  assert.match(script, /if \(NETWORK_LOG_RE\.test\(text\)\) return;/);
  // F15: console-error events must carry msg.location() so the embedded
  // buildSignature builds the same location-keyed subject as the report.
  assert.match(script, /msg\.location\(\)/);
  assert.match(script, /loc\.url \+ ":" \+ loc\.lineNumber/);
  // F12: expected statuses suppress every response oracle family (dead-link
  // and network-5xx included), before any branch runs.
  const respStart = script.indexOf('context.on("response"');
  assert.ok(respStart !== -1, "generated script must attach a response listener");
  const responseBlock = script.slice(respStart, script.indexOf('"dead-link"', respStart));
  assert.match(responseBlock, /if \(expected\.has\(status\)\) return;/);
  // F14: an unresolved selector must not vacuously reproduce a text-absent check.
  assert.match(script, /if \(!resolved && check\.selector\) return \{ reproduced: false, excerpt: null \};/);
});

// --- fixes: false-positive review 2026-07-04 (auth-400 + static-copy control) ---

test("generated script embeds the AUTH_PATH_RE 400 gate (lib/oracles.mjs parity)", () => {
  const script = generateReproScript(oracleFinding(), CONFIG);
  // the regex must survive the template literal byte-identical to lib/oracles.mjs
  assert.match(script, /const AUTH_PATH_RE = \/\(\^\|\\\/\)\(auth\|login\|log-in\|signin\|sign-in\|signup\|sign-up\|register\|password\|forgot\|reset\|verify\|otp\|credentials\|session\)s\?\(\\\/\|\$\)\/i;/);
  assert.match(script, /if \(status === 400 && AUTH_PATH_RE\.test\(pathnameOf\(response\.url\(\)\)\)\) return;/);
});

test("generated script embeds the nav-only control for text-present findings (lib/reverify.mjs parity)", () => {
  const script = generateReproScript(semanticFinding(), CONFIG);
  assert.match(script, /const hasInteraction = TRACE\.some\(\(s\) => s\.kind !== "goto" && s\.kind !== "back"\);/);
  assert.match(script, /if \(reproduced && CHECK && CHECK\.kind === "text-present" && hasInteraction\)/);
  assert.match(script, /control-matched: check text present without interactions \(static page copy\)/);
});

test("executed repro script: static-copy text-present exits 1, interaction-caused exits 0", { timeout: 120_000 }, async () => {
  const server = http.createServer((req, res) => {
    const pathname = req.url.split("?")[0];
    if (pathname === "/signup") {
      // "Open the planner" is the page's own headline — present on plain load
      return void (res.writeHead(200, { "content-type": "text/html" }),
        res.end(`<html><body><h1>Open the planner</h1>
          <button onclick="document.title='x'">Get started</button></body></html>`));
    }
    // /reveal injects "Total: NaN" ONLY on the click
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<html><body><div id="out"></div>
      <button onclick="document.getElementById('out').textContent='Total: NaN'">Apply coupon</button></body></html>`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = "http://127.0.0.1:" + server.address().port;
  const dir = path.join(ROOT, "node_modules", ".cache", `ns-reprogen-${crypto.randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  try {
    const config = { ...CONFIG, target: { ...CONFIG.target, url: origin } };

    // static page copy + an interaction step: the nav-only control matches, so
    // the generated script must NOT reproduce -> exit 1.
    const staticCopy = {
      ...semanticFinding(origin),
      check: { kind: "text-present", selector: null, text: "Open the planner" },
      signature: buildSignature({ kind: "text-present", selector: null, text: "Open the planner", url: origin + "/signup" }),
      trace: [gotoStep(0, origin + "/signup"), clickStep(1, "Get started", origin + "/signup")],
    };
    const staticPath = path.join(dir, "static.mjs");
    await fs.writeFile(staticPath, generateReproScript(staticCopy, config));
    const staticRes = await run(process.execPath, [staticPath]);
    assert.equal(staticRes.code, 1, `static copy must exit 1:\n${staticRes.stdout}\n${staticRes.stderr}`);
    assert.match(staticRes.stdout, /^NOT REPRODUCED NS-002 /m);
    assert.match(staticRes.stderr, /control-matched/);

    // interaction-caused text: the nav-only control finds nothing -> exit 0.
    const caused = {
      ...semanticFinding(origin),
      check: { kind: "text-present", selector: "#out", text: "Total: NaN" },
      signature: buildSignature({ kind: "text-present", selector: "#out", text: "Total: NaN", url: origin + "/reveal" }),
      trace: [gotoStep(0, origin + "/reveal"), clickStep(1, "Apply coupon", origin + "/reveal")],
    };
    const causedPath = path.join(dir, "caused.mjs");
    await fs.writeFile(causedPath, generateReproScript(caused, config));
    const causedRes = await run(process.execPath, [causedPath]);
    assert.equal(causedRes.code, 0, `interaction-caused bug must exit 0:\n${causedRes.stdout}\n${causedRes.stderr}`);
    assert.match(causedRes.stdout, /^REPRODUCED NS-002 /m);
  } finally {
    await new Promise((r) => server.close(r));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
