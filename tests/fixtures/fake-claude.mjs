#!/usr/bin/env node
// tests/fixtures/fake-claude.mjs — stand-in for the real `claude` CLI.
// Emits a canned CLI-shaped JSON result on stdout and records isolation
// evidence {cwd, env flags, argv} to the side file named by FAKE_CLAUDE_SIDECAR,
// so tests can assert the pinned invariants (temp cwd, billing vars stripped,
// --setting-sources project present). Behavior selected via FAKE_CLAUDE_MODE:
//   ok (default) | error-json | garbage | hang

import fs from "node:fs";

// Every billing/routing var NightShift must strip (keep in sync with
// STRIPPED_BILLING_ENV_VARS in lib/brain/claude-cli.mjs).
const BILLING_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
];

const sidecar = process.env.FAKE_CLAUDE_SIDECAR;
if (sidecar) {
  fs.writeFileSync(
    sidecar,
    JSON.stringify({
      cwd: process.cwd(),
      hasApiKey: Object.prototype.hasOwnProperty.call(process.env, "ANTHROPIC_API_KEY"),
      hasAuthToken: Object.prototype.hasOwnProperty.call(process.env, "ANTHROPIC_AUTH_TOKEN"),
      presentBillingVars: BILLING_VARS.filter((k) => Object.prototype.hasOwnProperty.call(process.env, k)),
      argv: process.argv.slice(2),
    }),
  );
}

const mode = process.env.FAKE_CLAUDE_MODE || "ok";

if (mode === "hang") {
  // Never write output, never exit — exercises the inactivity kill.
  setInterval(() => {}, 1_000);
} else if (mode === "garbage") {
  process.stdout.write("this is definitely not json\n");
  process.exit(0);
} else if (mode === "error-json") {
  // Real CLI behavior on API errors: exit 1 but STILL print complete JSON.
  process.stdout.write(
    JSON.stringify({
      type: "result",
      result: "API Error: rate limit exceeded, try again later",
      is_error: true,
      usage: { input_tokens: 12, output_tokens: 0 },
      total_cost_usd: 0,
    }),
  );
  process.exit(1);
} else {
  const reply =
    process.env.FAKE_CLAUDE_REPLY ??
    '```json\n{"action":{"kind":"click","elementId":1,"why":"test"},"findings":[],"done":false}\n```';
  process.stdout.write(
    JSON.stringify({
      type: "result",
      result: reply,
      is_error: false,
      usage: { input_tokens: 100, output_tokens: 42 },
      total_cost_usd: 0.0123,
    }),
  );
  process.exit(0);
}
