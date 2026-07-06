// tests/explorer.test.mjs — hermetic: stub page only (no browser).
// Covers the denyActionKinds refusal added for the selector-denylist feature.
import { test } from "node:test";
import assert from "node:assert/strict";
import { executeAction } from "../lib/explorer.mjs";

const textbox = {
  id: 0,
  role: "textbox",
  name: null,
  tag: "textarea",
  locator: { strategy: "css", css: "textarea", nth: 0 },
};

test("denyActionKinds refuses a denied kind before touching the page", async () => {
  const page = { url: () => "http://localhost:4183/" };
  const step = await executeAction(
    page,
    { kind: "fill", elementId: 0, value: "hi" },
    [textbox],
    { denyActionKinds: ["fill"] },
  );
  assert.equal(step.ok, false);
  assert.match(step.error, /blocked by denyActionKinds: fill/);
  // Refused before performStep — no locator resolution attempted.
  assert.equal(step.locator, null);
});

test("denyActionKinds refuses press and select too", async () => {
  const page = { url: () => "http://localhost:4183/" };
  for (const kind of ["press", "select"]) {
    const step = await executeAction(
      page,
      { kind, elementId: 0, value: kind === "press" ? "Enter" : "opt" },
      [textbox],
      { denyActionKinds: ["fill", "press", "select"] },
    );
    assert.equal(step.ok, false, `${kind} should be blocked`);
    assert.match(step.error, new RegExp("blocked by denyActionKinds: " + kind));
  }
});

test("an allowed kind is not blocked by an unrelated denyActionKinds entry", async () => {
  // click is not in the deny list -> it proceeds past the guard and fails only
  // because the stub page has no real locator machinery (proves it was NOT
  // refused by the guard: a guard refusal would carry the deny-list message).
  const page = { url: () => "http://localhost:4183/" };
  const step = await executeAction(
    page,
    { kind: "click", elementId: 0 },
    [textbox],
    { denyActionKinds: ["fill", "press", "select"] },
  );
  assert.equal(step.ok, false);
  assert.doesNotMatch(String(step.error), /blocked by denyActionKinds/);
});

test("empty denyActionKinds blocks nothing (default behavior preserved)", async () => {
  const page = { url: () => "http://localhost:4183/" };
  const step = await executeAction(
    page,
    { kind: "fill", elementId: 0, value: "hi" },
    [textbox],
    {},
  );
  assert.doesNotMatch(String(step.error ?? ""), /blocked by denyActionKinds/);
});
