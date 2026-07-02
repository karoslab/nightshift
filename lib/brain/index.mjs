// lib/brain/index.mjs — createBrain(config, deps?) dispatcher (agent A).
// Returns { mode, model, ask(turn), close() }; ask() NEVER rejects.

import { createClaudeCliBrain } from "./claude-cli.mjs";
import { createApiKeyBrain } from "./api-key.mjs";
import { createMockBrain } from "./mock.mjs";

export function createBrain(config, deps = {}) {
  const mode = config?.brain?.mode ?? "subscription-cli";
  if (mode === "subscription-cli") return createClaudeCliBrain(config, deps);
  if (mode === "api-key") return createApiKeyBrain(config, deps);
  if (mode === "mock") return createMockBrain(deps.script ?? config?.brain?.script ?? []);
  throw new Error(
    `Unknown brain.mode ${JSON.stringify(mode)} — expected "subscription-cli", "api-key", or "mock"`,
  );
}
