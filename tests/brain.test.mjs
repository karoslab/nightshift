// tests/brain.test.mjs — brain drivers. The claude-cli driver is exercised
// against tests/fixtures/fake-claude.mjs (NEVER the real CLI); the api-key
// driver against an injected fetch stub. Hermetic: no network, no real claude.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBrain } from "../lib/brain/index.mjs";
import { createMockBrain } from "../lib/brain/mock.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = path.join(here, "fixtures", "fake-claude.mjs");
const REPO_ROOT = path.resolve(here, "..");

before(() => {
  fs.chmodSync(FAKE_CLI, 0o755); // shebang script must be executable to spawn
});

function cliConfig() {
  return { brain: { mode: "subscription-cli", model: "sonnet", cliPath: FAKE_CLI } };
}

// Set env vars for the duration of fn, then restore (node:test runs tests in
// this file sequentially, so mutation is safe).
async function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function makeSidecar() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ns-test-"));
  return { file: path.join(dir, "sidecar.json"), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------- claude-cli

test("claude-cli: happy path parses CLI JSON and enforces isolation", async () => {
  const { file: sidecarFile, cleanup } = makeSidecar();
  try {
    await withEnv(
      {
        FAKE_CLAUDE_SIDECAR: sidecarFile,
        FAKE_CLAUDE_MODE: undefined,
        FAKE_CLAUDE_REPLY: undefined,
        ANTHROPIC_API_KEY: "sk-should-be-stripped",
        ANTHROPIC_AUTH_TOKEN: "tok-should-be-stripped",
      },
      async () => {
        const brain = createBrain(cliConfig());
        assert.equal(brain.mode, "subscription-cli");
        assert.equal(brain.model, "sonnet");

        const res = await brain.ask({ system: "SYSTEM PROMPT", user: "USER TURN" });
        assert.equal(res.ok, true);
        assert.equal(res.json.action.kind, "click");
        assert.equal(res.json.done, false);
        assert.equal(res.usage.inputTokens, 100);
        assert.equal(res.usage.outputTokens, 42);
        assert.equal(res.usage.costUsd, 0.0123);
        assert.ok(res.usage.durationMs >= 0);

        const sidecar = JSON.parse(fs.readFileSync(sidecarFile, "utf8"));

        // (a) cwd is a fresh nightshift- temp dir under os.tmpdir(), not the repo.
        const tmpReal = fs.realpathSync(os.tmpdir());
        assert.ok(
          sidecar.cwd.startsWith(tmpReal) || sidecar.cwd.startsWith(os.tmpdir()),
          `cwd ${sidecar.cwd} not under tmpdir`,
        );
        assert.ok(path.basename(sidecar.cwd).startsWith("nightshift-"));
        assert.ok(!sidecar.cwd.startsWith(REPO_ROOT), "cwd must not be inside the repo");

        // (b) billing vars stripped from the child env.
        assert.equal(sidecar.hasApiKey, false);
        assert.equal(sidecar.hasAuthToken, false);

        // (c) pinned argv.
        const argv = sidecar.argv;
        const after = (flag) => argv[argv.indexOf(flag) + 1];
        assert.equal(after("-p"), "USER TURN");
        assert.equal(after("--output-format"), "json");
        assert.equal(after("--model"), "sonnet");
        assert.equal(after("--append-system-prompt"), "SYSTEM PROMPT");
        assert.ok(argv.includes("--strict-mcp-config"));
        assert.equal(after("--setting-sources"), "project");
        assert.match(after("--disallowedTools"), /Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,Task,Read,Grep,Glob/);

        // Temp dir is removed on close.
        await brain.close();
        assert.equal(fs.existsSync(sidecar.cwd), false);
      },
    );
  } finally {
    cleanup();
  }
});

test("claude-cli: EVERY billing/routing override is stripped from the child env (base-URL/Bedrock/Vertex included)", async () => {
  // An inherited ANTHROPIC_BASE_URL or CLAUDE_CODE_USE_BEDROCK would silently
  // reroute every subscription-mode turn to a proxy / cloud account — the
  // billing-surprise and phone-home outcomes the compliance box rules out.
  const { file: sidecarFile, cleanup } = makeSidecar();
  try {
    await withEnv(
      {
        FAKE_CLAUDE_SIDECAR: sidecarFile,
        FAKE_CLAUDE_MODE: undefined,
        FAKE_CLAUDE_REPLY: undefined,
        ANTHROPIC_API_KEY: "sk-should-be-stripped",
        ANTHROPIC_AUTH_TOKEN: "tok-should-be-stripped",
        ANTHROPIC_BASE_URL: "https://corp-llm-proxy.example.com",
        ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.example.com",
        ANTHROPIC_VERTEX_BASE_URL: "https://vertex.example.com",
        ANTHROPIC_CUSTOM_HEADERS: "x-corp: yes",
        CLAUDE_CODE_USE_BEDROCK: "1",
        CLAUDE_CODE_USE_VERTEX: "1",
      },
      async () => {
        const brain = createBrain(cliConfig());
        const res = await brain.ask({ system: "S", user: "U" });
        assert.equal(res.ok, true);
        const sidecar = JSON.parse(fs.readFileSync(sidecarFile, "utf8"));
        assert.deepEqual(
          sidecar.presentBillingVars,
          [],
          `billing/routing vars leaked into the CLI child env: ${JSON.stringify(sidecar.presentBillingVars)}`,
        );
        await brain.close();
      },
    );
  } finally {
    cleanup();
  }
});

test("claude-cli: temp cwd is created once per brain and reused", async () => {
  const { file: sidecarFile, cleanup } = makeSidecar();
  try {
    await withEnv({ FAKE_CLAUDE_SIDECAR: sidecarFile, FAKE_CLAUDE_MODE: undefined }, async () => {
      const brain = createBrain(cliConfig());
      await brain.ask({ system: "s", user: "u" });
      const first = JSON.parse(fs.readFileSync(sidecarFile, "utf8")).cwd;
      await brain.ask({ system: "s", user: "u" });
      const second = JSON.parse(fs.readFileSync(sidecarFile, "utf8")).cwd;
      assert.equal(first, second);
      await brain.close();
    });
  } finally {
    cleanup();
  }
});

test("claude-cli: non-zero exit with is_error JSON yields ok:false and the message in rawText", async () => {
  await withEnv({ FAKE_CLAUDE_MODE: "error-json", FAKE_CLAUDE_SIDECAR: undefined }, async () => {
    const brain = createBrain(cliConfig());
    const res = await brain.ask({ system: "s", user: "u" });
    assert.equal(res.ok, false);
    assert.equal(res.json, null);
    assert.match(res.rawText, /rate limit exceeded/);
    assert.equal(res.usage.inputTokens, 12); // usage still parsed from the error result
    await brain.close();
  });
});

test("claude-cli: garbage stdout yields ok:false, never rejects", async () => {
  await withEnv({ FAKE_CLAUDE_MODE: "garbage", FAKE_CLAUDE_SIDECAR: undefined }, async () => {
    const brain = createBrain(cliConfig());
    const res = await brain.ask({ system: "s", user: "u" });
    assert.equal(res.ok, false);
    assert.equal(res.json, null);
    assert.match(res.rawText, /unparseable/);
    assert.deepEqual(
      { inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, costUsd: res.usage.costUsd },
      { inputTokens: 0, outputTokens: 0, costUsd: null },
    );
    await brain.close();
  });
});

test("claude-cli: reply text without any JSON yields ok:false with rawText preserved", async () => {
  await withEnv(
    { FAKE_CLAUDE_MODE: undefined, FAKE_CLAUDE_REPLY: "just prose, no json here", FAKE_CLAUDE_SIDECAR: undefined },
    async () => {
      const brain = createBrain(cliConfig());
      const res = await brain.ask({ system: "s", user: "u" });
      assert.equal(res.ok, false);
      assert.equal(res.json, null);
      assert.equal(res.rawText, "just prose, no json here");
      assert.equal(res.usage.inputTokens, 100); // CLI call itself succeeded; tokens were spent
      await brain.close();
    },
  );
});

test("claude-cli: spawn failure resolves ok:false (never rejects)", async () => {
  const config = {
    brain: { mode: "subscription-cli", model: "sonnet", cliPath: "/nonexistent/claude-xyz-9911" },
  };
  const brain = createBrain(config);
  const res = await brain.ask({ system: "s", user: "u" });
  assert.equal(res.ok, false);
  assert.equal(res.json, null);
  assert.match(res.rawText, /spawn failed|ENOENT/i);
  await brain.close();
});

test("claude-cli: inactivity timeout kills the child and resolves ok:false", async () => {
  await withEnv({ FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_SIDECAR: undefined }, async () => {
    const brain = createBrain(cliConfig(), { inactivityMs: 400 });
    const started = Date.now();
    const res = await brain.ask({ system: "s", user: "u" });
    assert.equal(res.ok, false);
    assert.equal(res.json, null);
    assert.match(res.rawText, /inactivity/);
    assert.ok(Date.now() - started < 10_000, "kill happened promptly");
    await brain.close();
  });
});

// ------------------------------------------------------------------- api-key

function apiConfig() {
  return {
    brain: {
      mode: "api-key",
      apiKeyEnv: "NS_TEST_ANTHROPIC_KEY",
      apiModel: "claude-sonnet-5",
      maxOutputTokens: 555,
    },
  };
}

test("api-key: posts the pinned request shape and parses usage", async () => {
  const calls = [];
  const stubFetch = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          content: [{ type: "text", text: 'Result:\n```json\n{"done": true}\n```' }],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
    };
  };

  await withEnv({ NS_TEST_ANTHROPIC_KEY: "sk-test-123" }, async () => {
    const brain = createBrain(apiConfig(), { fetch: stubFetch });
    assert.equal(brain.mode, "api-key");
    assert.equal(brain.model, "claude-sonnet-5");

    const res = await brain.ask({ system: "SYS", user: "USER" });
    assert.equal(res.ok, true);
    assert.deepEqual(res.json, { done: true });
    assert.equal(res.usage.inputTokens, 10);
    assert.equal(res.usage.outputTokens, 5);
    assert.equal(res.usage.costUsd, null);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
    assert.equal(calls[0].opts.method, "POST");
    assert.equal(calls[0].opts.headers["x-api-key"], "sk-test-123");
    assert.equal(calls[0].opts.headers["anthropic-version"], "2023-06-01");
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.model, "claude-sonnet-5");
    assert.equal(body.max_tokens, 555);
    assert.equal(body.system, "SYS");
    assert.deepEqual(body.messages, [{ role: "user", content: "USER" }]);
    await brain.close();
  });
});

test("api-key: non-2xx response yields ok:false with status detail", async () => {
  const stubFetch = async () => ({
    ok: false,
    status: 429,
    text: async () => '{"type":"error","error":{"type":"rate_limit_error"}}',
  });
  await withEnv({ NS_TEST_ANTHROPIC_KEY: "sk-test-123" }, async () => {
    const brain = createBrain(apiConfig(), { fetch: stubFetch });
    const res = await brain.ask({ system: "s", user: "u" });
    assert.equal(res.ok, false);
    assert.equal(res.json, null);
    assert.match(res.rawText, /429/);
    assert.equal(res.usage.inputTokens, 0);
    await brain.close();
  });
});

test("api-key: fetch rejection resolves ok:false (never rejects)", async () => {
  const stubFetch = async () => {
    throw new Error("ECONNREFUSED test");
  };
  await withEnv({ NS_TEST_ANTHROPIC_KEY: "sk-test-123" }, async () => {
    const brain = createBrain(apiConfig(), { fetch: stubFetch });
    const res = await brain.ask({ system: "s", user: "u" });
    assert.equal(res.ok, false);
    assert.match(res.rawText, /ECONNREFUSED test/);
    await brain.close();
  });
});

test("api-key: missing env key yields ok:false without calling fetch or leaking anything", async () => {
  let called = false;
  const stubFetch = async () => {
    called = true;
    return { ok: true, status: 200, text: async () => "{}" };
  };
  await withEnv({ NS_TEST_ANTHROPIC_KEY: undefined }, async () => {
    const brain = createBrain(apiConfig(), { fetch: stubFetch });
    const res = await brain.ask({ system: "s", user: "u" });
    assert.equal(res.ok, false);
    assert.match(res.rawText, /NS_TEST_ANTHROPIC_KEY/);
    assert.equal(called, false);
    await brain.close();
  });
});

test("api-key: unparseable success body yields ok:false", async () => {
  const stubFetch = async () => ({ ok: true, status: 200, text: async () => "not json" });
  await withEnv({ NS_TEST_ANTHROPIC_KEY: "sk-test-123" }, async () => {
    const brain = createBrain(apiConfig(), { fetch: stubFetch });
    const res = await brain.ask({ system: "s", user: "u" });
    assert.equal(res.ok, false);
    assert.match(res.rawText, /unparseable/);
    await brain.close();
  });
});

test("api-key: circuit breaker trips after repeated errors and skips fetch entirely", async () => {
  let calls = 0;
  const stubFetch = async () => {
    calls += 1;
    return { ok: false, status: 500, text: async () => "boom" };
  };
  await withEnv({ NS_TEST_ANTHROPIC_KEY: "sk-test-123" }, async () => {
    const brain = createBrain(apiConfig(), { fetch: stubFetch });
    // Default minSamples is 10 — drive 10 failures to trip the breaker.
    for (let i = 0; i < 10; i++) await brain.ask({ system: "s", user: "u" });
    assert.equal(calls, 10);

    const tripped = await brain.ask({ system: "s", user: "u" });
    assert.equal(tripped.ok, false);
    assert.match(tripped.rawText, /circuit breaker/i);
    assert.equal(calls, 10); // fetch was NOT called this time
    await brain.close();
  });
});

test("api-key: circuit breaker half-opens after cooldown and recovers on success", async () => {
  let mode = "fail";
  let calls = 0;
  const stubFetch = async () => {
    calls += 1;
    if (mode === "fail") return { ok: false, status: 500, text: async () => "boom" };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ content: [{ type: "text", text: '{"done":true}' }], usage: {} }),
    };
  };
  let now = 0;
  const clock = () => now;
  await withEnv({ NS_TEST_ANTHROPIC_KEY: "sk-test-123" }, async () => {
    const brain = createBrain(apiConfig(), { fetch: stubFetch, clock });
    for (let i = 0; i < 10; i++) await brain.ask({ system: "s", user: "u" });
    const tripped = await brain.ask({ system: "s", user: "u" });
    assert.equal(tripped.ok, false);
    assert.equal(calls, 10); // breaker skipped the 11th call

    mode = "success";
    now += 30_000; // advance past the cooldown
    const recovered = await brain.ask({ system: "s", user: "u" });
    assert.equal(recovered.ok, true); // half-open probe succeeded
    assert.equal(calls, 11);
    await brain.close();
  });
});

// ---------------------------------------------------------------------- mock

test("mock brain: pops scripted replies in order, then returns {done:true}", async () => {
  const brain = createMockBrain([
    { action: { kind: "click", elementId: 1, why: "first" }, findings: [], done: false },
    '{"action": {"kind": "back", "why": "second"}, "findings": [], "done": false}',
  ]);
  assert.equal(brain.mode, "mock");

  const first = await brain.ask({ system: "s", user: "u" });
  assert.equal(first.ok, true);
  assert.equal(first.json.action.why, "first");

  const second = await brain.ask({ system: "s", user: "u" });
  assert.equal(second.ok, true);
  assert.equal(second.json.action.kind, "back");

  const exhausted = await brain.ask({ system: "s", user: "u" });
  assert.deepEqual(exhausted.json, { done: true });
  assert.equal(exhausted.ok, true);
  assert.deepEqual(exhausted.usage, { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 });
  await brain.close();
});

test("mock brain: exhausted immediately when script is empty", async () => {
  const brain = createMockBrain();
  const res = await brain.ask({ system: "s", user: "u" });
  assert.deepEqual(res.json, { done: true });
});

// ---------------------------------------------------------------- dispatcher

test("createBrain: dispatches mock mode with a deps-supplied script", async () => {
  const brain = createBrain({ brain: { mode: "mock" } }, { script: [{ done: true, findings: [] }] });
  assert.equal(brain.mode, "mock");
  const res = await brain.ask({ system: "s", user: "u" });
  assert.deepEqual(res.json, { done: true, findings: [] });
});

test("createBrain: unknown mode throws", () => {
  assert.throws(() => createBrain({ brain: { mode: "quantum" } }), /Unknown brain\.mode/);
});
