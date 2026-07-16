// lib/sweep-input.mjs — deterministic form-input synthesis for sweep mode.
// Three passes per form (DESIGN: sweep): "empty" (submit nothing), "hostile"
// (overlong + non-ASCII + script-tag payload), "valid" (a plausible value
// derived from the field's type/name/placeholder — no LLM needed for v1).
// A brain hook (opts.suggest) is threaded through so a later version can
// replace the deterministic "valid" derivation without changing the callers.

export const SWEEP_PASSES = ["empty", "hostile", "valid"];

// One string that is simultaneously overlong, non-ASCII, and a stored-XSS
// probe — the three hostile properties the sweep asserts on every text field.
export const HOSTILE_VALUE = "<script>alert('ns-sweep')</script>﷽" + "A".repeat(4096);

// Plausible-but-benign values keyed by input type. Kept literal so they read
// as a spec, not a computation.
const VALID_BY_TYPE = {
  email: "qa@example.com",
  number: "42",
  tel: "+15555550123",
  url: "https://example.com",
  search: "sweep test",
  password: "Sw33pTest!9",
  date: "2026-01-01",
  "datetime-local": "2026-01-01T09:00",
  month: "2026-01",
  week: "2026-W01",
  time: "09:00",
  color: "#3366cc",
  range: "42",
};

// synthesizeFieldValue(field, pass, opts?) -> string
//   field: { type, name, placeholder } (any may be absent)
//   pass:  one of SWEEP_PASSES
//   opts.suggest: optional (field, pass) => string|null — the brain hook; a
//                 string return wins, null/undefined falls through.
export function synthesizeFieldValue(field = {}, pass, opts = {}) {
  if (typeof opts.suggest === "function") {
    const suggested = opts.suggest(field, pass);
    if (typeof suggested === "string") return suggested;
  }
  if (pass === "empty") return "";
  if (pass === "hostile") return HOSTILE_VALUE;
  if (pass === "valid") return validValue(field);
  throw new Error("unknown sweep pass: " + String(pass));
}

function validValue(field) {
  const type = String(field.type ?? "text").toLowerCase();
  if (VALID_BY_TYPE[type]) return VALID_BY_TYPE[type];

  const hint = (String(field.name ?? "") + " " + String(field.placeholder ?? "")).toLowerCase();
  if (/e-?mail/.test(hint)) return VALID_BY_TYPE.email;
  if (/phone|tel|mobile/.test(hint)) return VALID_BY_TYPE.tel;
  if (/url|website|link/.test(hint)) return VALID_BY_TYPE.url;
  if (/zip|postal/.test(hint)) return "94105";
  if (/number|qty|quantity|amount|age|count/.test(hint)) return "42";
  if (/name/.test(hint)) return "QA Sweep";
  return "sweep test";
}
