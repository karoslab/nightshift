// tests/doctor.test.mjs — lib/doctor.mjs + the doctor/init CLI surface.
// Hermetic: stubbed claude CLI (a local shell script), localhost-only servers
// on ephemeral ports, stubbed chromium launch. Never the real claude CLI.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runDoctor } from "../lib/doctor.mjs";

const BIN = fileURLToPath(new URL("../bin/nightshift.mjs", import.meta.url));

const stubChromium = async () => ({ close: async () => {} });

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ns-doctor-"));
}

function writeConfig(dir, obj) {
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify(obj));
  return file;
}

// A fake claude CLI: prints a version banner and exits 0.
function fakeCli(dir) {
  const file = path.join(dir, "fake-claude");
  fs.writeFileSync(file, "#!/bin/sh\necho fake-claude 9.9.9\n");
  fs.chmodSync(file, 0o755);
  return file;
}

function listenEphemeral() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => res.end("ok"));
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// A port that had a listener and no longer does — reliably unreachable.
async function closedPort() {
  const server = await listenEphemeral();
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function check(checks, name) {
  return checks.find((c) => c.name === name);
}

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

test("doctor passes: reachable target + stubbed cli in subscription-cli mode", async () => {
  const server = await listenEphemeral();
  try {
    const dir = tmpDir();
    const cli = fakeCli(dir);
    const configPath = writeConfig(dir, {
      target: { url: `http://127.0.0.1:${server.address().port}` },
      brain: { mode: "subscription-cli", cliPath: cli },
    });
    const { ok, checks } = await runDoctor({ configPath, env: {}, launchChromium: stubChromium });
    assert.equal(ok, true, JSON.stringify(checks, null, 2));
    assert.equal(check(checks, "target").status, "ok");
    assert.equal(check(checks, "brain").status, "ok");
    assert.match(check(checks, "brain").message, /fake-claude 9\.9\.9/);
    assert.match(check(checks, "posture").message, /uses YOUR login via the official claude CLI/);
    assert.match(check(checks, "posture").message, /never touches credentials/);
    assert.equal(check(checks, "env"), undefined); // no ANTHROPIC_API_KEY exported
    assert.equal(check(checks, "playwright").status, "ok");
  } finally {
    server.close();
  }
});

test("doctor fails when the target is unreachable", async () => {
  const dir = tmpDir();
  const configPath = writeConfig(dir, {
    target: { url: `http://127.0.0.1:${await closedPort()}` },
    brain: { mode: "mock" },
  });
  const { ok, checks } = await runDoctor({ configPath, env: {}, launchChromium: stubChromium });
  assert.equal(ok, false);
  assert.equal(check(checks, "target").status, "fail");
  assert.match(check(checks, "target").message, /unreachable/);
});

test("doctor warns (does not fail) when ANTHROPIC_API_KEY is exported in subscription-cli mode", async () => {
  const server = await listenEphemeral();
  try {
    const dir = tmpDir();
    const configPath = writeConfig(dir, {
      target: { url: `http://127.0.0.1:${server.address().port}` },
      brain: { mode: "subscription-cli", cliPath: fakeCli(dir) },
    });
    const secret = "sk-ant-test-should-never-print";
    const { ok, checks } = await runDoctor({
      configPath,
      env: { ANTHROPIC_API_KEY: secret },
      launchChromium: stubChromium,
    });
    assert.equal(ok, true); // a warning never fails the doctor
    const warn = check(checks, "env");
    assert.equal(warn.status, "warn");
    assert.match(warn.message, /stripped from the CLI subprocess/);
    assert.match(warn.message, /api-key/);
    for (const c of checks) assert.ok(!c.message.includes(secret), `secret leaked in check "${c.name}"`);
  } finally {
    server.close();
  }
});

test("doctor warns about base-URL / Bedrock / Vertex routing overrides in subscription-cli mode", async () => {
  // These reroute every turn away from the buyer's subscription just as an
  // exported API key would flip billing — the doctor must surface them all.
  const server = await listenEphemeral();
  try {
    const dir = tmpDir();
    const configPath = writeConfig(dir, {
      target: { url: `http://127.0.0.1:${server.address().port}` },
      brain: { mode: "subscription-cli", cliPath: fakeCli(dir) },
    });
    const { ok, checks } = await runDoctor({
      configPath,
      env: { ANTHROPIC_BASE_URL: "https://corp-llm-proxy.example.com", CLAUDE_CODE_USE_BEDROCK: "1" },
      launchChromium: stubChromium,
    });
    assert.equal(ok, true); // a warning never fails the doctor
    const warn = check(checks, "env");
    assert.equal(warn.status, "warn");
    assert.match(warn.message, /ANTHROPIC_BASE_URL/);
    assert.match(warn.message, /CLAUDE_CODE_USE_BEDROCK/);
    assert.match(warn.message, /stripped from the CLI subprocess/);
  } finally {
    server.close();
  }
});

test("doctor api-key mode: fails without the env var, passes with it, never prints it", async () => {
  const server = await listenEphemeral();
  try {
    const dir = tmpDir();
    const configPath = writeConfig(dir, {
      target: { url: `http://127.0.0.1:${server.address().port}` },
      brain: { mode: "api-key", apiKeyEnv: "MY_TEST_KEY" },
    });

    const missing = await runDoctor({ configPath, env: {}, launchChromium: stubChromium });
    assert.equal(missing.ok, false);
    assert.equal(check(missing.checks, "brain").status, "fail");
    assert.match(check(missing.checks, "brain").message, /MY_TEST_KEY is not set/);

    const secret = "sk-secret-123456";
    const present = await runDoctor({ configPath, env: { MY_TEST_KEY: secret }, launchChromium: stubChromium });
    assert.equal(present.ok, true, JSON.stringify(present.checks, null, 2));
    assert.equal(check(present.checks, "brain").status, "ok");
    for (const c of present.checks) assert.ok(!c.message.includes(secret), `secret leaked in check "${c.name}"`);
  } finally {
    server.close();
  }
});

test("doctor stops at the config check when the config is invalid", async () => {
  const configPath = writeConfig(tmpDir(), { brain: { mode: "nope" } });
  const { ok, checks } = await runDoctor({ configPath, env: {}, launchChromium: stubChromium });
  assert.equal(ok, false);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].name, "config");
  assert.equal(checks[0].status, "fail");
  assert.match(checks[0].message, /brain\.mode/);
});

test("doctor fails when the cli cannot run --version", async () => {
  const server = await listenEphemeral();
  try {
    const dir = tmpDir();
    const broken = path.join(dir, "broken-claude");
    fs.writeFileSync(broken, "#!/bin/sh\nexit 7\n");
    fs.chmodSync(broken, 0o755);
    const configPath = writeConfig(dir, {
      target: { url: `http://127.0.0.1:${server.address().port}` },
      brain: { mode: "subscription-cli", cliPath: broken },
    });
    const { ok, checks } = await runDoctor({ configPath, env: {}, launchChromium: stubChromium });
    assert.equal(ok, false);
    assert.equal(check(checks, "brain").status, "fail");
    assert.match(check(checks, "brain").message, /--version/);
  } finally {
    server.close();
  }
});

test("doctor fails when chromium cannot launch", async () => {
  const server = await listenEphemeral();
  try {
    const dir = tmpDir();
    const configPath = writeConfig(dir, {
      target: { url: `http://127.0.0.1:${server.address().port}` },
      brain: { mode: "mock" },
    });
    const { ok, checks } = await runDoctor({
      configPath,
      env: {},
      launchChromium: async () => {
        throw new Error("no chromium here");
      },
    });
    assert.equal(ok, false);
    assert.equal(check(checks, "playwright").status, "fail");
    assert.match(check(checks, "playwright").message, /playwright install/);
  } finally {
    server.close();
  }
});

// --- CLI surface (spawns bin/nightshift.mjs; touches only my own modules) ---

test("cli: doctor exits 1 on an invalid config (stops before any browser work)", async () => {
  const configPath = writeConfig(tmpDir(), { brain: { mode: "banana" } });
  const res = await run(process.execPath, [BIN, "doctor", "--config", configPath]);
  assert.equal(res.code, 1, res.stdout + res.stderr);
  assert.match(res.stdout, /\[fail\] config:/);
  assert.match(res.stdout, /doctor: FAILED/);
});

test("cli: init writes the example config and refuses to overwrite", async () => {
  const dir = tmpDir();
  const first = await run(process.execPath, [BIN, "init"], { cwd: dir });
  assert.equal(first.code, 0, first.stdout + first.stderr);
  const written = JSON.parse(fs.readFileSync(path.join(dir, "nightshift.config.json"), "utf8"));
  assert.equal(written.target.url, "http://localhost:3000");
  assert.equal(written.brain.mode, "subscription-cli");

  const second = await run(process.execPath, [BIN, "init"], { cwd: dir });
  assert.equal(second.code, 1);
  assert.match(second.stderr, /already exists/);
});

test("cli: unknown command exits 1 with usage", async () => {
  const res = await run(process.execPath, [BIN, "bogus"]);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /unknown command: bogus/);
  assert.match(res.stderr, /usage: nightshift/);
});
