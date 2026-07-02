// lib/brain/mock.mjs — deterministic scripted brain for tests and `--brain mock` demo.

import { extractJson } from "./prompts.mjs";

// script: array of canned JSON replies (objects, or strings containing JSON),
// popped one per ask(); when exhausted every ask returns { done: true }.
export function createMockBrain(script = []) {
  const queue = Array.isArray(script) ? [...script] : [];
  return {
    mode: "mock",
    model: "scripted",
    async ask() {
      const reply = queue.length > 0 ? queue.shift() : { done: true };
      let json;
      let rawText;
      if (typeof reply === "string") {
        rawText = reply;
        json = extractJson(reply);
      } else {
        json = reply;
        rawText = JSON.stringify(reply);
      }
      return {
        ok: json !== null,
        json,
        rawText,
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 },
      };
    },
    async close() {},
  };
}
