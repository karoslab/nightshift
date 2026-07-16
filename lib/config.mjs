// lib/config.mjs — load/validate/default NightShift config (DESIGN.md pinned defaults).
import fs from "node:fs";
import path from "node:path";
import { ACTION_KINDS } from "./explorer.mjs";
import { CHECK_IDS as SECURITY_CHECK_IDS } from "./security/checks.mjs";

const MODES = ["subscription-cli", "api-key", "mock"];
const SECURITY_SEVERITIES = ["minor", "major", "critical"];

// Auth login steps drive a real login form; "goto" navigates, the rest act on a
// CSS selector. Secrets are injected by env-var NAME via `valueFrom`, never
// stored in config. Journeys are deterministic critical paths — same verbs,
// plus per-step `expect` assertions.
const AUTH_STEP_ACTIONS = ["fill", "click", "goto", "press", "select"];
export const JOURNEY_STEP_ACTIONS = ["goto", "click", "fill", "select", "press"];
export const AUTH_VALUE_FROM = ["username", "password", "totp"];
const AUTH_VALUE_FROM_ENV = { username: "usernameEnv", password: "passwordEnv", totp: "totpSecretEnv" };
export const RESERVED_ROLE = "anonymous"; // the implicit default role; never user-declared
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const EXPECT_KEYS = ["urlIncludes", "textPresent", "textAbsent", "selector"];

const DEFAULTS = Object.freeze({
  target: {
    name: "My App",
    url: "http://localhost:3000",
    routes: ["/"],
    maxRoutes: 12,
    actionsPerPage: 6,
    selectorDenylist: [],
    denyActionKinds: [],
    sweep: false,
    auth: { roles: [] },
    journeys: [],
  },
  brain: {
    mode: "subscription-cli",
    model: "sonnet",
    cliPath: null,
    apiKeyEnv: "ANTHROPIC_API_KEY",
    apiModel: "claude-sonnet-5",
    maxOutputTokens: 2048,
  },
  budget: {
    maxLlmCalls: 40,
    maxMinutes: 45,
    maxSessionsPerNight: 4,
    stopAtHour: 6,
  },
  oracles: {
    expectedStatuses: [401, 403],
    ignoreConsole: ["ResizeObserver loop", "\\[HMR\\]", "Download the React DevTools"],
  },
  reverify: { replays: 2, requiredPasses: 2, navTimeoutMs: 15000 },
  report: { dir: ".nightshift" },
  security: {
    enabled: false, // off by default; opt-in loadout — zero behavior change until flipped
    scope: { origins: [] }, // empty = target origin only (see lib/security/scope.mjs)
    checks: ["*"], // or explicit check ids from lib/security/checks.mjs CHECK_IDS
    severityFloor: "minor",
  },
});

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

function fail(message) {
  throw new ConfigError(message);
}

function got(value) {
  return value === undefined ? "undefined" : JSON.stringify(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// User values win; plain objects merge recursively; arrays and scalars replace.
function deepMerge(base, over) {
  const out = { ...base };
  for (const [key, value] of Object.entries(over)) {
    out[key] =
      isPlainObject(value) && isPlainObject(base[key])
        ? deepMerge(base[key], value)
        : structuredClone(value);
  }
  return out;
}

function requireSection(config, key) {
  if (!isPlainObject(config[key])) {
    fail(`"${key}" must be a JSON object (see examples/nightshift.config.json) — got ${got(config[key])}`);
  }
}

function requireString(value, key) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${key} must be a non-empty string — got ${got(value)}`);
  }
}

function requirePosInt(value, key) {
  if (!Number.isInteger(value) || value <= 0) {
    fail(`${key} must be a positive integer — got ${got(value)}`);
  }
}

function requireHttpUrl(value, key) {
  requireString(value, key);
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${key} must be a full http(s) URL like "http://localhost:3000" — got ${got(value)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    fail(`${key} must use http or https — got ${got(value)}`);
  }
}

function requireRoutes(value, key, targetOrigin) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${key} must be a non-empty array of paths like ["/"] — got ${got(value)}`);
  }
  for (const route of value) {
    const ok =
      typeof route === "string" &&
      (route.startsWith("/") || /^https?:\/\//.test(route));
    if (!ok) {
      fail(`${key} entries must be paths starting with "/" (or absolute http(s) URLs) — got ${got(route)}`);
    }
    if (/^https?:\/\//.test(route) && new URL(route).origin !== targetOrigin) {
      fail(`${key} entries must be same-origin as target.url (${targetOrigin}) — got ${got(route)}`);
    }
  }
}

// No CSS parser is available in Node without a browser or an added
// dependency, so this checks structural well-formedness only (balanced
// brackets/parens, terminated quotes, non-empty) rather than full CSS
// Selectors grammar. That's enough to fail closed on the common failure mode
// — a typo'd selector that would otherwise silently match nothing and let a
// dangerous element through unblocked — without launching a browser just to
// validate config.
function isStructurallyValidSelector(selector) {
  if (typeof selector !== "string" || selector.trim().length === 0) return false;
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(selector)) return false;
  const stack = [];
  let quote = null;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "(" || c === "[") { stack.push(c); continue; }
    if (c === ")" || c === "]") {
      const open = stack.pop();
      if (open !== { ")": "(", "]": "[" }[c]) return false;
    }
  }
  return stack.length === 0 && quote === null;
}

function requireSelector(value, key) {
  if (typeof value !== "string" || !isStructurallyValidSelector(value)) {
    fail(`${key} must be a valid CSS selector — got ${got(value)}`);
  }
}

// An env-var NAME (POSIX identifier), never a value — the value is read from
// process.env at runtime so credentials never live in the config file.
function requireEnvName(value, key) {
  requireString(value, key);
  if (!ENV_NAME_RE.test(value)) {
    fail(
      `${key} must be an ENVIRONMENT VARIABLE NAME like "NIGHTSHIFT_USER" (letters, digits, underscore; ` +
        `not starting with a digit) — got ${got(value)}. NightShift reads the value from your environment at ` +
        `runtime and never stores it in config.`
    );
  }
}

// A same-origin path ("/login") or an absolute same-origin URL — reused by auth
// loginUrl / step goto and journey goto.
function requireSameOriginTarget(value, key, targetOrigin) {
  requireString(value, key);
  const ok = value.startsWith("/") || /^https?:\/\//.test(value);
  if (!ok) {
    fail(`${key} must be a path starting with "/" (or an absolute same-origin http(s) URL) — got ${got(value)}`);
  }
  if (/^https?:\/\//.test(value) && new URL(value).origin !== targetOrigin) {
    fail(`${key} must be same-origin as target.url (${targetOrigin}) — got ${got(value)}`);
  }
}

function validateAuth(auth, targetOrigin) {
  if (!isPlainObject(auth)) {
    fail(`target.auth must be a JSON object with a "roles" array (see examples/nightshift.config.json) — got ${got(auth)}`);
  }
  if (!Array.isArray(auth.roles)) {
    fail(`target.auth.roles must be an array of role objects — got ${got(auth.roles)}`);
  }
  const seen = new Set();
  auth.roles.forEach((role, i) => {
    const rk = `target.auth.roles[${i}]`;
    if (!isPlainObject(role)) fail(`${rk} must be an object — got ${got(role)}`);
    requireString(role.name, `${rk}.name`);
    if (role.name.toLowerCase() === RESERVED_ROLE) {
      fail(`${rk}.name "${RESERVED_ROLE}" is reserved for the implicit default (unauthenticated) role — pick another name`);
    }
    if (seen.has(role.name)) fail(`${rk}.name must be unique — "${role.name}" appears more than once`);
    seen.add(role.name);

    for (const field of ["usernameEnv", "passwordEnv", "totpSecretEnv"]) {
      if (role[field] !== undefined) requireEnvName(role[field], `${rk}.${field}`);
    }

    const hasSteps = role.steps !== undefined;
    const hasSetup = role.setupScript !== undefined;
    if (hasSteps === hasSetup) {
      fail(`${rk} must have exactly one of "steps" (a selector-based login script) or "setupScript" (a path) — not both, not neither`);
    }
    if (hasSetup) {
      requireString(role.setupScript, `${rk}.setupScript`);
      return;
    }
    requireSameOriginTarget(role.loginUrl, `${rk}.loginUrl`, targetOrigin);
    if (!Array.isArray(role.steps) || role.steps.length === 0) {
      fail(`${rk}.steps must be a non-empty array of login steps — got ${got(role.steps)}`);
    }
    role.steps.forEach((step, j) => validateAuthStep(step, `${rk}.steps[${j}]`, role, targetOrigin));
  });
}

function validateAuthStep(step, key, role, targetOrigin) {
  if (!isPlainObject(step)) fail(`${key} must be an object — got ${got(step)}`);
  if (!AUTH_STEP_ACTIONS.includes(step.action)) {
    fail(`${key}.action must be one of ${AUTH_STEP_ACTIONS.join(", ")} — got ${got(step.action)}`);
  }
  if (step.action === "goto") {
    requireSameOriginTarget(step.url, `${key}.url`, targetOrigin);
  } else {
    requireSelector(step.selector, `${key}.selector`);
  }
  if (step.valueFrom !== undefined) {
    if (!AUTH_VALUE_FROM.includes(step.valueFrom)) {
      fail(`${key}.valueFrom must be one of ${AUTH_VALUE_FROM.join(", ")} — got ${got(step.valueFrom)}`);
    }
    if (step.value !== undefined) fail(`${key} must not set both "value" and "valueFrom"`);
    const envField = AUTH_VALUE_FROM_ENV[step.valueFrom];
    if (role[envField] === undefined) {
      fail(`${key}.valueFrom "${step.valueFrom}" requires ${key.split(".steps")[0]}.${envField} to name the env var holding it`);
    }
  } else if (step.value !== undefined && typeof step.value !== "string") {
    fail(`${key}.value must be a string — got ${got(step.value)}`);
  }
}

function validateJourneys(journeys, targetOrigin, roleNames) {
  if (!Array.isArray(journeys)) {
    fail(`target.journeys must be an array of journey objects — got ${got(journeys)}`);
  }
  const seen = new Set();
  journeys.forEach((journey, i) => {
    const jk = `target.journeys[${i}]`;
    if (!isPlainObject(journey)) fail(`${jk} must be an object — got ${got(journey)}`);
    requireString(journey.name, `${jk}.name`);
    if (seen.has(journey.name)) fail(`${jk}.name must be unique — "${journey.name}" appears more than once`);
    seen.add(journey.name);
    if (!Array.isArray(journey.steps) || journey.steps.length === 0) {
      fail(`${jk}.steps must be a non-empty array of steps — got ${got(journey.steps)}`);
    }
    journey.steps.forEach((step, j) => validateJourneyStep(step, `${jk}.steps[${j}]`, targetOrigin));
    // Optional role scoping: a journey runs for every role by default; `roles`
    // restricts it to the named roles so a login-gated journey does not run
    // (and false-positive) under the anonymous role. Entries must name the
    // implicit "anonymous" role or a declared target.auth role.
    if (journey.roles !== undefined) {
      if (!Array.isArray(journey.roles) || journey.roles.length === 0) {
        fail(`${jk}.roles must be a non-empty array of role names — got ${got(journey.roles)}`);
      }
      for (const roleName of journey.roles) {
        if (typeof roleName !== "string") fail(`${jk}.roles entries must be strings — got ${got(roleName)}`);
        if (!roleNames.has(roleName)) {
          fail(
            `${jk}.roles names "${roleName}", which is not "${RESERVED_ROLE}" or a declared target.auth role ` +
              `(known: ${[...roleNames].map((n) => JSON.stringify(n)).join(", ")})`
          );
        }
      }
    }
  });
}

function validateJourneyStep(step, key, targetOrigin) {
  if (!isPlainObject(step)) fail(`${key} must be an object — got ${got(step)}`);
  if (!JOURNEY_STEP_ACTIONS.includes(step.action)) {
    fail(`${key}.action must be one of ${JOURNEY_STEP_ACTIONS.join(", ")} — got ${got(step.action)}`);
  }
  if (step.action === "goto") {
    requireSameOriginTarget(step.url, `${key}.url`, targetOrigin);
  } else {
    requireSelector(step.selector, `${key}.selector`);
  }
  if (step.value !== undefined && typeof step.value !== "string") {
    fail(`${key}.value must be a string — got ${got(step.value)}`);
  }
  if (step.expect !== undefined) validateExpect(step.expect, `${key}.expect`);
}

function validateExpect(expect, key) {
  if (!isPlainObject(expect)) {
    fail(`${key} must be an object with one or more of urlIncludes/textPresent/textAbsent (optional selector) — got ${got(expect)}`);
  }
  for (const k of Object.keys(expect)) {
    if (!EXPECT_KEYS.includes(k)) fail(`${key} has unknown key "${k}" — allowed: ${EXPECT_KEYS.join(", ")}`);
  }
  let assertions = 0;
  for (const k of ["urlIncludes", "textPresent", "textAbsent"]) {
    if (expect[k] !== undefined) {
      requireString(expect[k], `${key}.${k}`);
      assertions += 1;
    }
  }
  if (assertions === 0) {
    fail(`${key} must assert at least one of urlIncludes/textPresent/textAbsent`);
  }
  if (expect.selector !== undefined) requireSelector(expect.selector, `${key}.selector`);
}

function validate(config) {
  for (const section of ["target", "brain", "budget", "oracles", "reverify", "report", "security"]) {
    requireSection(config, section);
  }

  const target = config.target;
  requireString(target.name, "target.name");
  requireHttpUrl(target.url, "target.url");
  requireRoutes(target.routes, "target.routes", new URL(target.url).origin);
  requirePosInt(target.maxRoutes, "target.maxRoutes");
  requirePosInt(target.actionsPerPage, "target.actionsPerPage");
  if (!Array.isArray(target.selectorDenylist) || !target.selectorDenylist.every((s) => typeof s === "string")) {
    fail(`target.selectorDenylist must be an array of CSS selector strings — got ${got(target.selectorDenylist)}`);
  }
  for (const selector of target.selectorDenylist) {
    if (!isStructurallyValidSelector(selector)) {
      fail(`target.selectorDenylist entry is not valid CSS (unbalanced brackets/quotes or empty) — got ${got(selector)}`);
    }
  }
  if (!Array.isArray(target.denyActionKinds) || !target.denyActionKinds.every((s) => typeof s === "string")) {
    fail(`target.denyActionKinds must be an array of action-kind strings — got ${got(target.denyActionKinds)}`);
  }
  for (const kind of target.denyActionKinds) {
    if (!ACTION_KINDS.includes(kind)) {
      fail(`target.denyActionKinds entries must be one of ${ACTION_KINDS.join(", ")} — got ${got(kind)}`);
    }
  }
  if (typeof target.sweep !== "boolean") {
    fail(`target.sweep must be a boolean (deterministic exhaustive sweep mode) — got ${got(target.sweep)}`);
  }
  const targetOrigin = new URL(target.url).origin;
  validateAuth(target.auth, targetOrigin);
  // Valid journey role scopes: the implicit anonymous role + every declared
  // auth role (auth is validated above, so the names are known-good strings).
  const roleNames = new Set([RESERVED_ROLE, ...(target.auth?.roles ?? []).map((r) => r.name)]);
  validateJourneys(target.journeys, targetOrigin, roleNames);

  const brain = config.brain;
  if (!MODES.includes(brain.mode)) {
    fail(
      `brain.mode must be one of "subscription-cli", "api-key", "mock" — got ${got(brain.mode)}. ` +
        `Use "subscription-cli" to run on your Claude subscription via the official CLI, ` +
        `or "api-key" for metered API billing.`
    );
  }
  requireString(brain.model, "brain.model");
  if (brain.cliPath !== null && typeof brain.cliPath !== "string") {
    fail(`brain.cliPath must be null or a string path to the claude CLI — got ${got(brain.cliPath)}`);
  }
  requireString(brain.apiKeyEnv, "brain.apiKeyEnv");
  requireString(brain.apiModel, "brain.apiModel");
  requirePosInt(brain.maxOutputTokens, "brain.maxOutputTokens");

  const budget = config.budget;
  requirePosInt(budget.maxLlmCalls, "budget.maxLlmCalls");
  requirePosInt(budget.maxMinutes, "budget.maxMinutes");
  requirePosInt(budget.maxSessionsPerNight, "budget.maxSessionsPerNight");
  // The pinned midnight-wrap rule (stop while stopAtHour <= hour < 12) only
  // expresses a MORNING stop hour: for 12-23 the window is empty and the stop
  // hour would silently never fire — reject instead of ignoring it.
  if (!Number.isInteger(budget.stopAtHour) || budget.stopAtHour < 0 || budget.stopAtHour > 11) {
    fail(
      `budget.stopAtHour must be an integer morning hour (0-11) — got ${got(budget.stopAtHour)}. ` +
        `Overnight runs wrap midnight and stop when the clock reaches stopAtHour (e.g. 6 = stop at 06:00); ` +
        `afternoon/evening stop hours are not supported.`
    );
  }

  const oracles = config.oracles;
  if (
    !Array.isArray(oracles.expectedStatuses) ||
    !oracles.expectedStatuses.every((s) => Number.isInteger(s) && s >= 100 && s <= 599)
  ) {
    fail(`oracles.expectedStatuses must be an array of HTTP status codes (integers 100-599) — got ${got(oracles.expectedStatuses)}`);
  }
  if (!Array.isArray(oracles.ignoreConsole)) {
    fail(`oracles.ignoreConsole must be an array of regex strings — got ${got(oracles.ignoreConsole)}`);
  }
  for (const pattern of oracles.ignoreConsole) {
    if (typeof pattern !== "string") {
      fail(`oracles.ignoreConsole entries must be strings — got ${got(pattern)}`);
    }
    try {
      new RegExp(pattern);
    } catch (e) {
      fail(`oracles.ignoreConsole pattern ${got(pattern)} is not a valid regular expression: ${e.message}`);
    }
  }

  const reverify = config.reverify;
  requirePosInt(reverify.replays, "reverify.replays");
  requirePosInt(reverify.requiredPasses, "reverify.requiredPasses");
  if (reverify.requiredPasses > reverify.replays) {
    fail(`reverify.requiredPasses (${reverify.requiredPasses}) cannot exceed reverify.replays (${reverify.replays})`);
  }
  requirePosInt(reverify.navTimeoutMs, "reverify.navTimeoutMs");

  requireString(config.report.dir, "report.dir");

  const security = config.security;
  if (typeof security.enabled !== "boolean") {
    fail(`security.enabled must be a boolean — got ${got(security.enabled)}`);
  }
  requireSection(security, "scope");
  if (!Array.isArray(security.scope.origins) || !security.scope.origins.every((o) => typeof o === "string")) {
    fail(`security.scope.origins must be an array of origin strings — got ${got(security.scope.origins)}`);
  }
  for (const o of security.scope.origins) {
    let parsed;
    try {
      parsed = new URL(o);
    } catch {
      fail(`security.scope.origins entries must be full origins like "https://example.com" — got ${got(o)}`);
    }
    if (parsed.origin !== o) {
      fail(`security.scope.origins entries must be bare origins (no path/query) — got ${got(o)}`);
    }
  }
  if (!Array.isArray(security.checks) || !security.checks.every((c) => typeof c === "string")) {
    fail(`security.checks must be an array of check-id strings (or ["*"]) — got ${got(security.checks)}`);
  }
  for (const c of security.checks) {
    if (c !== "*" && !SECURITY_CHECK_IDS.includes(c)) {
      fail(`security.checks entries must be "*" or one of ${SECURITY_CHECK_IDS.join(", ")} — got ${got(c)}`);
    }
  }
  if (!SECURITY_SEVERITIES.includes(security.severityFloor)) {
    fail(`security.severityFloor must be one of ${SECURITY_SEVERITIES.join(", ")} — got ${got(security.severityFloor)}`);
  }
}

// Merges the user file (nightshift.config.json in cwd when no path is given)
// over the pinned defaults. Throws ConfigError with a human message on any
// invalid shape. An explicitly passed path MUST exist; the implicit cwd file
// is optional (pure defaults are returned).
export function loadConfig(configPath) {
  const explicit = configPath !== undefined && configPath !== null;
  const resolved = path.resolve(explicit ? configPath : "nightshift.config.json");

  let user = null;
  if (fs.existsSync(resolved)) {
    let raw;
    try {
      raw = fs.readFileSync(resolved, "utf8");
    } catch (e) {
      fail(`could not read config file ${resolved}: ${e.message}`);
    }
    try {
      user = JSON.parse(raw);
    } catch (e) {
      fail(`could not parse ${resolved} as JSON: ${e.message}`);
    }
    if (!isPlainObject(user)) {
      fail(`${resolved} must contain a JSON object at the top level — got ${Array.isArray(user) ? "an array" : got(user)}`);
    }
  } else if (explicit) {
    fail(`config file not found: ${resolved}`);
  }

  const config = user ? deepMerge(structuredClone(DEFAULTS), user) : structuredClone(DEFAULTS);
  validate(config);
  return config;
}
