// lib/auth.mjs — first-class role authentication.
// Logs in once per configured role, persists a Playwright storageState per role
// under the run dir, and hands back the state so exploration/journeys can run
// once per role. Anonymous is the implicit default role and is NOT handled here
// (no login, no storageState — a plain fresh context).
//
// SECURITY (load-bearing): credential VALUES are read from process.env at run
// time by the env-var NAMES pinned in config; they are never written to config,
// never logged, and — unlike explorer/journey steps — auth login steps do NOT
// build replayable TraceSteps, so a filled password can never leak into a
// finding, a repro script, or the report. Only role names and cookie COUNTS are
// logged.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const ACTION_TIMEOUT_MS = 5000;
const DEFAULT_NAV_TIMEOUT_MS = 15000;

export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthError";
  }
}

// RFC 6238 TOTP (HMAC-SHA1, 30s step, 6 digits by default) so a role behind
// TOTP MFA can log in unattended. `time` is epoch milliseconds (injectable so
// the generator is testable against the RFC 6238 reference vectors).
export function totp(secret, { time = Date.now(), step = 30, digits = 6 } = {}) {
  const key = base32Decode(secret);
  const counter = Math.floor(time / 1000 / step);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", key).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(bin % 10 ** digits).padStart(digits, "0");
}

// RFC 4648 base32 (uppercase, padding/whitespace tolerated) — TOTP secrets are
// distributed in base32.
function base32Decode(secret) {
  if (typeof secret !== "string" || secret.length === 0) {
    throw new AuthError("TOTP secret must be a non-empty base32 string");
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = secret.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();
  let bits = "";
  for (const c of clean) {
    const val = alphabet.indexOf(c);
    if (val === -1) throw new AuthError("TOTP secret is not valid base32");
    bits += val.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

// Reads the credential VALUES for a role from env by the configured NAMES.
// Throws AuthError naming the missing variable (never its value). Only fields
// the role declares are read.
export function resolveRoleCredentials(role, env = process.env) {
  const out = {};
  for (const [key, field] of [
    ["username", "usernameEnv"],
    ["password", "passwordEnv"],
    ["totpSecret", "totpSecretEnv"],
  ]) {
    const name = role[field];
    if (name === undefined) continue;
    const value = env[name];
    if (value === undefined || value === "") {
      throw new AuthError(`role "${role.name}": environment variable ${name} (${field}) is not set`);
    }
    out[key] = value;
  }
  return out;
}

// True when a storageState carries neither a cookie nor any localStorage — the
// signal doctor uses to decide a login did not actually establish a session.
export function storageStateIsEmpty(state) {
  if (!state || typeof state !== "object") return true;
  const cookies = Array.isArray(state.cookies) ? state.cookies : [];
  const origins = Array.isArray(state.origins) ? state.origins : [];
  const hasStorage = origins.some((o) => Array.isArray(o.localStorage) && o.localStorage.length > 0);
  return cookies.length === 0 && !hasStorage;
}

function resolveStepValue(step, creds) {
  switch (step.valueFrom) {
    case "username":
      return creds.username;
    case "password":
      return creds.password;
    case "totp":
      return totp(creds.totpSecret);
    default:
      return step.value ?? null;
  }
}

async function runAuthStep(page, step, { creds, origin, navTimeoutMs }) {
  const value = resolveStepValue(step, creds);
  switch (step.action) {
    case "goto":
      await page.goto(new URL(step.url, origin).href, { timeout: navTimeoutMs, waitUntil: "domcontentloaded" });
      return;
    case "fill":
      await page.locator(step.selector).fill(value ?? "", { timeout: ACTION_TIMEOUT_MS });
      return;
    case "click":
      await page.locator(step.selector).click({ timeout: ACTION_TIMEOUT_MS });
      return;
    case "press":
      await page.locator(step.selector).press(value ?? "Enter", { timeout: ACTION_TIMEOUT_MS });
      return;
    case "select":
      await page.locator(step.selector).selectOption(value, { timeout: ACTION_TIMEOUT_MS });
      return;
    default:
      throw new AuthError(`unknown login step action "${step.action}"`);
  }
}

// Log a role in in its own fresh context and return { storageState }. The
// context is captured and closed; the caller opens its exploration context from
// the returned storageState. A setupScript role delegates to a user module
// exporting a default async ({page, context, env, origin}) => {}.
export async function loginRole({ browser, role, origin, env = process.env, navTimeoutMs = DEFAULT_NAV_TIMEOUT_MS, log = () => {} }) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    if (role.setupScript) {
      const mod = await import(pathToFileURL(path.resolve(role.setupScript)).href);
      const fn = mod.default ?? mod.login;
      if (typeof fn !== "function") {
        throw new AuthError(`role "${role.name}": setupScript ${role.setupScript} must export a default async function`);
      }
      await fn({ page, context, env, origin });
    } else {
      const creds = resolveRoleCredentials(role, env);
      await page.goto(new URL(role.loginUrl, origin).href, { timeout: navTimeoutMs, waitUntil: "domcontentloaded" });
      for (const step of role.steps) {
        await runAuthStep(page, step, { creds, origin, navTimeoutMs });
      }
      // Let the login round-trip settle (cookie set, redirect committed) so the
      // captured storageState reflects the authenticated session.
      await page.waitForLoadState("networkidle", { timeout: navTimeoutMs }).catch(() => {});
    }
    return { storageState: await context.storageState() };
  } finally {
    await context.close().catch(() => {});
  }
}

function sanitize(name) {
  return String(name).replace(/[^a-z0-9._-]+/gi, "_");
}

// Persist a role's storageState under <runDir>/auth/<role>.json (the pinned
// per-run location) and return the path. One place owns the convention so the
// session and establishRoleSessions never drift.
export function saveRoleState(runDir, roleName, storageState) {
  const authDir = path.join(runDir, "auth");
  fs.mkdirSync(authDir, { recursive: true });
  const statePath = path.join(authDir, `${sanitize(roleName)}.json`);
  fs.writeFileSync(statePath, JSON.stringify(storageState));
  return statePath;
}

// Logs in every configured role, writes each storageState to
// <runDir>/auth/<role>.json, and returns [{ name, storageState, statePath }].
// Returns [] when no auth is configured (anonymous-only). A single role's login
// failure is fatal for that role but does not silently produce an empty state:
// it throws so the session/doctor surfaces it.
export async function establishRoleSessions({ config, browser, runDir, env = process.env, log = () => {} }) {
  const roles = config.target?.auth?.roles ?? [];
  if (roles.length === 0) return [];
  const origin = new URL(config.target.url).origin;
  const navTimeoutMs = config.reverify?.navTimeoutMs ?? DEFAULT_NAV_TIMEOUT_MS;

  const sessions = [];
  for (const role of roles) {
    log("info", `auth: logging in role "${role.name}"`);
    const { storageState } = await loginRole({ browser, role, origin, env, navTimeoutMs, log });
    const statePath = saveRoleState(runDir, role.name, storageState);
    if (storageStateIsEmpty(storageState)) {
      log("warn", `auth: role "${role.name}" produced an empty storageState — login may not have set a session cookie`);
    } else {
      log("info", `auth: role "${role.name}" authenticated (${storageState.cookies?.length ?? 0} cookie(s))`);
    }
    sessions.push({ name: role.name, storageState, statePath });
  }
  return sessions;
}
