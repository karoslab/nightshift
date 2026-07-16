// tests/auth.test.mjs — lib/auth.mjs: TOTP, credential resolution, and real
// role login against the bundled demo-app login/gated-route fixtures.
// Hermetic: localhost demo-app on port 0, no external network.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { totp, resolveRoleCredentials, storageStateIsEmpty, loginRole, establishRoleSessions, AuthError } from "../lib/auth.mjs";
import { startBugbox, DEMO_CREDENTIALS } from "../demo-app/server.mjs";

// RFC 6238 Appendix B reference vectors (SHA1, 30s step). The secret is the
// ASCII string "12345678901234567890" base32-encoded — an INDEPENDENT source
// of truth, not a value recomputed the way the code computes it.
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

test("totp matches the RFC 6238 SHA1 reference vectors (6 digits)", () => {
  assert.equal(totp(RFC_SECRET, { time: 59_000 }), "287082");
  assert.equal(totp(RFC_SECRET, { time: 1_111_111_109_000 }), "081804");
  assert.equal(totp(RFC_SECRET, { time: 1_111_111_111_000 }), "050471");
  assert.equal(totp(RFC_SECRET, { time: 2_000_000_000_000 }), "279037");
});

test("totp rejects a non-base32 secret", () => {
  assert.throws(() => totp("not base32!!", { time: 0 }), AuthError);
});

test("resolveRoleCredentials reads values from env by NAME and reports missing vars", () => {
  const role = { name: "m", usernameEnv: "NS_U", passwordEnv: "NS_P", totpSecretEnv: "NS_T" };
  const creds = resolveRoleCredentials(role, { NS_U: "alice", NS_P: "s3cret", NS_T: RFC_SECRET });
  assert.deepEqual(creds, { username: "alice", password: "s3cret", totpSecret: RFC_SECRET });
  assert.throws(() => resolveRoleCredentials(role, { NS_U: "alice", NS_P: "s3cret" }), (e) => {
    assert.ok(e instanceof AuthError);
    assert.match(e.message, /NS_T/);
    assert.ok(!e.message.includes("s3cret"), "error must never contain a secret value");
    return true;
  });
});

test("storageStateIsEmpty distinguishes an anonymous state from an authenticated one", () => {
  assert.equal(storageStateIsEmpty(null), true);
  assert.equal(storageStateIsEmpty({ cookies: [], origins: [] }), true);
  assert.equal(storageStateIsEmpty({ cookies: [{ name: "s", value: "1" }], origins: [] }), false);
  assert.equal(
    storageStateIsEmpty({ cookies: [], origins: [{ origin: "http://x", localStorage: [{ name: "t", value: "1" }] }] }),
    false,
  );
});

let bugbox;
let origin;
let browser;

before(async () => {
  bugbox = await startBugbox(0);
  origin = `http://127.0.0.1:${bugbox.port}`;
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  await bugbox?.close();
});

const memberRole = {
  name: "member",
  loginUrl: "/login",
  usernameEnv: "NS_DEMO_USER",
  passwordEnv: "NS_DEMO_PASS",
  steps: [
    { action: "fill", selector: "#username", valueFrom: "username" },
    { action: "fill", selector: "#password", valueFrom: "password" },
    { action: "click", selector: "#login" },
  ],
};
const env = { NS_DEMO_USER: DEMO_CREDENTIALS.username, NS_DEMO_PASS: DEMO_CREDENTIALS.password };

test("role login succeeds and its storageState reaches the gated route", { timeout: 60_000 }, async () => {
  const { storageState } = await loginRole({ browser, role: memberRole, origin, env });
  assert.equal(storageStateIsEmpty(storageState), false, "authenticated login must yield a non-empty storageState");

  // A fresh context seeded with the role's storageState reaches /account (200).
  const authed = await browser.newContext({ storageState });
  try {
    const page = await authed.newPage();
    const res = await page.goto(`${origin}/account`, { waitUntil: "domcontentloaded" });
    assert.equal(res.status(), 200, "gated /account must be reachable for the authenticated role");
    assert.match(await page.locator("#who").innerText(), /Signed in/);
  } finally {
    await authed.close();
  }
});

test("anonymous is redirected away from the gated route, not crashed", { timeout: 60_000 }, async () => {
  const anon = await browser.newContext();
  try {
    const page = await anon.newPage();
    const res = await page.goto(`${origin}/account`, { waitUntil: "domcontentloaded" });
    assert.equal(res.status(), 200, "the redirect must land on a real page, not an error");
    assert.equal(new URL(page.url()).pathname, "/login", "anonymous /account must redirect to /login");
  } finally {
    await anon.close();
  }
});

test("wrong credentials produce an empty storageState (login did not establish a session)", { timeout: 60_000 }, async () => {
  const { storageState } = await loginRole({
    browser,
    role: memberRole,
    origin,
    env: { NS_DEMO_USER: "demo", NS_DEMO_PASS: "wrong-password" },
  });
  assert.equal(storageStateIsEmpty(storageState), true);
});

test("establishRoleSessions writes one storageState file per role under the run dir", { timeout: 60_000 }, async (t) => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ns-auth-"));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const config = { target: { url: origin, auth: { roles: [memberRole] } }, reverify: { navTimeoutMs: 15000 } };
  const sessions = await establishRoleSessions({ config, browser, runDir, env });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].name, "member");
  assert.ok(fs.existsSync(sessions[0].statePath), "storageState file must be written");
  const onDisk = JSON.parse(fs.readFileSync(sessions[0].statePath, "utf8"));
  assert.equal(storageStateIsEmpty(onDisk), false);
  // The persisted state must never contain the plaintext password.
  assert.ok(!JSON.stringify(onDisk).includes(DEMO_CREDENTIALS.password), "storageState must not embed the password");
});

test("establishRoleSessions returns [] when no auth is configured", async (t) => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ns-auth-"));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const config = { target: { url: origin, auth: { roles: [] } } };
  assert.deepEqual(await establishRoleSessions({ config, browser, runDir, env }), []);
});
