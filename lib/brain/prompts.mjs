// lib/brain/prompts.mjs — system/turn prompt builders + JSON extraction (agent A).
// The brain reply schema is documented INSIDE the system prompt (pinned in DESIGN.md).

export function buildSystemPrompt() {
  return [
    "You are NightShift, an automated QA engineer exploring a web application overnight.",
    "",
    "Each turn you receive the current page state: URL, title, a numbered table of",
    "interactive elements, recent failures, visited URLs, the remaining action budget,",
    "and a page text excerpt.",
    "",
    "Your job each turn:",
    '1. Propose exactly ONE next action (or set "done": true when exploration is exhausted).',
    "2. Flag semantic findings you can actually SEE in the supplied page state",
    "   (wrong totals, NaN values, contradictory text). Never invent findings.",
    "",
    "Reply ONLY with a single JSON object — no prose before or after — matching exactly",
    "this schema:",
    "",
    "{",
    '  "action": {',
    '    "kind": "click" | "fill" | "select" | "press" | "goto" | "back",',
    '    "elementId": 3,        // id from the ELEMENTS table (click/fill/select/press)',
    '    "value": "hello",      // fill/select value, or key name for press',
    '    "url": "/cart",        // goto only: same-origin path',
    '    "why": "short reason"',
    "  },",
    '  "findings": [',
    "    {",
    '      "title": "Coupon total renders NaN",',
    '      "severity": "critical" | "major" | "minor",',
    '      "expected": "a numeric order total",',
    '      "actual": "Total: NaN",',
    '      "check": {',
    '        "kind": "text-present" | "text-absent",',
    '        "selector": "css selector, or null for the whole page",',
    '        "text": "Total: NaN"',
    "      }",
    "    }",
    "  ],",
    '  "done": false',
    "}",
    "",
    "Rules:",
    '- "findings" may be an empty array. Set "done": true instead of an action when finished.',
    '- Every semantic finding MUST include "check": the deterministic assertion a replayer',
    "  will verify with the LLM out of the loop. A finding whose check you cannot express",
    "  cannot be confirmed and will be discarded.",
    '- check.text MUST be the FULLEST STABLE text fragment visible on the page,',
    '  e.g. "Total: NaN" — never bare "NaN" (bare "NaN" would match "Banana").',
    "  Prefer label + value over the value alone.",
    "- Prefer actions likely to expose bugs: submitting forms, applying coupons,",
    "  clicking primary buttons, following links.",
    "- Only interact with the app under test; never propose destructive actions elsewhere.",
  ].join("\n");
}

export function buildTurnPrompt({
  pageUrl,
  title,
  elements = [],
  recentFailures = [],
  visitedUrls = [],
  remainingActions,
  pageTextExcerpt = "",
} = {}) {
  const lines = [];
  lines.push(`PAGE: ${pageUrl ?? ""}`);
  lines.push(`TITLE: ${title ?? ""}`);
  lines.push("");
  lines.push("ELEMENTS (id | role | name | tag | state):");
  if (elements.length === 0) {
    lines.push("  (none)");
  } else {
    for (const el of elements) {
      const state =
        [el.disabled ? "disabled" : null, el.editable ? "editable" : null]
          .filter(Boolean)
          .join(",") || "-";
      lines.push(`  ${el.id} | ${el.role} | ${el.name} | ${el.tag} | ${state}`);
    }
  }
  lines.push("");
  lines.push(`RECENT FAILURES:${recentFailures.length ? "" : " (none)"}`);
  for (const f of recentFailures) {
    if (typeof f === "string") lines.push(`  - ${f}`);
    else lines.push(`  - [${f.oracle ?? "?"}] ${f.message ?? ""} (${f.url ?? ""})`);
  }
  lines.push("");
  lines.push(`VISITED URLS:${visitedUrls.length ? "" : " (none)"}`);
  for (const u of visitedUrls) lines.push(`  - ${u}`);
  lines.push("");
  lines.push(`REMAINING ACTIONS: ${remainingActions ?? 0}`);
  lines.push("");
  lines.push("PAGE TEXT EXCERPT:");
  lines.push(pageTextExcerpt || "(empty)");
  lines.push("");
  lines.push("Reply with ONE JSON object per the schema in the system prompt.");
  return lines.join("\n");
}

// Extract the first JSON object from a model reply: fenced block first,
// then first balanced {...}. Returns the parsed object, or null on failure.
export function extractJson(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) {
    const direct = tryParseObject(fence[1].trim());
    if (direct !== null) return direct;
    const inner = firstBalancedObject(fence[1]);
    if (inner !== null) return inner;
  }
  return firstBalancedObject(text);
}

function tryParseObject(s) {
  try {
    const v = JSON.parse(s);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function firstBalancedObject(text) {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    const end = findBalancedEnd(text, start);
    if (end === -1) continue;
    const candidate = tryParseObject(text.slice(start, end + 1));
    if (candidate !== null) return candidate;
  }
  return null;
}

// Scan for the matching close brace, respecting JSON string literals and escapes.
function findBalancedEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
