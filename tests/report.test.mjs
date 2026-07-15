// Tests for lib/report.mjs + lib/runstore.mjs (agent D). Hermetic: temp dirs
// only, no network, no real claude CLI.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  writeReport,
  POSITIONING_LINE,
  groupFindings,
  describeStep,
  countsByStatus,
  computeRunState,
} from "../lib/report.mjs";
import {
  createRun,
  finalizeRun,
  listRuns,
  readRun,
  isRunId,
  formatRunId,
} from "../lib/runstore.mjs";

const BANNED = [/free forever/i, /zero marginal cost/i, /unlimited/i];

function tmpBase(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nightshift-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeTrace() {
  const base = "http://127.0.0.1:4185";
  return [
    {
      i: 0, kind: "goto", locator: null, value: `${base}/`, url: "about:blank",
      postUrl: `${base}/`, ok: true, error: null, tMs: 120,
      settle: { condition: "networkidle", waitedMs: 250 },
    },
    {
      i: 1, kind: "click",
      locator: { strategy: "role", role: "button", name: "Choose color", nth: 0 },
      value: null, url: `${base}/`, postUrl: `${base}/`, ok: true, error: null, tMs: 40,
      settle: { condition: "timeout", waitedMs: 1500 },
    },
    {
      i: 2, kind: "click",
      locator: { strategy: "role", role: "button", name: "Add to cart", nth: 0 },
      value: null, url: `${base}/`, postUrl: `${base}/`, ok: true, error: null, tMs: 35,
      settle: { condition: "timeout", waitedMs: 1500 },
    },
  ];
}

function makeFinding(overrides = {}) {
  return {
    id: "NS-001",
    source: "oracle:page-error",
    title: "Add to cart crashes with TypeError",
    severity: "critical",
    signature: "page-error|/|typeerror: cart.total is not a function",
    failure: {
      oracle: "page-error",
      message: "TypeError: cart.total is not a function",
      url: "http://127.0.0.1:4185/",
      detail: {},
      atStep: 2,
      ts: 1700000000000,
    },
    semantic: null,
    trace: makeTrace(),
    evidence: {
      screenshot: "shots/NS-001.png",
      consoleTail: ["TypeError: cart.total is not a function"],
      url: "http://127.0.0.1:4185/",
    },
    status: "confirmed",
    reverify: {
      replays: 2,
      reproduced: 2,
      verdicts: ["reproduced", "reproduced"],
      minimized: false,
      reproScript: "repro/NS-001.mjs",
    },
    ...overrides,
  };
}

function fixtureFindings() {
  // Deliberately shuffled: report must reorder confirmed-first.
  return [
    makeFinding({
      id: "NS-004", status: "unverifiable", severity: "minor",
      title: "Vibes feel off on the deals page",
      source: "brain:semantic",
      failure: null,
      semantic: { expected: "deals load", actual: "unclear" },
      reverify: { replays: 2, reproduced: 0, verdicts: ["replay-broken", "replay-broken"], minimized: false, reproScript: null },
    }),
    makeFinding({
      id: "NS-002", status: "flaky", severity: "major",
      title: "Deals endpoint intermittently fails",
      reverify: { replays: 2, reproduced: 1, verdicts: ["reproduced", "not-reproduced"], minimized: false, reproScript: "repro/NS-002.mjs" },
    }),
    makeFinding({ id: "NS-001", status: "confirmed" }),
    makeFinding({
      id: "NS-003", status: "unconfirmed", severity: "minor",
      title: "Coupon label flickers",
      reverify: { replays: 2, reproduced: 0, verdicts: ["not-reproduced", "not-reproduced"], minimized: false, reproScript: "repro/NS-003.mjs" },
    }),
  ];
}

function writeFixtureReport(t) {
  const base = tmpBase(t);
  const { runId, runDir } = createRun({ report: { dir: base } });
  const out = writeReport(runDir, {
    config: { target: { name: "Bugbox", url: "http://127.0.0.1:4185" } },
    findings: fixtureFindings(),
    stats: {
      routesVisited: 2, actionsExecuted: 9, llmCalls: 6,
      startedAt: "2026-07-02T06:00:00.000Z", endedAt: "2026-07-02T06:12:03.000Z",
      durationMs: 723000,
      usage: { inputTokens: 12345, outputTokens: 6789, costUsd: null },
    },
    brainMeta: { mode: "subscription-cli", model: "sonnet" },
  });
  return { base, runId, runDir, ...out };
}

test("writeReport writes report.json + report.md and returns their paths", (t) => {
  const { jsonPath, mdPath, runDir } = writeFixtureReport(t);
  assert.equal(jsonPath, path.join(runDir, "report.json"));
  assert.equal(mdPath, path.join(runDir, "report.md"));
  assert.ok(fs.existsSync(jsonPath));
  assert.ok(fs.existsSync(mdPath));
  const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  assert.equal(parsed.findings.length, 4);
  assert.equal(parsed.brain.mode, "subscription-cli");
  assert.equal(parsed.counts.confirmed, 1);
  assert.equal(parsed.positioning, POSITIONING_LINE);
});

test("report.md header has brain mode/model, token usage, softened positioning line", (t) => {
  const { mdPath } = writeFixtureReport(t);
  const md = fs.readFileSync(mdPath, "utf8");
  assert.ok(md.includes(POSITIONING_LINE), "positioning line missing");
  assert.ok(md.includes("subscription-cli"));
  assert.ok(md.includes("sonnet"));
  assert.ok(md.includes("12345 input"));
  assert.ok(md.includes("6789 output"));
});

test("banned marketing strings never appear in report.md or report.json", (t) => {
  const { mdPath, jsonPath } = writeFixtureReport(t);
  for (const file of [mdPath, jsonPath]) {
    const text = fs.readFileSync(file, "utf8");
    for (const banned of BANNED) {
      assert.ok(!banned.test(text), `${banned} found in ${path.basename(file)}`);
    }
  }
});

test("confirmed findings come first, other statuses in labelled sections", (t) => {
  const { mdPath } = writeFixtureReport(t);
  const md = fs.readFileSync(mdPath, "utf8");
  const idx = (s) => {
    const i = md.indexOf(s);
    assert.ok(i !== -1, `missing: ${s}`);
    return i;
  };
  // Section labels present and ordered.
  const confirmed = idx("## Confirmed bugs");
  const flaky = idx("## Flaky");
  const unconfirmed = idx("## Unconfirmed");
  const unverifiable = idx("## Unverifiable");
  assert.ok(confirmed < flaky && flaky < unconfirmed && unconfirmed < unverifiable);
  // Findings ordered accordingly despite shuffled input.
  assert.ok(idx("NS-001") < idx("NS-002"));
  assert.ok(idx("### NS-002") < idx("### NS-003"));
  assert.ok(idx("### NS-003") < idx("### NS-004"));
});

test("numbered English repro steps derived from the trace, with evidence paths", (t) => {
  const { mdPath } = writeFixtureReport(t);
  const md = fs.readFileSync(mdPath, "utf8");
  assert.ok(md.includes("1. Go to http://127.0.0.1:4185/"));
  assert.ok(md.includes('2. Click the button "Choose color"'));
  assert.ok(md.includes('3. Click the button "Add to cart"'));
  assert.ok(md.includes("shots/NS-001.png"));
  assert.ok(md.includes("repro/NS-001.mjs"));
  assert.ok(md.includes("TypeError: cart.total is not a function"));
});

test("describeStep covers every action kind in plain English", () => {
  const loc = { strategy: "role", role: "textbox", name: "Email", nth: 0 };
  assert.equal(describeStep({ kind: "goto", locator: null, value: "/cart" }), "Go to /cart");
  assert.equal(describeStep({ kind: "back", locator: null }), "Go back to the previous page");
  assert.equal(describeStep({ kind: "click", locator: loc }), 'Click the textbox "Email"');
  assert.equal(describeStep({ kind: "fill", locator: loc, value: "a@b.c" }), 'Fill the textbox "Email" with "a@b.c"');
  assert.equal(describeStep({ kind: "select", locator: loc, value: "red" }), 'Select "red" in the textbox "Email"');
  assert.equal(describeStep({ kind: "press", locator: loc, value: "Enter" }), 'Press "Enter" with focus on the textbox "Email"');
  assert.equal(
    describeStep({ kind: "click", locator: { strategy: "css", css: "#total" } }),
    "Click the element matching `#total`"
  );
});

test("text-verified findings get their own section, ordered after confirmed, with an honest caveat", (t) => {
  const findings = [
    ...fixtureFindings(),
    makeFinding({
      id: "NS-005", status: "text-verified", severity: "major",
      title: "Discount banner missing after checkout",
      source: "brain:semantic",
      failure: null,
      semantic: { expected: "no discount banner", actual: "banner still shown" },
      check: { kind: "text-absent", selector: null, text: "Discount applied" },
    }),
  ];
  const base = tmpBase(t);
  const { runId, runDir } = createRun({ report: { dir: base } });
  const out = writeReport(runDir, {
    config: { target: { name: "Bugbox", url: "http://127.0.0.1:4185" } },
    findings,
    stats: { usage: {}, routesVisited: 1, actionsExecuted: 3, llmCalls: 1, durationMs: 1000 },
    brainMeta: { mode: "test", model: "test" },
  });
  const md = fs.readFileSync(out.mdPath, "utf8");
  const idx = (s) => {
    const i = md.indexOf(s);
    assert.ok(i !== -1, `missing: ${s}`);
    return i;
  };
  const confirmed = idx("## Confirmed bugs");
  const textVerified = idx("## Text-verified");
  const flaky = idx("## Flaky");
  assert.ok(confirmed < textVerified && textVerified < flaky, "text-verified sits between confirmed and flaky");
  assert.ok(idx("### NS-005") > textVerified);
  assert.ok(
    md.includes(
      "Caveat: verified by a text substring check only — this confirms the text was " +
        "(or was not) present, not ordering, counts, or correctness beyond that."
    )
  );
  const parsed = JSON.parse(fs.readFileSync(out.jsonPath, "utf8"));
  assert.equal(parsed.counts["text-verified"], 1);
  assert.equal(parsed.counts.confirmed, 1);
});

test("groupFindings and countsByStatus agree, confirmed group first", () => {
  const groups = groupFindings(fixtureFindings());
  assert.deepEqual(groups.map((g) => g.status), ["confirmed", "flaky", "unconfirmed", "unverifiable"]);
  const counts = countsByStatus(fixtureFindings());
  assert.equal(counts.total, 4);
  assert.equal(counts.confirmed, 1);
  assert.equal(counts.flaky, 1);
  assert.equal(counts.unconfirmed, 1);
  assert.equal(counts.unverifiable, 1);
});

test("computeRunState: healthy/degraded/failed/inconclusive from turn success ratio and actionsExecuted", () => {
  assert.equal(computeRunState({ llmCalls: 4, turnsOk: 4, actionsExecuted: 3 }), "healthy");
  assert.equal(computeRunState({ llmCalls: 4, turnsOk: 3, actionsExecuted: 3 }), "degraded");
  assert.equal(computeRunState({ llmCalls: 4, turnsOk: 1, actionsExecuted: 1 }), "failed", "below 50% turn success is failed");
  assert.equal(computeRunState({ llmCalls: 4, turnsOk: 0, actionsExecuted: 0 }), "inconclusive", "zero successful turns and zero actions is inconclusive");
  assert.equal(computeRunState({ llmCalls: 0, turnsOk: 0, actionsExecuted: 0 }), "inconclusive", "no turns attempted at all");
  assert.equal(computeRunState({ llmCalls: 4, turnsOk: 4, actionsExecuted: 0 }), "inconclusive", "turns ok but nothing was ever explored");
});

test("computeRunState: sweep mode is judged on actions, not LLM turns (llmCalls==0 is healthy)", () => {
  assert.equal(computeRunState({ mode: "sweep", llmCalls: 0, actionsExecuted: 8 }), "healthy", "a sweep that exercised elements is healthy despite zero LLM calls");
  assert.equal(computeRunState({ mode: "sweep", llmCalls: 0, actionsExecuted: 0 }), "inconclusive", "a sweep that exercised nothing is inconclusive");
});

test("writeReport persists runState in report.json and report.md", (t) => {
  const base = tmpBase(t);
  const { runDir } = createRun({ report: { dir: base } });
  const { jsonPath, mdPath } = writeReport(runDir, {
    config: { target: { name: "Bugbox", url: "http://127.0.0.1:4185" } },
    findings: [],
    stats: {
      routesVisited: 1, actionsExecuted: 2, llmCalls: 4, turnsOk: 1, turnsFailed: 3,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
    },
    brainMeta: { mode: "mock", model: "scripted" },
  });
  const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  assert.equal(parsed.runState, "failed");
  const md = fs.readFileSync(mdPath, "utf8");
  assert.match(md, /Run state: \*\*failed\*\*/);
});

// --- runstore ---

test("createRun makes .nightshift/<YYYYMMDD-HHmmss>/ with shots/ and repro/", (t) => {
  const base = tmpBase(t);
  const { runId, runDir } = createRun({ report: { dir: base } });
  assert.match(runId, /^\d{8}-\d{6}$/);
  assert.equal(runDir, path.join(base, runId));
  assert.ok(fs.statSync(path.join(runDir, "shots")).isDirectory());
  assert.ok(fs.statSync(path.join(runDir, "repro")).isDirectory());
});

test("createRun bumps the id on a same-second collision, keeping the format", (t) => {
  const base = tmpBase(t);
  const a = createRun({ report: { dir: base } });
  const b = createRun({ report: { dir: base } });
  assert.notEqual(a.runId, b.runId);
  assert.match(b.runId, /^\d{8}-\d{6}$/);
});

test("writeReport finalizes: latest.json pointer lands next to the run dir", (t) => {
  const { base, runId } = writeFixtureReport(t);
  const pointer = JSON.parse(fs.readFileSync(path.join(base, "latest.json"), "utf8"));
  assert.equal(pointer.runId, runId);
  assert.equal(pointer.runDir, path.join(base, runId));
  assert.ok(pointer.finalizedAt);
});

test("finalizeRun can be called directly", (t) => {
  const base = tmpBase(t);
  const { runId, runDir } = createRun({ report: { dir: base } });
  const file = finalizeRun(runDir);
  assert.equal(file, path.join(base, "latest.json"));
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).runId, runId);
});

test("listRuns returns newest first with parsed reports; readRun fetches one", (t) => {
  const { base, runId } = writeFixtureReport(t);
  // An older run with no report yet.
  const olderId = "20200101-000000";
  fs.mkdirSync(path.join(base, olderId), { recursive: true });
  // Noise that must be ignored: files and non-run dirs.
  fs.mkdirSync(path.join(base, "not-a-run"), { recursive: true });

  const runs = listRuns(base);
  assert.deepEqual(runs.map((r) => r.runId), [runId, olderId]);
  assert.equal(runs[0].report.counts.confirmed, 1);
  assert.equal(runs[1].report, null);

  const one = readRun(base, runId);
  assert.equal(one.runId, runId);
  assert.equal(one.report.brain.model, "sonnet");
  assert.equal(readRun(base, "20990101-000000"), null);
});

test("readRun rejects malformed / traversal run ids", (t) => {
  const base = tmpBase(t);
  assert.equal(readRun(base, "../etc"), null);
  assert.equal(readRun(base, "20200101-000000/.."), null);
  assert.equal(readRun(base, "latest.json"), null);
  assert.ok(!isRunId("../20200101-000000"));
  assert.ok(isRunId(formatRunId(new Date())));
});

test("listRuns on a missing data dir returns []", () => {
  assert.deepEqual(listRuns(path.join(os.tmpdir(), "nightshift-definitely-missing-xyz")), []);
});

// --- fixes: findings review 2026-07-02 ---

test("report.md neutralizes hostile page-derived strings (markdown/HTML injection)", (t) => {
  const payload =
    'boom\n\n## INJECTED HEADING\n\n[click me](http://evil.example)\n\n<img src=x onerror=alert(1)>\n\n```\nend';
  const hostile = makeFinding({
    id: "NS-009",
    title: "line1\n## INJECTED TITLE HEADING",
    failure: {
      oracle: "console-error",
      message: payload,
      url: "http://127.0.0.1:4185/",
      detail: {},
      atStep: 1,
      ts: 1700000000000,
    },
    semantic: { expected: "<b>bold</b> claims", actual: "[forged](http://evil.example) result" },
    check: { kind: "text-present", selector: "#x", text: "<script>alert(1)</script>" },
    trace: [
      {
        i: 0, kind: "click",
        locator: { strategy: "role", role: "button", name: "Buy [now](http://evil.example) <img src=x onerror=alert(1)>", nth: 0 },
        value: null, url: "http://127.0.0.1:4185/", postUrl: "http://127.0.0.1:4185/",
        ok: true, error: null, tMs: 10, settle: { condition: "timeout", waitedMs: 0 },
      },
    ],
    evidence: {
      screenshot: "shots/NS-009.png",
      consoleTail: ["[error] " + payload, "tick ``` tock"],
      url: "http://127.0.0.1:4185/",
      excerpt: "before <img src=x onerror=alert(1)> after",
    },
  });

  const base = tmpBase(t);
  const { runDir } = createRun({ report: { dir: base } });
  const { mdPath } = writeReport(runDir, {
    config: { target: { name: "Bugbox", url: "http://127.0.0.1:4185" } },
    findings: [hostile],
    stats: { usage: { inputTokens: 0, outputTokens: 0, costUsd: null } },
    brainMeta: { mode: "mock", model: "scripted" },
  });
  const md = fs.readFileSync(mdPath, "utf8");

  // no injected block elements: hostile text can never start a line as a heading
  assert.ok(!/^## INJECTED/m.test(md), "injected heading rendered live");
  // no inline HTML outside code fences (fenced blocks render literally, so
  // the console-tail body may keep its raw text verbatim)
  const outsideFences = md.replace(/^ {2}(`{3,})\n[\s\S]*?^ {2}\1$/gm, "");
  assert.ok(!outsideFences.includes("<img"), "raw <img> tag leaked into report.md");
  assert.ok(!outsideFences.includes("<script>"), "raw <script> tag leaked into report.md");
  assert.ok(md.includes("&lt;img"), "angle brackets should be entity-encoded");
  // no clickable forged links outside code fences
  assert.ok(!outsideFences.includes("[click me](http://evil.example)"), "forged markdown link leaked");
  assert.ok(!outsideFences.includes("[forged](http://evil.example)"), "forged markdown link leaked (semantic actual)");
  assert.ok(!outsideFences.includes("[now](http://evil.example)"), "forged markdown link leaked (locator name)");
  // console-tail fence integrity: the opening fence run must be longer than
  // any backtick run in the hostile body, so the embedded ``` cannot close it
  const fenceLines = (md.match(/^ {2}`+$/gm) ?? []).map((l) => l.trim());
  assert.ok(fenceLines.length >= 2, "console tail fence missing");
  const openLen = fenceLines[0].length;
  assert.ok(openLen >= 4, `fence must outrun the embedded \`\`\` (got ${openLen})`);
  assert.equal(fenceLines.at(-1).length, openLen, "closing fence must match the opening fence");
  for (const inner of fenceLines.slice(1, -1)) {
    assert.ok(inner.length < openLen, "hostile backtick run must stay strictly inside the fence");
  }
});

test("writeReport writes repro scripts itself (static reprogen import — no version-dependent require)", (t) => {
  // On Node 22.0-22.11 a createRequire() of the ESM reprogen threw
  // ERR_REQUIRE_ESM and a bare catch silently wrote ZERO repro scripts.
  // The import must be static, and the trust artifact must actually land.
  const src = fs.readFileSync(new URL("../lib/report.mjs", import.meta.url), "utf8");
  assert.ok(!src.includes("createRequire("), "lib/report.mjs must not require() the ESM reprogen");
  assert.match(src, /^import \{ generateReproScript \} from "\.\/reprogen\.mjs";$/m, "reprogen must be a static import");

  const base = tmpBase(t);
  const { runDir } = createRun({ report: { dir: base } });
  const confirmed = makeFinding({ id: "NS-021", reverify: { replays: 2, reproduced: 2, verdicts: ["reproduced", "reproduced"], minimized: false, reproScript: null } });
  const { mdPath } = writeReport(runDir, {
    config: { target: { name: "Bugbox", url: "http://127.0.0.1:4185" } },
    findings: [confirmed],
    stats: { usage: { inputTokens: 0, outputTokens: 0, costUsd: null } },
    brainMeta: { mode: "mock", model: "scripted" },
  });
  assert.ok(fs.existsSync(path.join(runDir, "repro", "NS-021.mjs")), "repro/NS-021.mjs must be written");
  const md = fs.readFileSync(mdPath, "utf8");
  assert.ok(md.includes("repro/NS-021.mjs"), "report.md must reference the repro script");
});
