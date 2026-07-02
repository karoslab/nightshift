// lib/explorer.mjs — maps a brain Action onto the shared execution path.
// executeAction(page, action, elements) -> TraceStep. Never throws; failures
// are recorded in the step. The caller assigns step.i (trace position).

import { performStep, safePageUrl } from "./trace.mjs";

const ELEMENT_KINDS = new Set(["click", "fill", "select", "press"]);

export async function executeAction(page, action, elements) {
  const kind = action && typeof action === "object" ? action.kind : null;
  try {
    if (ELEMENT_KINDS.has(kind)) {
      const el = elementById(elements, action.elementId);
      if (!el) return unexecutedStep(page, action, "unknown elementId: " + String(action.elementId));
      return await performStep(page, { kind, locator: el.locator, value: action.value ?? null });
    }
    if (kind === "goto") {
      const target = resolveSameOrigin(page, action.url);
      if (!target) return unexecutedStep(page, action, "goto blocked (cross-origin or invalid url): " + String(action.url));
      return await performStep(page, { kind: "goto", value: target });
    }
    if (kind === "back") {
      return await performStep(page, { kind: "back" });
    }
    return unexecutedStep(page, action, "unknown action kind: " + String(kind));
  } catch (err) {
    return unexecutedStep(page, action, String(err && err.message ? err.message : err));
  }
}

function elementById(elements, elementId) {
  if (!Array.isArray(elements) || !Number.isInteger(elementId)) return null;
  return elements.find((e) => e && e.id === elementId) ?? null;
}

// Same-origin goto guard: resolve relative paths against the current page,
// refuse anything that leaves the target origin.
function resolveSameOrigin(page, url) {
  if (typeof url !== "string" || url === "") return null;
  try {
    const base = new URL(page.url());
    const target = new URL(url, base);
    if (target.origin !== base.origin) return null;
    return target.href;
  } catch {
    return null;
  }
}

// TraceStep for an action that was rejected before touching the page.
function unexecutedStep(page, action, error) {
  const url = safePageUrl(page);
  return {
    i: 0,
    kind: action && action.kind ? action.kind : "unknown",
    locator: null,
    value: action && action.value != null ? action.value : null,
    url,
    postUrl: url,
    ok: false,
    error,
    tMs: 0,
    settle: { condition: "timeout", waitedMs: 0 },
  };
}
