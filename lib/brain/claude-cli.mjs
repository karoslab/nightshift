// lib/brain/claude-cli.mjs — subscription mode: spawn the buyer's OWN official
// `claude` CLI in print mode. NightShift never reads, stores, logs, or transmits
// anything under ~/.claude/ — the CLI owns its own login.
//
// Isolation (load-bearing, see DESIGN.md):
//   1. cwd = fresh empty temp dir under os.tmpdir() (never inside a repo, so the
//      buyer's CLAUDE.md / project settings / hooks can never load or execute).
//   2. --setting-sources project excludes user-level settings and memory; with an
//      empty temp cwd there are no project settings either — clean slate.
//   3. Child env strips every known billing/routing override (see
//      STRIPPED_BILLING_ENV_VARS) so an exported key can't silently flip the
//      CLI to metered API billing and an inherited base-URL / Bedrock / Vertex
//      setting can't reroute QA turns away from the buyer's subscription.

import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractJson } from "./prompts.mjs";

const DEFAULT_INACTIVITY_MS = 120_000;
const DISALLOWED_TOOLS =
  "Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,Task,Read,Grep,Glob";

// Billing/routing env vars stripped from the child in subscription mode.
// ANTHROPIC_API_KEY/AUTH_TOKEN would silently flip the CLI to metered billing;
// the base-URL and Bedrock/Vertex toggles would silently reroute every
// overnight turn (containing the buyer's app content) to a non-Anthropic
// endpoint or bill it to a cloud account — the exact billing-surprise and
// phone-home outcomes the compliance box rules out ("network calls only to the
// target app and api.anthropic.com"). doctor warns when any of these are set.
export const STRIPPED_BILLING_ENV_VARS = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
]);

export function createClaudeCliBrain(config, deps = {}) {
  const brainCfg = config?.brain ?? {};
  const model = brainCfg.model ?? "sonnet";
  const inactivityMs = deps.inactivityMs ?? DEFAULT_INACTIVITY_MS;
  const children = new Set();
  let tempDirPromise = null; // created once per brain, removed on close
  let cliPathPromise = null;

  function tempDir() {
    tempDirPromise ??= mkdtemp(path.join(os.tmpdir(), "nightshift-"));
    return tempDirPromise;
  }

  function cliPath() {
    cliPathPromise ??= resolveCliPath(brainCfg.cliPath);
    return cliPathPromise;
  }

  async function ask(turn) {
    const startedAt = Date.now();
    const zeroUsage = () => ({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
      durationMs: Date.now() - startedAt,
    });
    const fail = (detail, usage) => ({
      ok: false,
      json: null,
      rawText: detail,
      usage: usage ?? zeroUsage(),
    });

    try {
      const [cwd, bin] = await Promise.all([tempDir(), cliPath()]);
      const run = await runCli(bin, turn, { cwd, model, inactivityMs, children });

      if (run.spawnError) {
        return fail(`claude CLI spawn failed: ${run.spawnError.message}`);
      }
      if (run.timedOut) {
        return fail(
          `claude CLI killed after ${inactivityMs}ms of inactivity` +
            (run.stdout ? `; partial stdout: ${run.stdout.slice(0, 400)}` : ""),
        );
      }

      // Parse stdout even on non-zero exit: on API errors the CLI exits 1 but
      // STILL prints a complete JSON result with is_error:true.
      const parsed = parseCliJson(run.stdout);
      if (!parsed) {
        const detail = (run.stdout || run.stderr || "(no output)").slice(0, 2000);
        return fail(`claude CLI produced unparseable output (exit ${run.exitCode}): ${detail}`);
      }

      const usage = {
        inputTokens: parsed.usage?.input_tokens ?? 0,
        outputTokens: parsed.usage?.output_tokens ?? 0,
        costUsd: typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : null,
        durationMs: Date.now() - startedAt,
      };
      const rawText =
        typeof parsed.result === "string" ? parsed.result : JSON.stringify(parsed.result ?? "");

      if (parsed.is_error) return { ok: false, json: null, rawText, usage };

      const json = extractJson(rawText);
      return { ok: json !== null, json, rawText, usage };
    } catch (err) {
      // ask() NEVER rejects — one CLI hiccup must not kill an overnight session.
      return fail(`brain error: ${err?.message ?? String(err)}`);
    }
  }

  async function close() {
    for (const child of children) {
      try {
        child.kill("SIGKILL");
      } catch {
        // already dead
      }
    }
    if (tempDirPromise) {
      try {
        const dir = await tempDirPromise;
        await rm(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  }

  return { mode: "subscription-cli", model, ask, close };
}

function runCli(bin, turn, { cwd, model, inactivityMs, children }) {
  const system = String(turn?.system ?? "");
  const user = String(turn?.user ?? "");
  const args = [
    "-p",
    user,
    "--output-format",
    "json",
    "--model",
    model,
    "--append-system-prompt",
    system,
    "--strict-mcp-config",
    "--setting-sources",
    "project",
    "--disallowedTools",
    DISALLOWED_TOOLS,
  ];
  const env = { ...process.env };
  for (const name of STRIPPED_BILLING_ENV_VARS) delete env[name];

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ spawnError: err, stdout: "", stderr: "", exitCode: null, timedOut: false });
      return;
    }
    children.add(child);

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer = null;

    const resetTimer = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // already dead
        }
      }, inactivityMs);
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      children.delete(child);
      resolve(result);
    };

    resetTimer();
    child.stdout.on("data", (d) => {
      stdout += d;
      resetTimer();
    });
    child.stderr.on("data", (d) => {
      stderr += d;
      resetTimer();
    });
    child.on("error", (err) =>
      finish({ spawnError: err, stdout, stderr, exitCode: null, timedOut }),
    );
    child.on("close", (code) =>
      finish({ spawnError: null, stdout, stderr, exitCode: code, timedOut }),
    );
  });
}

function parseCliJson(stdout) {
  const trimmed = (stdout ?? "").trim();
  if (!trimmed) return null;
  try {
    const v = JSON.parse(trimmed);
    if (v !== null && typeof v === "object" && !Array.isArray(v)) return v;
  } catch {
    // fall through to a lenient scan (e.g. a stray warning line before the JSON)
  }
  const fallback = extractJson(trimmed);
  if (fallback && ("result" in fallback || "is_error" in fallback)) return fallback;
  return null;
}

// cliPath resolution: config.brain.cliPath -> `claude` on PATH -> ~/.local/bin/claude.
// A missing binary surfaces later as a spawn error, which ask() maps to ok:false.
async function resolveCliPath(configured) {
  if (configured) return configured;
  const onPath = findOnPath("claude");
  if (onPath) return onPath;
  return path.join(os.homedir(), ".local", "bin", "claude");
}

function findOnPath(name) {
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // not here, keep looking
    }
  }
  return null;
}
