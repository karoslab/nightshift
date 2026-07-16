// tests/prompts.test.mjs — system/turn prompt builders + extractJson.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt, buildTurnPrompt, extractJson } from "../lib/brain/prompts.mjs";

test("buildSystemPrompt documents the pinned reply schema", () => {
  const prompt = buildSystemPrompt();
  assert.match(prompt, /ONLY with a single JSON object/);
  assert.match(prompt, /ONE next action/);
  assert.match(prompt, /"action"/);
  assert.match(prompt, /"findings"/);
  assert.match(prompt, /"check"/);
  assert.match(prompt, /"text-present" \| "text-absent"/);
  assert.match(prompt, /"critical" \| "major" \| "minor"/);
  assert.match(prompt, /"click" \| "fill" \| "select" \| "press" \| "goto" \| "back"/);
  assert.match(prompt, /"done"/);
});

test("buildSystemPrompt demands the fullest stable check.text fragment", () => {
  const prompt = buildSystemPrompt();
  assert.match(prompt, /FULLEST STABLE text fragment/);
  assert.ok(prompt.includes('"Total: NaN"'));
  assert.ok(prompt.includes('never bare "NaN"'));
});

test("buildTurnPrompt renders every context section", () => {
  const prompt = buildTurnPrompt({
    pageUrl: "http://127.0.0.1:4185/shop",
    title: "Bugbox Shop",
    elements: [
      {
        id: 3,
        role: "button",
        name: "Add to cart",
        tag: "button",
        disabled: false,
        editable: false,
      },
      { id: 4, role: "textbox", name: "Coupon", tag: "input", disabled: false, editable: true },
    ],
    recentFailures: [
      { oracle: "network-5xx", message: "GET /api/flaky -> 500", url: "http://x/shop" },
    ],
    visitedUrls: ["http://127.0.0.1:4185/"],
    remainingActions: 5,
    pageTextExcerpt: "Welcome to Bugbox. Total: $12.00",
  });
  assert.ok(prompt.includes("PAGE: http://127.0.0.1:4185/shop"));
  assert.ok(prompt.includes("TITLE: Bugbox Shop"));
  assert.ok(prompt.includes("3 | button | Add to cart | button | -"));
  assert.ok(prompt.includes("4 | textbox | Coupon | input | editable"));
  assert.ok(prompt.includes("[network-5xx] GET /api/flaky -> 500"));
  assert.ok(prompt.includes("- http://127.0.0.1:4185/"));
  assert.ok(prompt.includes("REMAINING ACTIONS: 5"));
  assert.ok(prompt.includes("Welcome to Bugbox. Total: $12.00"));
});

test("buildTurnPrompt tolerates empty context", () => {
  const prompt = buildTurnPrompt({ pageUrl: "http://x/" });
  assert.ok(prompt.includes("PAGE: http://x/"));
  assert.ok(prompt.includes("(none)"));
  assert.ok(prompt.includes("REMAINING ACTIONS: 0"));
  assert.ok(prompt.includes("(empty)"));
});

test("extractJson: fenced json block", () => {
  const out = extractJson('Here you go:\n```json\n{"a": 1, "b": [2, 3]}\n```\nthanks');
  assert.deepEqual(out, { a: 1, b: [2, 3] });
});

test("extractJson: fenced block without a language tag", () => {
  assert.deepEqual(extractJson('```\n{"a": 1}\n```'), { a: 1 });
});

test("extractJson: bare object surrounded by prose", () => {
  const out = extractJson('Sure! The result is {"action": {"kind": "click"}} — done.');
  assert.deepEqual(out, { action: { kind: "click" } });
});

test("extractJson: braces and escapes inside string values", () => {
  const out = extractJson('prefix {"msg": "curly } inside", "quote": "say \\" and }", "n": 1} suffix');
  assert.deepEqual(out, { msg: "curly } inside", quote: 'say " and }', n: 1 });
});

test("extractJson: returns the FIRST balanced object", () => {
  assert.deepEqual(extractJson('x {"first": 1} y {"second": 2}'), { first: 1 });
});

test("extractJson: skips an unparseable candidate and finds a later valid one", () => {
  assert.deepEqual(extractJson('{oops not json} then {"ok": true}'), { ok: true });
});

test("extractJson: fenced garbage falls back to a bare object elsewhere", () => {
  assert.deepEqual(extractJson('```\ngarbage\n```\nresult: {"a": 1}'), { a: 1 });
});

test("extractJson: garbage returns null", () => {
  assert.equal(extractJson("no json anywhere here"), null);
  assert.equal(extractJson("unbalanced { forever"), null);
});

test("extractJson: non-object JSON returns null", () => {
  assert.equal(extractJson("[1, 2, 3]"), null);
  assert.equal(extractJson('"just a string"'), null);
});

test("extractJson: empty / non-string input returns null", () => {
  assert.equal(extractJson(""), null);
  assert.equal(extractJson(null), null);
  assert.equal(extractJson(undefined), null);
  assert.equal(extractJson(42), null);
});
