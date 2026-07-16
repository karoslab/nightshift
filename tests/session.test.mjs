// tests/session.test.mjs — session-level regression tests for the 2026-07-02
// findings review. Hermetic: in-test node:http servers on port 0, scripted
// brain objects (no LLM), temp run dirs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSession, createIdMinter } from "../lib/session.mjs";

let serverA;
let originA;
let serverB;
let originB;
let serverBHits;

const PAGES_A = {
  "/": `<html><body><h1>Home</h1><button onclick="fetch('/api/slow500')">Boom</button></body></html>`,
  "/external": `<html><body><a href="__B__/lure">Partner site</a><button onclick="void 0">Noop</button></body></html>`,
  "/shop": `<html><body><a href="/product?id=1">Product one</a></body></html>`,
  "/bug-one": `<html><body><script>console.error("session one bug")</script>ok</body></html>`,
  "/bug-two": `<html><body><script>console.error("session two bug")</script>ok</body></html>`,
};

before(async () => {
  serverA = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/api/slow500") {
      // a failing response slower than the settle window: only the
      // end-of-route grace can catch it while the trace is still current
      setTimeout(() => {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("boom");
      }, 800);
      return;
    }
    if (u.pathname === "/product") {
      // query-string routing: /product?id=1 exists, bare /product does not
      if (u.searchParams.get("id")) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><body>product one</body></html>");
      } else {
        res.writeHead(404, { "content-type": "text/html" });
        res.end("<html><body>404</body></html>");
      }
      return;
    }
    const html = PAGES_A[u.pathname];
    if (!html) {
      res.writeHead(404, { "content-type": "text/html" });
      res.end("<html><body>404</body></html>");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(html.replace("__B__", originB));
  });
  serverB = http.createServer((req, res) => {
    serverBHits += 1;
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body><h1>Foreign</h1><a href=\"/deeper\">Deeper</a></body></html>");
  });
  await new Promise((r) => serverB.listen(0, "127.0.0.1", r));
  originB = "http://127.0.0.1:" + serverB.address().port;
  await new Promise((r) => serverA.listen(0, "127.0.0.1", r));
  originA = "http://127.0.0.1:" + serverA.address().port;
});

after(async () => {
  await new Promise((r) => serverA.close(r));
  await new Promise((r) => serverB.close(r));
});

// Scripted brain that also records every turn's user prompt.
function scriptedBrain(script) {
  const queue = [...script];
  const turns = [];
  return {
    mode: "mock",
    model: "scripted",
    turns,
    async ask({ user }) {
      turns.push(user);
      const json = queue.length > 0 ? queue.shift() : { done: true };
      return {
        ok: true,
        json,
        rawText: JSON.stringify(json),
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 },
      };
    },
    async close() {},
  };
}

// Scripted brain where some replies are `null` (brain.ask ok:false — mirrors
// a malformed-JSON reply from lib/brain/mock.mjs's extractJson).
function flakyBrain(script) {
  const queue = [...script];
  return {
    mode: "mock",
    model: "scripted",
    async ask() {
      const reply = queue.length > 0 ? queue.shift() : { action: null, findings: [], done: true };
      if (reply === null) {
        return { ok: false, json: null, rawText: "not json", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
      }
      return { ok: true, json: reply, rawText: JSON.stringify(reply), usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
    },
    async close() {},
  };
}

const quietLog = () => {};

function tmpRunDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ns-session-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeConfig(routes, { maxRoutes = 1, actionsPerPage = 2 } = {}) {
  return {
    target: { name: "T", url: originA, routes, maxRoutes, actionsPerPage },
    budget: { maxLlmCalls: 10, maxMinutes: 5, maxSessionsPerNight: 4, stopAtHour: 6 },
    oracles: { expectedStatuses: [401, 403], ignoreConsole: [] },
    reverify: { replays: 2, requiredPasses: 2, navTimeoutMs: 10000 },
    report: { dir: ".nightshift" },
  };
}

test("a slow failing response from the route's LAST action is captured with the triggering trace", { timeout: 60_000 }, async (t) => {
  // Settle resolves long before the 800ms /api/slow500 response lands; without
  // the end-of-route grace the event was attached to the NEXT route's trace
  // (reverify then replays the wrong steps) or, on the final route, dropped.
  const brain = scriptedBrain([
    { action: { kind: "click", elementId: 0, why: "press the button" }, findings: [], done: false },
  ]);
  const { findings } = await runSession({
    config: makeConfig(["/"], { actionsPerPage: 1 }),
    brain,
    runDir: tmpRunDir(t),
    log: quietLog,
  });
  const fiveHundreds = findings.filter((f) => f.source === "oracle:network-5xx");
  assert.equal(fiveHundreds.length, 1, JSON.stringify(findings.map((f) => [f.source, f.title])));
  const f = fiveHundreds[0];
  assert.equal(f.trace.length, 2, "trace must contain goto + the triggering click");
  assert.equal(f.trace[1].kind, "click", "the triggering click must be in the finding's trace");
});

test("a click that navigates off-origin recovers to the target app instead of burning the budget there", { timeout: 60_000 }, async (t) => {
  const brain = scriptedBrain([
    { action: { kind: "click", elementId: 0, why: "follow the partner link" }, findings: [], done: false },
    { action: null, findings: [], done: true },
  ]);
  await runSession({
    config: makeConfig(["/external"], { actionsPerPage: 2 }),
    brain,
    runDir: tmpRunDir(t),
    log: quietLog,
  });
  assert.equal(brain.turns.length, 2);
  assert.ok(
    brain.turns[1].includes(originA + "/external"),
    "after the off-origin click, the next turn must be back on the target app:\n" + brain.turns[1].slice(0, 300),
  );
  assert.ok(
    !brain.turns[1].includes(originB),
    "the foreign page must not be offered to the brain for further actions",
  );
});

test("a click on an external anchor is intercepted before the foreign origin is ever requested", { timeout: 60_000 }, async (t) => {
  serverBHits = 0;
  const brain = scriptedBrain([
    { action: { kind: "click", elementId: 0, why: "follow the partner link" }, findings: [], done: false },
    { action: null, findings: [], done: true },
  ]);
  await runSession({
    config: makeConfig(["/external"], { actionsPerPage: 2 }),
    brain,
    runDir: tmpRunDir(t),
    log: quietLog,
  });
  assert.equal(serverBHits, 0, "the foreign origin must never receive a request from the intercepted click");
});

test("a harvested cross-origin anchor is never enqueued as a route to visit", { timeout: 60_000 }, async (t) => {
  serverBHits = 0;
  const brain = scriptedBrain([{ action: null, findings: [], done: true }]);
  await runSession({
    config: makeConfig(["/external"], { maxRoutes: 5, actionsPerPage: 1 }),
    brain,
    runDir: tmpRunDir(t),
    log: quietLog,
  });
  assert.equal(serverBHits, 0, "a cross-origin anchor on the page must never be visited as a harvested route");
});

test("overnight sessions sharing a run dir share the id minter: no NS-nnn collisions", { timeout: 60_000 }, async (t) => {
  const runDir = tmpRunDir(t); // ONE run dir, like cmdOvernight
  const mintId = createIdMinter(); // ONE minter for the night
  const sessionOne = await runSession({
    config: makeConfig(["/bug-one"]),
    brain: scriptedBrain([{ action: null, findings: [], done: true }]),
    runDir,
    log: quietLog,
    mintId,
  });
  const sessionTwo = await runSession({
    config: makeConfig(["/bug-two"]),
    brain: scriptedBrain([{ action: null, findings: [], done: true }]),
    runDir,
    log: quietLog,
    mintId,
  });
  const ids = [...sessionOne.findings, ...sessionTwo.findings].map((f) => f.id);
  assert.ok(ids.length >= 2, "each session must find its console-error bug: " + JSON.stringify(ids));
  assert.equal(new Set(ids).size, ids.length, "finding ids must never collide across sessions: " + JSON.stringify(ids));
  for (const id of ids) {
    assert.ok(fs.existsSync(path.join(runDir, "shots", id + ".png")), "screenshot for " + id + " must not be overwritten");
  }
});

test("a harvested ?query anchor does not whitelist a brain-invented goto to the bare pathname", { timeout: 60_000 }, async (t) => {
  // /shop harvests <a href="/product?id=1"> (200 OK). The brain invents
  // goto "/product", which 404s — a URL that exists nowhere in the app.
  const brain = scriptedBrain([
    { action: { kind: "goto", url: "/product", why: "guess a route" }, findings: [], done: false },
    { action: null, findings: [], done: true },
  ]);
  const { findings } = await runSession({
    config: makeConfig(["/shop"], { actionsPerPage: 2 }),
    brain,
    runDir: tmpRunDir(t),
    log: quietLog,
  });
  const deadLinks = findings.filter((f) => f.source === "oracle:dead-link");
  assert.deepEqual(deadLinks, [], "brain-invented goto 404 must never file dead-link: " + JSON.stringify(findings.map((f) => f.title)));
});

test("stats count successful vs failed brain turns instead of only logging-and-continuing", { timeout: 60_000 }, async (t) => {
  const brain = flakyBrain([
    { action: null, findings: [], done: false },
    null,
    null,
    { action: null, findings: [], done: true },
  ]);
  const { stats } = await runSession({
    config: makeConfig(["/"], { actionsPerPage: 4 }),
    brain,
    runDir: tmpRunDir(t),
    log: quietLog,
  });
  assert.equal(stats.llmCalls, 4, "every attempted turn is still counted in llmCalls");
  assert.equal(stats.turnsOk, 2, "two turns returned ok:true");
  assert.equal(stats.turnsFailed, 2, "two turns returned ok:false");
});
