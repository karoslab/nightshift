// lib/brain/api-key.mjs — metered mode: Anthropic Messages API via fetch.
// The key is read from env at call time and never written anywhere
// (not into config, reports, or logs). fetch is dependency-injectable for tests.

import { extractJson } from "./prompts.mjs";
import { createCircuitBreaker } from "../circuit-breaker.mjs";

const API_URL = "https://api.anthropic.com/v1/messages";

export function createApiKeyBrain(config, deps = {}) {
  const brainCfg = config?.brain ?? {};
  const apiKeyEnv = brainCfg.apiKeyEnv ?? "ANTHROPIC_API_KEY";
  const apiModel = brainCfg.apiModel ?? "claude-sonnet-5";
  const maxOutputTokens = brainCfg.maxOutputTokens ?? 2048;
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const breaker = createCircuitBreaker({}, deps.clock ?? Date.now);

  async function ask(turn) {
    const startedAt = Date.now();
    const zeroUsage = () => ({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
      durationMs: Date.now() - startedAt,
    });
    const fail = (detail) => ({ ok: false, json: null, rawText: detail, usage: zeroUsage() });

    const key = process.env[apiKeyEnv];
    if (!key) return fail(`missing API key: env var ${apiKeyEnv} is not set`);

    if (!breaker.allow()) {
      return fail(`circuit breaker open: too many recent API errors, skipping request to protect the account`);
    }

    let res;
    try {
      res = await fetchImpl(API_URL, {
        method: "POST",
        headers: {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: apiModel,
          max_tokens: maxOutputTokens,
          system: String(turn?.system ?? ""),
          messages: [{ role: "user", content: String(turn?.user ?? "") }],
        }),
      });
    } catch (err) {
      breaker.recordFailure();
      // ask() NEVER rejects — network failure is a skipped turn, not a crash.
      return fail(`fetch error: ${err?.message ?? String(err)}`);
    }

    let bodyText = "";
    try {
      bodyText = await res.text();
    } catch {
      // body unreadable; status alone goes into the detail below
    }
    if (!res.ok) {
      breaker.recordFailure();
      return fail(`API error ${res.status}: ${bodyText.slice(0, 2000)}`);
    }
    breaker.recordSuccess();

    let body = null;
    try {
      body = JSON.parse(bodyText);
    } catch {
      // handled below
    }
    if (!body || !Array.isArray(body.content)) {
      return fail(`unparseable API response: ${bodyText.slice(0, 2000)}`);
    }

    const text = body.content
      .filter((b) => b?.type === "text")
      .map((b) => b.text)
      .join("");
    const usage = {
      inputTokens: body.usage?.input_tokens ?? 0,
      outputTokens: body.usage?.output_tokens ?? 0,
      costUsd: null, // pricing unknown here — the report shows tokens instead
      durationMs: Date.now() - startedAt,
    };
    const json = extractJson(text);
    return { ok: json !== null, json, rawText: text, usage };
  }

  return { mode: "api-key", model: apiModel, ask, async close() {} };
}
