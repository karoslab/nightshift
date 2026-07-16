// tests/session-auth.test.mjs — end-to-end session wiring for auth + journeys
// against the bundled demo-app. Proves: exploration + journeys run once per
// role, findings carry the role tag, an auth role's storageState is persisted,
// the anonymous role reaches a gated route without crashing, and a seeded-broken
// journey yields a candidate that reverify CONFIRMS. Mock brain, no network.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSession, createIdMinter } from "../lib/session.mjs";
import { reverifyFinding } from "../lib/reverify.mjs";
import { startBugbox, DEMO_CREDENTIALS } from "../demo-app/server.mjs";

let bugbox;
let origin;

before(async () => {
  bugbox = await startBugbox(0);
  origin = `http://127.0.0.1:${bugbox.port}`;
});

after(async () => {
  await bugbox?.close();
});

const quiet = () => {};

// A brain that never proposes an action — exploration is a no-op, so the test
// isolates the auth + journeys wiring (deterministic, fast).
function idleBrain() {
  return {
    mode: "mock",
    model: "idle",
    async ask() {
      return { ok: true, json: { action: null, findings: [], done: true }, rawText: "{}", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
    },
    async close() {},
  };
}

// A brain that always proposes another action (never done) so it drains the
// call budget — used to prove the budget is shared across roles, not per role.
function greedyBrain() {
  return {
    mode: "mock",
    model: "greedy",
    async ask() {
      return {
        ok: true,
        json: { action: { kind: "click", elementId: 0, why: "keep going" }, findings: [], done: false },
        rawText: "{}",
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      };
    },
    async close() {},
  };
}

function tmpRunDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ns-session-auth-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function config() {
  return {
    target: {
      name: "Bugbox",
      url: origin,
      routes: ["/", "/account"],
      maxRoutes: 4,
      actionsPerPage: 1,
      selectorDenylist: [],
      denyActionKinds: [],
      auth: {
        roles: [
          {
            name: "member",
            loginUrl: "/login",
            usernameEnv: "NS_DEMO_USER",
            passwordEnv: "NS_DEMO_PASS",
            steps: [
              { action: "fill", selector: "#username", valueFrom: "username" },
              { action: "fill", selector: "#password", valueFrom: "password" },
              { action: "click", selector: "#login" },
            ],
          },
        ],
      },
      journeys: [
        { name: "shop is open", steps: [{ action: "goto", url: "/", expect: { textPresent: "A tiny shop" } }] },
        {
          name: "add a colored item to the cart",
          steps: [
            { action: "goto", url: "/" },
            { action: "click", selector: "#choose-color" },
            { action: "click", selector: "#add-to-cart" },
          ],
        },
        {
          // Gated journey scoped to member only — it must NOT run (and
          // false-positive on the login redirect) under the anonymous role.
          name: "member sees their account",
          roles: ["member"],
          steps: [{ action: "goto", url: "/account", expect: { textPresent: "Signed in as demo" } }],
        },
      ],
    },
    budget: { maxLlmCalls: 10, maxMinutes: 5, maxSessionsPerNight: 4, stopAtHour: 6 },
    oracles: { expectedStatuses: [401, 403], ignoreConsole: [] },
    reverify: { replays: 2, requiredPasses: 2, navTimeoutMs: 10000 },
    report: { dir: ".nightshift" },
  };
}

const env = { NS_DEMO_USER: DEMO_CREDENTIALS.username, NS_DEMO_PASS: DEMO_CREDENTIALS.password };

test("session runs anonymous + auth role, tags findings, persists storageState, confirms a broken journey", { timeout: 180_000 }, async (t) => {
  const runDir = tmpRunDir(t);
  const { findings, stats } = await runSession({
    config: config(),
    brain: idleBrain(),
    runDir,
    log: quiet,
    mintId: createIdMinter(),
    env,
  });

  // Both roles explored (anonymous is the implicit default).
  assert.deepEqual(stats.rolesExplored, ["anonymous", "member"], JSON.stringify(stats.rolesExplored));

  // The auth role's storageState was persisted under the run dir.
  const statePath = path.join(runDir, "auth", "member.json");
  assert.ok(fs.existsSync(statePath), "member storageState must be persisted");

  // Every finding carries a role tag drawn from the two roles.
  for (const f of findings) {
    assert.ok(["anonymous", "member"].includes(f.role), `finding ${f.id} has unexpected role ${f.role}`);
  }

  // The passing journey files nothing; the broken journey files a page-error
  // tagged with its journey name — under BOTH roles (the bug affects both).
  const broken = findings.filter((f) => f.source === "oracle:page-error" && f.journey === "add a colored item to the cart");
  assert.ok(broken.length >= 1, "the broken journey must file a page-error candidate: " + JSON.stringify(findings.map((f) => [f.role, f.journey, f.source])));
  assert.ok(broken.some((f) => f.role === "anonymous") && broken.some((f) => f.role === "member"), "the broken journey should fire for both roles");

  // No finding references a crash on the gated /account route — anonymous is
  // redirected to /login, not crashed.
  const accountCrash = findings.find(
    (f) => (f.source === "oracle:page-error" || f.source === "oracle:nav-failure") && /\/account/.test(f.evidence?.url ?? ""),
  );
  assert.equal(accountCrash, undefined, "the gated route must not crash the anonymous role");

  // The member-scoped gated journey never runs under anonymous (no false
  // positive on the login redirect) and passes for member (files nothing).
  const gated = findings.filter((f) => f.journey === "member sees their account");
  assert.deepEqual(gated, [], "the member-scoped gated journey must not file any finding: " + JSON.stringify(gated.map((f) => [f.role, f.title])));

  // The seeded-broken journey candidate reverifies to confirmed.
  const verified = await reverifyFinding(broken[0], { config: config(), log: quiet });
  assert.equal(verified.status, "confirmed", JSON.stringify(verified.reverify));
});

test("the session LLM budget is shared across roles, not multiplied per role", { timeout: 120_000 }, async (t) => {
  const runDir = tmpRunDir(t);
  const cfg = config();
  cfg.budget.maxLlmCalls = 4; // 2 roles (anonymous + member) -> floor(4/2)=2 calls each
  cfg.target.actionsPerPage = 10; // plenty of headroom so the CALL budget is the binding limit
  cfg.target.journeys = []; // isolate exploration budget (journeys make no brain calls)

  const { stats } = await runSession({
    config: cfg,
    brain: greedyBrain(),
    runDir,
    log: quiet,
    mintId: createIdMinter(),
    env,
  });

  assert.deepEqual(stats.rolesExplored, ["anonymous", "member"]);
  // The whole point: total calls stay within the configured cap (4), NOT 2x it.
  assert.ok(
    stats.llmCalls <= cfg.budget.maxLlmCalls,
    `total LLM calls ${stats.llmCalls} must not exceed the configured cap ${cfg.budget.maxLlmCalls}`,
  );
  assert.equal(stats.llmCalls, 4, "each of the 2 roles gets floor(4/2)=2 calls, 4 total");
});
