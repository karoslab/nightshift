// tests/reverify.test.mjs — hermetic: in-test http server (port 0) with
// deterministic seeded bugs; no LLM, no external network.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { reverifyFinding } from "../lib/reverify.mjs";
import { buildSignature } from "../lib/signature.mjs";

let server;
let origin;
let onceHits = 0; // /api/once 500s only on its first hit — deterministic flaky

const PAGES = {
  "/bug": `<html><body><h1>Shop</h1>
    <button onclick="fetch('/api/flaky')">Load deals</button></body></html>`,
  "/flaky-once": `<html><body>
    <button onclick="fetch('/api/once')">Load deals</button></body></html>`,
  "/healthy": `<html><body><h1>Fine</h1>
    <button onclick="document.title='ok'">Load deals</button></body></html>`,
  "/banana": `<html><body><div id="total">Banana</div></body></html>`,
  "/nan": `<html><body><div id="total">Grand Total: NaN (coupon applied)</div></body></html>`,
  "/hub": `<html><body><p>nothing interesting here</p></body></html>`,
};

before(async () => {
  server = http.createServer((req, res) => {
    const pathname = req.url.split("?")[0];
    if (pathname === "/api/flaky") {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("boom");
      return;
    }
    if (pathname === "/api/once") {
      const status = onceHits++ === 0 ? 500 : 200;
      res.writeHead(status, { "content-type": "text/plain" });
      res.end(status === 500 ? "boom" : "ok");
      return;
    }
    const html = PAGES[pathname];
    if (!html) {
      res.writeHead(404, { "content-type": "text/html" });
      res.end("<html><body>404</body></html>");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(html);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = "http://127.0.0.1:" + server.address().port;
});

after(async () => {
  await new Promise((r) => server.close(r));
});

const makeConfig = () => ({
  target: { name: "Test", url: origin, routes: ["/"] },
  oracles: { expectedStatuses: [401, 403], ignoreConsole: [] },
  reverify: { replays: 2, requiredPasses: 2, navTimeoutMs: 5000 },
});

const quietLog = () => {};

const gotoStep = (i, path) => ({
  i, kind: "goto", locator: null, value: origin + path, url: "", postUrl: origin + path,
  ok: true, error: null, tMs: 10, settle: { condition: "networkidle", waitedMs: 0 },
});
const clickStep = (i, name, path) => ({
  i, kind: "click", locator: { strategy: "role", role: "button", name, nth: 0 }, value: null,
  url: origin + path, postUrl: origin + path,
  ok: true, error: null, tMs: 10, settle: { condition: "networkidle", waitedMs: 0 },
});

const flakyEvent = (requestPath) => ({
  oracle: "network-5xx",
  message: "HTTP 500 GET " + requestPath,
  url: origin + "/bug",
  detail: { status: 500, method: "GET", requestUrl: requestPath },
  atStep: 1,
  ts: Date.now(),
});

const oracleFinding = ({ trace, event }) => ({
  id: "NS-001",
  source: "oracle:" + event.oracle,
  title: "endpoint " + event.detail.requestUrl + " fails",
  severity: "critical",
  signature: buildSignature(event),
  failure: event,
  semantic: null,
  check: null,
  trace,
  evidence: { screenshot: null, consoleTail: [], url: event.url },
  status: "candidate",
  reverify: null,
});

const semanticFinding = ({ trace, check, url }) => ({
  id: "NS-002",
  source: "brain:semantic",
  title: "semantic finding",
  severity: "major",
  signature: check ? buildSignature({ ...check, url }) : "semantic|/|x",
  failure: null,
  semantic: { expected: "a real total", actual: "something else" },
  check,
  trace,
  evidence: { screenshot: null, consoleTail: [], url },
  status: "candidate",
  reverify: null,
});

test("deterministic bug reproduces on both replays -> confirmed", async () => {
  const finding = oracleFinding({
    trace: [gotoStep(0, "/bug"), clickStep(1, "Load deals", "/bug")],
    event: flakyEvent("/api/flaky"),
  });
  const out = await reverifyFinding(finding, { config: makeConfig(), log: quietLog });
  assert.equal(out.status, "confirmed");
  assert.deepEqual(out.reverify, {
    replays: 2,
    reproduced: 2,
    verdicts: ["reproduced", "reproduced"],
    minimized: false, // single-goto trace: nothing to cut
    reproScript: null, // the report layer fills this in
  });
  assert.equal(out.trace.length, 2, "trace untouched when not minimized");
  assert.equal(finding.status, "candidate", "input finding is not mutated");
});

test("healthy page never fires the signature -> unconfirmed", async () => {
  const finding = oracleFinding({
    trace: [gotoStep(0, "/healthy"), clickStep(1, "Load deals", "/healthy")],
    event: flakyEvent("/api/flaky"), // claims a 500 the healthy page never makes
  });
  const out = await reverifyFinding(finding, { config: makeConfig(), log: quietLog });
  assert.equal(out.status, "unconfirmed");
  assert.deepEqual(out.reverify.verdicts, ["not-reproduced", "not-reproduced"]);
  assert.equal(out.reverify.reproduced, 0);
});

test("bug that fires once then heals -> flaky", async () => {
  const finding = oracleFinding({
    trace: [gotoStep(0, "/flaky-once"), clickStep(1, "Load deals", "/flaky-once")],
    event: {
      oracle: "network-5xx",
      message: "HTTP 500 GET /api/once",
      url: origin + "/flaky-once",
      detail: { status: 500, method: "GET", requestUrl: "/api/once" },
      atStep: 1,
      ts: Date.now(),
    },
  });
  const out = await reverifyFinding(finding, { config: makeConfig(), log: quietLog });
  assert.equal(out.status, "flaky");
  assert.deepEqual(out.reverify.verdicts, ["reproduced", "not-reproduced"]);
});

test('semantic check is case-SENSITIVE: "NaN" and "Total: NaN" never match "Banana"', async () => {
  // case-insensitive matching would find "nan" inside "Banana" — the exact
  // false positive the pinned case-SENSITIVE substring rule exists to prevent
  for (const text of ["NaN", "Total: NaN"]) {
    const finding = semanticFinding({
      trace: [gotoStep(0, "/banana")],
      check: { kind: "text-present", selector: "#total", text },
      url: origin + "/banana",
    });
    const out = await reverifyFinding(finding, { config: makeConfig(), log: quietLog });
    assert.equal(out.status, "unconfirmed", `check text ${JSON.stringify(text)} must not match "Banana"`);
    assert.deepEqual(out.reverify.verdicts, ["not-reproduced", "not-reproduced"]);
    assert.equal(out.evidence.excerpt, undefined, "no excerpt when nothing matched");
  }
});

test("semantic text-present match -> confirmed with ±80-char excerpt evidence", async () => {
  const finding = semanticFinding({
    trace: [gotoStep(0, "/nan")],
    check: { kind: "text-present", selector: "#total", text: "Total: NaN" },
    url: origin + "/nan",
  });
  const out = await reverifyFinding(finding, { config: makeConfig(), log: quietLog });
  assert.equal(out.status, "confirmed");
  assert.equal(out.reverify.reproduced, 2);
  assert.ok(out.evidence.excerpt.includes("Total: NaN"), "excerpt contains the matched text");
  assert.ok(out.evidence.excerpt.includes("Grand"), "excerpt keeps surrounding context");
  assert.ok(out.evidence.excerpt.includes("(coupon applied)"), "excerpt keeps trailing context");
});

test("checkless semantic finding -> unverifiable without replaying", async () => {
  const finding = semanticFinding({ trace: [gotoStep(0, "/nan")], check: null, url: origin + "/nan" });
  const out = await reverifyFinding(finding, { config: makeConfig(), log: quietLog });
  assert.equal(out.status, "unverifiable");
  assert.deepEqual(out.reverify, {
    replays: 0,
    reproduced: 0,
    verdicts: [],
    minimized: false,
    reproScript: null,
  });
});

test("recorded element gone on every replay -> replay-broken -> unverifiable", async () => {
  const finding = oracleFinding({
    trace: [gotoStep(0, "/healthy"), clickStep(1, "Does Not Exist", "/healthy")],
    event: flakyEvent("/api/flaky"),
  });
  const out = await reverifyFinding(finding, { config: makeConfig(), log: quietLog });
  assert.equal(out.status, "unverifiable");
  assert.deepEqual(out.reverify.verdicts, ["replay-broken", "replay-broken"]);
});

test("minimization: suffix from the last goto is adopted when it reproduces", async () => {
  const fullTrace = [gotoStep(0, "/hub"), gotoStep(1, "/bug"), clickStep(2, "Load deals", "/bug")];
  const finding = oracleFinding({ trace: fullTrace, event: flakyEvent("/api/flaky") });
  const out = await reverifyFinding(finding, { config: makeConfig(), log: quietLog });
  assert.equal(out.status, "confirmed");
  assert.equal(out.reverify.minimized, true);
  assert.equal(out.trace.length, 2, "suffix starts at the most recent goto");
  assert.equal(out.trace[0].kind, "goto");
  assert.equal(out.trace[0].value, origin + "/bug");
  assert.deepEqual(out.trace.map((s) => s.i), [0, 1], "minimized trace renumbered from 0");
  assert.equal(finding.trace.length, 3, "input finding trace untouched");
});
