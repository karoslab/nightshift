// tests/config.test.mjs — lib/config.mjs: pinned defaults, merge, validation.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, ConfigError } from "../lib/config.mjs";

// The exact defaults pinned in DESIGN.md — any drift here is a contract break.
const PINNED_DEFAULTS = {
  target: {
    name: "My App",
    url: "http://localhost:3000",
    routes: ["/"],
    maxRoutes: 12,
    actionsPerPage: 6,
    selectorDenylist: [],
    denyActionKinds: [],
    sweep: false,
    auth: { roles: [] },
    journeys: [],
  },
  brain: {
    mode: "subscription-cli",
    model: "sonnet",
    cliPath: null,
    apiKeyEnv: "ANTHROPIC_API_KEY",
    apiModel: "claude-sonnet-5",
    maxOutputTokens: 2048,
  },
  budget: {
    maxLlmCalls: 40,
    maxMinutes: 45,
    maxSessionsPerNight: 4,
    stopAtHour: 6,
  },
  oracles: {
    expectedStatuses: [401, 403],
    ignoreConsole: ["ResizeObserver loop", "\\[HMR\\]", "Download the React DevTools"],
  },
  reverify: { replays: 2, requiredPasses: 2, navTimeoutMs: 15000 },
  report: { dir: ".nightshift" },
  security: {
    enabled: false,
    scope: { origins: [] },
    checks: ["*"],
    severityFloor: "minor",
  },
};

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ns-config-"));
}

function writeConfig(dir, content, name = "config.json") {
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
}

function assertConfigError(fn, pattern) {
  assert.throws(fn, (e) => {
    assert.ok(e instanceof ConfigError, `expected ConfigError, got ${e.constructor.name}: ${e.message}`);
    assert.equal(e.name, "ConfigError");
    if (pattern) assert.match(e.message, pattern);
    return true;
  });
}

function inDir(dir, fn) {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(prev);
  }
}

test("returns the exact pinned defaults when no config file exists", () => {
  const config = inDir(tmpDir(), () => loadConfig());
  assert.deepEqual(config, PINNED_DEFAULTS);
});

test("picks up nightshift.config.json from cwd when no path is given", () => {
  const dir = tmpDir();
  writeConfig(dir, { target: { name: "Cwd App" } }, "nightshift.config.json");
  const config = inDir(dir, () => loadConfig());
  assert.equal(config.target.name, "Cwd App");
  assert.equal(config.target.url, "http://localhost:3000"); // default preserved
});

test("explicit path that does not exist throws ConfigError", () => {
  assertConfigError(() => loadConfig(path.join(tmpDir(), "nope.json")), /not found/);
});

test("invalid JSON throws ConfigError with a parse message", () => {
  const file = writeConfig(tmpDir(), "{ not json !!");
  assertConfigError(() => loadConfig(file), /parse/i);
});

test("top-level array is rejected", () => {
  const file = writeConfig(tmpDir(), "[1,2,3]");
  assertConfigError(() => loadConfig(file), /JSON object/);
});

test("deep merge: user keys win, sibling defaults survive, arrays replace", () => {
  const file = writeConfig(tmpDir(), {
    target: { url: "http://localhost:9999" },
    brain: { mode: "api-key" },
    oracles: { expectedStatuses: [404] },
  });
  const config = loadConfig(file);
  assert.equal(config.target.url, "http://localhost:9999");
  assert.equal(config.target.maxRoutes, 12);
  assert.equal(config.brain.mode, "api-key");
  assert.equal(config.brain.model, "sonnet");
  assert.equal(config.brain.apiModel, "claude-sonnet-5");
  assert.equal(config.budget.maxLlmCalls, 40);
  assert.deepEqual(config.oracles.expectedStatuses, [404]); // replaced, not concatenated
  assert.deepEqual(config.oracles.ignoreConsole, PINNED_DEFAULTS.oracles.ignoreConsole);
});

test("brain.mode validation: rejects unknown modes with a human message", () => {
  const file = writeConfig(tmpDir(), { brain: { mode: "banana" } });
  assertConfigError(() => loadConfig(file), /brain\.mode.*"banana"/s);
});

test("brain.mode validation: accepts all three pinned modes", () => {
  for (const mode of ["subscription-cli", "api-key", "mock"]) {
    const file = writeConfig(tmpDir(), { brain: { mode } });
    assert.equal(loadConfig(file).brain.mode, mode);
  }
});

test("target.url must be an http(s) URL", () => {
  assertConfigError(() => loadConfig(writeConfig(tmpDir(), { target: { url: "not a url" } })), /target\.url/);
  assertConfigError(() => loadConfig(writeConfig(tmpDir(), { target: { url: "ftp://x" } })), /target\.url/);
  assertConfigError(() => loadConfig(writeConfig(tmpDir(), { target: { url: 42 } })), /target\.url/);
});

test("target.routes entries must be paths or absolute http(s) URLs", () => {
  assertConfigError(() => loadConfig(writeConfig(tmpDir(), { target: { routes: ["about"] } })), /target\.routes/);
  assertConfigError(() => loadConfig(writeConfig(tmpDir(), { target: { routes: [] } })), /target\.routes/);
  const ok = loadConfig(writeConfig(tmpDir(), { target: { routes: ["/", "/cart", "http://localhost:3000/x"] } }));
  assert.equal(ok.target.routes.length, 3);
});

test("budget numbers are validated", () => {
  assertConfigError(() => loadConfig(writeConfig(tmpDir(), { budget: { maxLlmCalls: 0 } })), /budget\.maxLlmCalls/);
  assertConfigError(() => loadConfig(writeConfig(tmpDir(), { budget: { maxMinutes: -5 } })), /budget\.maxMinutes/);
  assertConfigError(() => loadConfig(writeConfig(tmpDir(), { budget: { stopAtHour: 24 } })), /stopAtHour/);
  assertConfigError(() => loadConfig(writeConfig(tmpDir(), { budget: { stopAtHour: -1 } })), /stopAtHour/);
  assert.equal(loadConfig(writeConfig(tmpDir(), { budget: { stopAtHour: 0 } })).budget.stopAtHour, 0);
});

test("budget.stopAtHour rejects afternoon/evening hours the midnight-wrap rule can never honor", () => {
  // beforeStopHour()'s pinned wrap (stop while stopAtHour <= hour < 12) is
  // unsatisfiable for 12-23: a buyer setting stopAtHour 22 would get sessions
  // launching past 22:00 all night, silently. The loader must refuse.
  for (const hour of [12, 13, 22, 23]) {
    assertConfigError(() => loadConfig(writeConfig(tmpDir(), { budget: { stopAtHour: hour } })), /stopAtHour.*0-11/s);
  }
  for (const hour of [0, 6, 11]) {
    assert.equal(loadConfig(writeConfig(tmpDir(), { budget: { stopAtHour: hour } })).budget.stopAtHour, hour);
  }
});

test("reverify.requiredPasses cannot exceed reverify.replays", () => {
  assertConfigError(
    () => loadConfig(writeConfig(tmpDir(), { reverify: { replays: 2, requiredPasses: 3 } })),
    /requiredPasses/
  );
  const ok = loadConfig(writeConfig(tmpDir(), { reverify: { replays: 3, requiredPasses: 2 } }));
  assert.equal(ok.reverify.replays, 3);
});

test("oracles validation: statuses are integers, ignoreConsole patterns compile", () => {
  assertConfigError(
    () => loadConfig(writeConfig(tmpDir(), { oracles: { expectedStatuses: ["401"] } })),
    /expectedStatuses/
  );
  assertConfigError(
    () => loadConfig(writeConfig(tmpDir(), { oracles: { ignoreConsole: ["("] } })),
    /ignoreConsole/
  );
  assertConfigError(
    () => loadConfig(writeConfig(tmpDir(), { oracles: { ignoreConsole: [42] } })),
    /ignoreConsole/
  );
});

test("sections must be objects", () => {
  assertConfigError(() => loadConfig(writeConfig(tmpDir(), { target: "x" })), /"target" must be a JSON object/);
});

test("brain.cliPath accepts null or string only", () => {
  assertConfigError(() => loadConfig(writeConfig(tmpDir(), { brain: { cliPath: 5 } })), /brain\.cliPath/);
  assert.equal(loadConfig(writeConfig(tmpDir(), { brain: { cliPath: "/opt/claude" } })).brain.cliPath, "/opt/claude");
});

test("report.dir must be a non-empty string", () => {
  assertConfigError(() => loadConfig(writeConfig(tmpDir(), { report: { dir: "" } })), /report\.dir/);
});

test("target.routes absolute URLs must be same-origin as target.url", () => {
  assertConfigError(
    () =>
      loadConfig(
        writeConfig(tmpDir(), {
          target: { url: "http://localhost:3000", routes: ["/", "http://evil.example.com/lure"] },
        })
      ),
    /target\.routes.*same-origin/s
  );
  const ok = loadConfig(
    writeConfig(tmpDir(), { target: { url: "http://localhost:3000", routes: ["/", "http://localhost:3000/cart"] } })
  );
  assert.equal(ok.target.routes.length, 2);
});

test("target.selectorDenylist rejects structurally invalid CSS instead of silently ignoring it", () => {
  assertConfigError(
    () => loadConfig(writeConfig(tmpDir(), { target: { selectorDenylist: [".send-btn", "div[data-x=1"] } })),
    /selectorDenylist/
  );
  assertConfigError(
    () => loadConfig(writeConfig(tmpDir(), { target: { selectorDenylist: ["button:not(.ok"] } })),
    /selectorDenylist/
  );
  assertConfigError(
    () => loadConfig(writeConfig(tmpDir(), { target: { selectorDenylist: [""] } })),
    /selectorDenylist/
  );
  const ok = loadConfig(
    writeConfig(tmpDir(), { target: { selectorDenylist: [".send-btn", "button:not([disabled])", '[data-x="]"]'] } })
  );
  assert.equal(ok.target.selectorDenylist.length, 3);
});

test("target.denyActionKinds rejects unknown action kinds", () => {
  assertConfigError(
    () => loadConfig(writeConfig(tmpDir(), { target: { denyActionKinds: ["fill", "submit"] } })),
    /denyActionKinds/
  );
  const ok = loadConfig(writeConfig(tmpDir(), { target: { denyActionKinds: ["fill", "press", "select"] } }));
  assert.deepEqual(ok.target.denyActionKinds, ["fill", "press", "select"]);
});

test("target.sweep must be a boolean and defaults to false", () => {
  assertConfigError(() => loadConfig(writeConfig(tmpDir(), { target: { sweep: "yes" } })), /sweep must be a boolean/);
  assert.equal(loadConfig(writeConfig(tmpDir(), {})).target.sweep, false);
  assert.equal(loadConfig(writeConfig(tmpDir(), { target: { sweep: true } })).target.sweep, true);
});

test("security.enabled defaults false; zero behavior change until flipped", () => {
  const config = inDir(tmpDir(), () => loadConfig());
  assert.equal(config.security.enabled, false);
  assert.deepEqual(config.security.scope, { origins: [] });
  assert.deepEqual(config.security.checks, ["*"]);
  assert.equal(config.security.severityFloor, "minor");
});

test("security.enabled must be a boolean", () => {
  assertConfigError(() => loadConfig(writeConfig(tmpDir(), { security: { enabled: "yes" } })), /security\.enabled/);
});

test("security.scope.origins must be bare origins, not paths", () => {
  assertConfigError(
    () => loadConfig(writeConfig(tmpDir(), { security: { scope: { origins: ["https://cdn.example/lib.js"] } } })),
    /security\.scope\.origins/,
  );
  const ok = loadConfig(writeConfig(tmpDir(), { security: { scope: { origins: ["https://cdn.example"] } } }));
  assert.deepEqual(ok.security.scope.origins, ["https://cdn.example"]);
});

test("security.checks rejects unknown check ids", () => {
  assertConfigError(
    () => loadConfig(writeConfig(tmpDir(), { security: { checks: ["not-a-real-check"] } })),
    /security\.checks/,
  );
  const ok = loadConfig(writeConfig(tmpDir(), { security: { checks: ["missing-security-headers"] } }));
  assert.deepEqual(ok.security.checks, ["missing-security-headers"]);
});

test("security.severityFloor must be minor|major|critical", () => {
  assertConfigError(() => loadConfig(writeConfig(tmpDir(), { security: { severityFloor: "low" } })), /severityFloor/);
});

test("two loads never share mutable state", () => {
  const dir = tmpDir();
  const a = inDir(dir, () => loadConfig());
  const b = inDir(dir, () => loadConfig());
  a.target.routes.push("/mutated");
  a.oracles.ignoreConsole.push("x");
  assert.deepEqual(b.target.routes, ["/"]);
  assert.equal(b.oracles.ignoreConsole.length, 3);
});

// ---------------------------------------------------------------------------
// target.auth
// ---------------------------------------------------------------------------
test("target.auth defaults to an empty roles list (anonymous-only)", () => {
  const config = inDir(tmpDir(), () => loadConfig());
  assert.deepEqual(config.target.auth, { roles: [] });
});

test("target.auth accepts a valid steps-based role and keeps only env-var NAMES", () => {
  const role = {
    name: "member",
    loginUrl: "/login",
    usernameEnv: "NS_MEMBER_USER",
    passwordEnv: "NS_MEMBER_PASS",
    totpSecretEnv: "NS_MEMBER_TOTP",
    steps: [
      { action: "fill", selector: "#username", valueFrom: "username" },
      { action: "fill", selector: "#password", valueFrom: "password" },
      { action: "fill", selector: "#otp", valueFrom: "totp" },
      { action: "click", selector: "#login" },
    ],
  };
  const config = loadConfig(writeConfig(tmpDir(), { target: { auth: { roles: [role] } } }));
  assert.equal(config.target.auth.roles[0].name, "member");
  // The stored config carries names, not secret values.
  assert.equal(config.target.auth.roles[0].usernameEnv, "NS_MEMBER_USER");
});

test("target.auth rejects the reserved role name 'anonymous'", () => {
  assertConfigError(
    () => loadConfig(writeConfig(tmpDir(), { target: { auth: { roles: [{ name: "anonymous", loginUrl: "/l", steps: [{ action: "click", selector: "#x" }] }] } } })),
    /reserved/,
  );
});

test("target.auth rejects duplicate role names", () => {
  const r = { name: "member", loginUrl: "/l", steps: [{ action: "click", selector: "#x" }] };
  assertConfigError(
    () => loadConfig(writeConfig(tmpDir(), { target: { auth: { roles: [r, { ...r }] } } })),
    /unique/,
  );
});

test("target.auth requires exactly one of steps or setupScript", () => {
  assertConfigError(
    () => loadConfig(writeConfig(tmpDir(), { target: { auth: { roles: [{ name: "m", loginUrl: "/l" }] } } })),
    /exactly one of "steps"/,
  );
  const ok = loadConfig(writeConfig(tmpDir(), { target: { auth: { roles: [{ name: "m", setupScript: "./login.mjs" }] } } }));
  assert.equal(ok.target.auth.roles[0].setupScript, "./login.mjs");
});

test("target.auth env fields must be NAMES, not values with spaces or symbols", () => {
  assertConfigError(
    () => loadConfig(writeConfig(tmpDir(), { target: { auth: { roles: [{ name: "m", loginUrl: "/l", usernameEnv: "secret-value!", steps: [{ action: "click", selector: "#x" }] }] } } })),
    /ENVIRONMENT VARIABLE NAME/,
  );
});

test("target.auth valueFrom must have a matching env field on the role", () => {
  assertConfigError(
    () => loadConfig(writeConfig(tmpDir(), { target: { auth: { roles: [{ name: "m", loginUrl: "/l", steps: [{ action: "fill", selector: "#u", valueFrom: "username" }] }] } } })),
    /requires .*usernameEnv/,
  );
});

test("target.auth step goto must be same-origin", () => {
  const cfg = { target: { url: "http://localhost:3000", auth: { roles: [{ name: "m", loginUrl: "/l", steps: [{ action: "goto", url: "http://evil.example/x" }] }] } } };
  assertConfigError(() => loadConfig(writeConfig(tmpDir(), cfg)), /same-origin/);
});

// ---------------------------------------------------------------------------
// target.journeys
// ---------------------------------------------------------------------------
test("target.journeys defaults to an empty array", () => {
  const config = inDir(tmpDir(), () => loadConfig());
  assert.deepEqual(config.target.journeys, []);
});

test("target.journeys accepts a valid journey with expects", () => {
  const journeys = [
    {
      name: "view account",
      steps: [
        { action: "goto", url: "/account" },
        { action: "click", selector: "#refresh", expect: { textPresent: "Signed in", selector: "#who" } },
        { action: "fill", selector: "#note", value: "hi", expect: { urlIncludes: "/account" } },
      ],
    },
  ];
  const config = loadConfig(writeConfig(tmpDir(), { target: { journeys } }));
  assert.equal(config.target.journeys[0].steps.length, 3);
});

test("target.journeys rejects unknown step actions and empty steps", () => {
  assertConfigError(
    () => loadConfig(writeConfig(tmpDir(), { target: { journeys: [{ name: "x", steps: [] }] } })),
    /non-empty array/,
  );
  assertConfigError(
    () => loadConfig(writeConfig(tmpDir(), { target: { journeys: [{ name: "x", steps: [{ action: "teleport", selector: "#a" }] }] } })),
    /action must be one of/,
  );
});

test("target.journeys roles scope must name anonymous or a declared auth role", () => {
  const role = { name: "member", loginUrl: "/l", steps: [{ action: "click", selector: "#x" }] };
  const base = { target: { auth: { roles: [role] } } };
  // "anonymous" and a declared role are accepted.
  const ok = loadConfig(writeConfig(tmpDir(), {
    target: { ...base.target, journeys: [{ name: "j", roles: ["anonymous", "member"], steps: [{ action: "goto", url: "/" }] }] },
  }));
  assert.deepEqual(ok.target.journeys[0].roles, ["anonymous", "member"]);
  // An undeclared role name is rejected.
  assertConfigError(
    () => loadConfig(writeConfig(tmpDir(), {
      target: { ...base.target, journeys: [{ name: "j", roles: ["admin"], steps: [{ action: "goto", url: "/" }] }] },
    })),
    /not "anonymous" or a declared target\.auth role/,
  );
  // An empty roles array is rejected (scopes the journey to nothing).
  assertConfigError(
    () => loadConfig(writeConfig(tmpDir(), {
      target: { ...base.target, journeys: [{ name: "j", roles: [], steps: [{ action: "goto", url: "/" }] }] },
    })),
    /non-empty array of role names/,
  );
});

test("target.journeys expect must assert at least one thing and reject unknown keys", () => {
  assertConfigError(
    () => loadConfig(writeConfig(tmpDir(), { target: { journeys: [{ name: "x", steps: [{ action: "goto", url: "/", expect: {} }] }] } })),
    /at least one of/,
  );
  assertConfigError(
    () => loadConfig(writeConfig(tmpDir(), { target: { journeys: [{ name: "x", steps: [{ action: "goto", url: "/", expect: { nope: "1" } }] }] } })),
    /unknown key/,
  );
});
