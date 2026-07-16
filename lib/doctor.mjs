// lib/doctor.mjs — environment checks for `nightshift doctor`.
// All effectful dependencies (env, fetch, execFile, chromium launch) are
// injectable so tests stay hermetic: no real claude CLI, no external network.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig } from "./config.mjs";
import { STRIPPED_BILLING_ENV_VARS } from "./brain/claude-cli.mjs";
import { loginRole as defaultLoginRole, storageStateIsEmpty } from "./auth.mjs";

const execFileP = promisify(execFileCb);

function defaultExecFile(cmd, args) {
  return execFileP(cmd, args, { timeout: 10_000 });
}

async function defaultLaunchChromium() {
  const { chromium } = await import("playwright");
  return chromium.launch({ headless: true });
}

// config.brain.cliPath → `claude` on PATH → ~/.local/bin/claude. Never reads
// anything under ~/.claude/.
function resolveCliPath(config, env) {
  if (config.brain.cliPath) return config.brain.cliPath;
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "claude");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // not here; keep scanning
    }
  }
  const fallback = path.join(os.homedir(), ".local", "bin", "claude");
  try {
    fs.accessSync(fallback, fs.constants.X_OK);
    return fallback;
  } catch {
    return null;
  }
}

function configMessage(configPath) {
  if (configPath) return `parsed ${path.resolve(configPath)}`;
  if (fs.existsSync(path.resolve("nightshift.config.json"))) {
    return `parsed ${path.resolve("nightshift.config.json")}`;
  }
  return "no nightshift.config.json found — using built-in defaults (run `nightshift init`)";
}

// -> { ok, checks: [{ name, status: "ok"|"warn"|"fail", message }] }
// Warnings never fail the doctor; any "fail" makes ok false (CLI exits 1).
export async function runDoctor(options = {}) {
  const {
    configPath,
    env = process.env,
    fetchImpl = fetch,
    execFileImpl = defaultExecFile,
    launchChromium = defaultLaunchChromium,
    loginRoleImpl = defaultLoginRole,
  } = options;

  const checks = [];
  const add = (name, status, message) => checks.push({ name, status, message });
  const finish = () => ({ ok: checks.every((c) => c.status !== "fail"), checks });

  let config;
  try {
    config = loadConfig(configPath);
    add("config", "ok", configMessage(configPath));
  } catch (e) {
    add("config", "fail", e.message);
    return finish(); // everything below depends on a valid config
  }

  try {
    const res = await fetchImpl(config.target.url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    add("target", "ok", `${config.target.url} responded (status ${res.status})`);
  } catch (e) {
    const detail = e?.cause?.message ?? e?.message ?? String(e);
    add(
      "target",
      "fail",
      `${config.target.url} is unreachable: ${detail}. Start your app (or fix target.url) before running NightShift.`
    );
  }

  const mode = config.brain.mode;
  if (mode === "subscription-cli") {
    const cli = resolveCliPath(config, env);
    if (!cli) {
      add(
        "brain",
        "fail",
        "claude CLI not found (checked brain.cliPath, PATH, ~/.local/bin/claude). Install the official Claude CLI or set brain.cliPath."
      );
    } else {
      try {
        const { stdout } = await execFileImpl(cli, ["--version"]);
        add("brain", "ok", `claude CLI at ${cli} (${String(stdout).trim()})`);
      } catch (e) {
        add("brain", "fail", `claude CLI at ${cli} failed to run --version: ${e.message}`);
      }
    }
    add(
      "posture",
      "ok",
      "subscription-cli mode uses YOUR login via the official claude CLI; NightShift never touches credentials."
    );
    // Any billing/routing override (API key, base-URL proxy, Bedrock/Vertex
    // toggles) would change who is billed or where turns are sent — all of
    // them are stripped from the subprocess; surface every one that is set.
    const billingVars = STRIPPED_BILLING_ENV_VARS.filter((name) => env[name]);
    if (billingVars.length > 0) {
      add(
        "env",
        "warn",
        `${billingVars.join(", ")} ${billingVars.length > 1 ? "are" : "is"} exported in your shell. ` +
          "Billing/routing overrides are stripped from the CLI subprocess so your key, proxy, or cloud account is never used; " +
          'set brain.mode to "api-key" if you want metered billing.'
      );
    }
  } else if (mode === "api-key") {
    const envName = config.brain.apiKeyEnv;
    if (env[envName]) {
      add("brain", "ok", `${envName} is set (value is never printed or stored)`);
    } else {
      add(
        "brain",
        "fail",
        `${envName} is not set — export your Anthropic API key as ${envName}, or switch brain.mode to "subscription-cli".`
      );
    }
  } else {
    add("brain", "ok", "mock brain — no credentials needed (demo/test mode)");
  }

  try {
    const browser = await launchChromium();
    await browser.close();
    add("playwright", "ok", "chromium launched and closed");
  } catch (e) {
    add("playwright", "fail", `chromium failed to launch: ${e.message}. Try: npx playwright install chromium`);
  }

  await checkAuth(config, { env, launchChromium, loginRoleImpl, add });

  return finish();
}

// Validates target.auth: every declared credential env var is present, and each
// role actually logs in and yields a non-empty storageState. Skipped entirely
// when no auth is configured (anonymous-only). One browser is launched only if
// at least one role clears the env-var gate.
async function checkAuth(config, { env, launchChromium, loginRoleImpl, add }) {
  const roles = config.target.auth?.roles ?? [];
  if (roles.length === 0) return;
  const origin = new URL(config.target.url).origin;
  const navTimeoutMs = config.reverify?.navTimeoutMs ?? 15000;
  let browser = null;
  try {
    for (const role of roles) {
      const name = `auth:${role.name}`;
      const missing = ["usernameEnv", "passwordEnv", "totpSecretEnv"]
        .map((field) => role[field])
        .filter((varName) => varName && (env[varName] === undefined || env[varName] === ""));
      if (missing.length > 0) {
        add(
          name,
          "fail",
          `environment variable(s) ${missing.join(", ")} are not set — export them before running NightShift ` +
            "(values are read at runtime and never stored in config)."
        );
        continue;
      }
      try {
        if (!browser) browser = await launchChromium();
        const { storageState } = await loginRoleImpl({ browser, role, origin, env, navTimeoutMs });
        if (storageStateIsEmpty(storageState)) {
          add(name, "fail", `login produced an empty storageState — check the credentials and login steps for role "${role.name}".`);
        } else {
          add(name, "ok", `login succeeded (storageState has ${storageState.cookies?.length ?? 0} cookie(s)).`);
        }
      } catch (e) {
        add(name, "fail", `login failed: ${e?.message ?? String(e)}`);
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
