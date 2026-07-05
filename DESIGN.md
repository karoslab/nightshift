# NightShift QA — architecture & module contracts (v1)

> The overnight QA employee you run on your own machine, with your own Claude.
> This document is the build contract: every module implements EXACTLY these
> interfaces and data shapes. ESM JavaScript (`.mjs`), Node >= 22, no TypeScript,
> no build step. Only runtime dependency: `playwright`. Tests use `node --test`.

## Product thesis

- **What buyers pay for:** the deterministic **repro-re-verification layer**.
  An LLM that "found a bug" is worthless if it hallucinated; NightShift only
  files a bug after replaying the exact action trace in a fresh browser context
  with the LLM **out of the loop** and observing the same failure signature.
  False positives are the product-killer; this layer is the moat.
- **Positioning (softened — never "free forever"):** "Runs on the Claude
  subscription you already have — today, subject to Anthropic's usage limits
  and policies, which can change. Prefer metered billing? Bring your own
  Anthropic API key with one config line." Market on caught-bugs-with-proof,
  not on cost.

## Compliance box (load-bearing — from NIGHTSHIFT-QA-TOS-BRIEF.md)

1. **BYO-subscription mode** spawns the buyer's OWN unmodified official
   `claude` CLI (`claude -p`, print mode) as a subprocess. NightShift **never
   reads, stores, logs, or transmits** OAuth tokens or any file under
   `~/.claude/`. No Agent SDK under subscription credentials. No harness
   spoofing. The CLI owns its own login. The subprocess runs from an empty
   temp cwd with `--setting-sources project` and a billing-var-stripped env,
   so the buyer's hooks/settings/memory never execute or leak into QA turns
   (their CLI login, of course, still applies — that is the mode).
2. **API-key mode** is a first-class config toggle (`brain.mode: "api-key"`),
   calling `https://api.anthropic.com/v1/messages` with the buyer's own key
   from an env var. Switching modes is a config edit, not a rewrite.
3. **Never hosted, never pooled.** Execution is 100% local to the buyer's
   machine. There is no server component that touches any Claude credential;
   the bundled console is a localhost report viewer only.
4. Conservative default budgets (see `budget`) keep subscription-mode usage
   inside "ordinary individual usage" territory; the docs tell buyers they are
   responsible for their own Anthropic account and limits (TERMS.md).
5. Telemetry: none. NightShift makes no network calls except to the target
   app under test and (in api-key mode) api.anthropic.com.

## Repository layout (each file owned by exactly one build agent)

```
nightshift/
  package.json            # name nightshift-qa, bin.nightshift, dep playwright, npm test = node --test tests/
  DESIGN.md               # this file
  README.md               # agent E — pitch (softened), quickstart, architecture, compliance box
  TERMS.md                # agent E — buyer-facing terms/disclaimer per ToS brief
  bin/nightshift.mjs      # agent E — CLI entry
  lib/config.mjs          # agent E — load/validate/default config
  lib/doctor.mjs          # agent E — environment checks
  lib/brain/index.mjs     # agent A — createBrain(config) dispatcher
  lib/brain/claude-cli.mjs# agent A — subscription mode driver
  lib/brain/api-key.mjs   # agent A — Anthropic Messages API driver
  lib/brain/mock.mjs      # agent A — deterministic scripted brain (tests/demo)
  lib/brain/prompts.mjs   # agent A — system prompt + turn prompt builders + JSON extraction
  lib/budget.mjs          # agent A — call/time/session budget guard
  lib/explorer.mjs        # agent B — Playwright session driver (the hands)
  lib/oracles.mjs         # agent B — deterministic failure detectors (the eyes)
  lib/elements.mjs        # agent B — interactive-element enumeration + stable locator descriptors
  lib/trace.mjs           # agent B — TraceRecorder + locator resolution for replay
  lib/session.mjs         # agent B — orchestrates one QA session end to end
  lib/reverify.mjs        # agent C — fresh-context deterministic replay + verdicts
  lib/signature.mjs       # agent C — failure signature normalization + matching
  lib/reprogen.mjs        # agent C — standalone repro script generator
  lib/report.mjs          # agent D — report.json/report.md/screenshot writer
  lib/runstore.mjs        # agent D — run directory management (.nightshift/<runId>/)
  console/server.mjs      # agent D — localhost report console :4184 (+ /api/health + 4 security headers)
  console/page.mjs        # agent D — HTML rendering for console (server-side strings, zero client deps)
  demo-app/server.mjs     # agent D — "Bugbox" seeded-bug target app :4185
  examples/nightshift.config.json  # agent E
  tests/*.test.mjs        # each agent writes tests for its own modules; agent E writes tests/e2e.test.mjs
```

## Config (`nightshift.config.json`, loaded by lib/config.mjs)

```json
{
  "target": {
    "name": "My App",
    "url": "http://localhost:3000",
    "routes": ["/"],
    "maxRoutes": 12,
    "actionsPerPage": 6
  },
  "brain": {
    "mode": "subscription-cli",
    "model": "sonnet",
    "cliPath": null,
    "apiKeyEnv": "ANTHROPIC_API_KEY",
    "apiModel": "claude-sonnet-5",
    "maxOutputTokens": 2048
  },
  "budget": {
    "maxLlmCalls": 40,
    "maxMinutes": 45,
    "maxSessionsPerNight": 4,
    "stopAtHour": 6
  },
  "oracles": {
    "expectedStatuses": [401, 403],
    "ignoreConsole": ["ResizeObserver loop", "\\[HMR\\]", "Download the React DevTools"]
  },
  "reverify": { "replays": 2, "requiredPasses": 2, "navTimeoutMs": 15000 },
  "report": { "dir": ".nightshift" }
}
```

`loadConfig(path?) -> config` merges user file over these exact defaults and
throws `ConfigError` with a human message on invalid shapes.
`brain.mode` ∈ `"subscription-cli" | "api-key" | "mock"`.

### Cross-module plumbing shapes (pinned)
- `log`: a single function `(level, message) => void`, levels
  `"info" | "warn" | "error"`; default `(l, m) => console.error("[" + l + "] " + m)`.
  Constructed by bin/nightshift.mjs, passed into runSession and reverifyFinding.
- `stats` (returned by runSession, consumed by writeReport):
  `{routesVisited, actionsExecuted, llmCalls, startedAt, endedAt, durationMs,
  usage: {inputTokens, outputTokens, costUsd|null}}` — session aggregates usage
  by summing every ask() result (including failed asks).
- `brainMeta` (writeReport input): `{mode, model}` from the createBrain return.

## Shared data shapes (pinned — do not extend without updating this doc)

### Action (brain proposes; explorer executes)
```json
{ "kind": "click" | "fill" | "select" | "press" | "goto" | "back",
  "elementId": 3,            // index into the ElementTable sent to the brain (click/fill/select/press)
  "value": "hello",          // fill/select value, press key name
  "url": "/cart",            // goto only (same-origin path or absolute same-origin URL)
  "why": "short reason" }
```

### ElementDescriptor (lib/elements.mjs)
```json
{ "id": 3, "role": "button", "name": "Add to cart", "tag": "button",
  "locator": { "strategy": "role", "role": "button", "name": "Add to cart", "nth": 0 },
  "disabled": false, "editable": false }
```
`locator.strategy` ∈ `"role" | "text" | "css"`. Enumeration prefers
role+accessible-name (`getByRole(role, {name, exact: true}).nth(nth)`); falls
back to `text`, then a computed unique `css` path. `resolveLocator(page, locator)`
in lib/trace.mjs turns a descriptor into a live Playwright locator — used by
BOTH explorer execution and reverify replay, so recording and replay can never
diverge.

### TraceStep (lib/trace.mjs)
```json
{ "i": 4, "kind": "click", "locator": { "strategy": "role", "role": "button", "name": "Add to cart", "nth": 0 },
  "value": null, "url": "http://localhost:4185/shop",
  "postUrl": "http://localhost:4185/shop", "ok": true, "error": null, "tMs": 231 }
```
For `goto`/`back`, `locator` is null and `value` holds the target URL.
`url` = page URL before the step. A trace ALWAYS starts with an implicit
step 0 `goto` of the session's entry route. `settle` (required) records what
the post-action wait observed: `{ "condition": "networkidle" | "timeout",
"waitedMs": 800 }` — replay waits AT LEAST `waitedMs` (see executeStep).

### FailureEvent (lib/oracles.mjs — one per detected failure)
```json
{ "oracle": "console-error" | "page-error" | "network-5xx" | "network-4xx" |
            "request-failed" | "dead-link" | "nav-failure",
  "message": "TypeError: total is not a function",
  "url": "http://localhost:4185/shop",
  "detail": { "status": 500, "method": "GET", "requestUrl": "/api/flaky" },
  "atStep": 4, "ts": 1700000000000 }
```
Pinned oracle API (consumed by BOTH session and reverify — must match exactly):
```js
attachOracles(context, { origin, oraclesConfig }) -> {
  events,        // FailureEvent[] — live array, appended in detection order
  setStep(i),    // caller stamps BEFORE executing each step; events get atStep from the last setStep
  dispose()      // detach all listeners
}
```
Listeners: `console` type=error, `pageerror`, `requestfailed`, `response` with
status>=400 same-origin, navigation failures. **Noise filters (load-bearing —
false positives kill the product):**
- `request-failed` and `network-4xx` count ONLY fetch/xhr resource types (a
  missing favicon is noise; a failing API call is signal), and `request-failed`
  EXCLUDES the navigation-abort family (`net::ERR_ABORTED` and friends — a
  click that navigates while fetches are in flight is normal, and it replays
  perfectly, so it would sail through reverify as a confirmed non-bug).
- Statuses in `oracles.expectedStatuses` (default 401/403 — auth probes are
  expected app behavior) never fire ANY response oracle family: `network-4xx`,
  `network-5xx`, or `dead-link` (a login-gated link landing on 403, or a
  declared-expected 503, is not a bug).
- Console messages matching any `oracles.ignoreConsole` regex are dropped
  (shipped defaults: ResizeObserver loop, HMR banners, React DevTools nag).
- Chromium NETWORK-LOG console entries (`Failed to load resource: ...`) are
  dropped by the console-error oracle: they would bypass the fetch/xhr-only
  and expectedStatuses filters above (missing favicon → major console-error).
  Failed loads are the network oracles' job, with their filters applied.
- `dead-link` fires only when navigation lands on status >= 400 AND the
  destination came from a real anchor href or a configured seed route — never
  from a brain-invented free-form `goto` (the brain guessing /admin and getting
  a 404 is not a bug in the buyer's app). The allow-list is keyed by
  pathname+search (a harvested `/product?id=1` must not whitelist a
  brain-invented `/product`) and is checked against the redirect chain's
  ORIGINAL request URL, so a real anchor that redirects to a 404 still fires.
- A fetch/xhr **400 against an auth-shaped endpoint** (`AUTH_PATH_RE`:
  auth/login/signup/register/password/reset/verify/session/… as a path
  segment) never fires `network-4xx`: a 400 there is the server correctly
  rejecting invalid input (empty signup fields, malformed email), not a bug.
  Narrowly scoped — only status 400, only the fetch/xhr family (a 400 DOCUMENT
  dead-link on an auth page still fires), and the regex is precise (`/api/authors`
  and `/blog/password-tips` do NOT match). Distinct from `expectedStatuses`,
  which already covers 401/403 for every response family.

### Finding
```json
{ "id": "NS-001", "source": "oracle:console-error" | "brain:semantic",
  "title": "Add to cart crashes with TypeError",
  "severity": "critical" | "major" | "minor",
  "signature": "console-error|/shop|typeerror: total is not a function",
  "failure": { /* FailureEvent, null for brain:semantic */ },
  "semantic": { "expected": "...", "actual": "..." },
  "trace": [ /* TraceStep[] from session entry through the failing step */ ],
  "evidence": { "screenshot": "shots/NS-001.png", "consoleTail": ["..."], "url": "..." },
  "status": "candidate" | "confirmed" | "flaky" | "unconfirmed" | "unverifiable",
  "reverify": { "replays": 2, "reproduced": 2, "verdicts": ["reproduced","reproduced"], "minimized": true, "reproScript": "repro/NS-001.mjs" }
}
```
`brain:semantic` findings with no mechanical assertion (no oracle event and no
text assertion the replayer can check) get `status: "unverifiable"` and are
segregated in the report — NightShift never presents them as confirmed. When
the brain flags a semantic finding it MUST include
`"check": { "kind": "text-present" | "text-absent", "selector": "css or null (whole page)", "text": "NaN" }`
— the deterministic assertion reverify will replay. Findings whose check the
brain cannot express are unverifiable by definition.

### Signature (lib/signature.mjs)
`buildSignature(failureEventOrSemanticCheck) -> string` of form
`<oracle-or-check-kind>|<subject>|<normalized-message>`, where `<subject>` is:
- for `network-5xx` / `network-4xx` / `request-failed` / `dead-link`: the
  normalized **request URL pathname + method + status** (two distinct failing
  endpoints triggered from the same page are two distinct bugs — keying on the
  page URL would merge them and cross-confirm the wrong one). Page pathname
  stays in evidence only.
- for `console-error` / `page-error` / `nav-failure` / semantic checks: the
  page URL pathname. For `console-error` the pathname of the failing
  script/resource (Chromium reports it only in `msg.location()`, captured as
  `detail.location`, line number dropped) is folded into the subject — two
  distinct sources with identical messages are two distinct bugs; merging them
  would let reverify cross-confirm the wrong one.
Normalization: lowercase; strip query strings; replace uuids, hex ids >= 8
chars, timestamps, and all integers >= 3 digits with `#`; collapse whitespace;
truncate 200 chars. `signaturesMatch(a, b) -> boolean` is exact string equality
of built signatures (already normalized). ALL functions in signature.mjs must
be **dependency-free and self-contained** (no imports, no closures over module
state) — reprogen embeds them into generated repro scripts via `.toString()`,
and a parity test asserts byte-identical behavior (see tests).

## Module contracts

### lib/brain/index.mjs (agent A)
```js
createBrain(config, deps?) -> {
  mode, model,                       // strings for the report header
  ask(turn) -> Promise<{ ok, json, rawText, usage: { inputTokens, outputTokens, costUsd, durationMs } }>,
  close() -> Promise<void>
}
```
`turn` = `{ system, user }` strings built by prompts.mjs. `ask` sends ONE
stateless prompt (no conversation memory — each turn re-sends compact context;
determinism and ToS-friendliness beat token elegance here) and extracts the
first JSON object from the reply (`extractJson(text)` in prompts.mjs — fenced
block first, then first balanced `{...}`; returns null on failure).

**ask() NEVER rejects.** On ANY failure — spawn error, inactivity kill,
non-zero exit, `is_error:true`, unparseable output, fetch/network error — it
resolves `{ok:false, json:null, rawText:<error detail>, usage:<parsed usage if
available, else zeros>}`. Callers treat `ok:false` as a skipped turn, never a
crash (one CLI hiccup must not kill an overnight session). A budget call is
consumed on failed asks too (the tokens were likely spent).

**claude-cli.mjs**: spawns `[cliPath, "-p", user, "--output-format", "json",
"--model", model, "--append-system-prompt", system, "--strict-mcp-config",
"--setting-sources", "project",
"--disallowedTools", "Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,Task,Read,Grep,Glob"]`
with `stdio: ["ignore","pipe","pipe"]` and a 120s inactivity kill.

**Isolation (load-bearing, all three parts):**
1. `cwd` = a freshly created empty temp directory OUTSIDE any repo
   (`fs.mkdtemp(path.join(os.tmpdir(), "nightshift-"))`, created once per brain,
   removed on close). The CLI walks UP from cwd for project context — a cwd
   inside the buyer's repo (like the run dir, which lives at
   `<their-project>/.nightshift/`) would load their CLAUDE.md, project
   settings, and HOOKS, executing buyer shell hooks ~160×/night unattended.
2. `--setting-sources project` — excludes user-level ~/.claude/settings.json
   and user CLAUDE.md memory (verified load-bearing on CLI 2.1.195 in the
   vidi-chat reference). With an empty temp cwd there are no project settings
   either: clean slate. (The buyer's own CLI auth/login of course still
   applies — that is the point of the mode.)
3. Child env strips ALL billing/routing overrides in subscription mode (the
   pinned list is `STRIPPED_BILLING_ENV_VARS` in claude-cli.mjs:
   ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL,
   ANTHROPIC_BEDROCK_BASE_URL, ANTHROPIC_VERTEX_BASE_URL,
   ANTHROPIC_CUSTOM_HEADERS, CLAUDE_CODE_USE_BEDROCK, CLAUDE_CODE_USE_VERTEX)
   — an exported ANTHROPIC_API_KEY would silently flip the CLI to metered API
   billing, and an inherited base-URL/Bedrock/Vertex setting would silently
   reroute every turn to a non-Anthropic endpoint or a cloud account: the
   exact billing-surprise and phone-home outcomes the two-mode design and the
   telemetry guarantee exist to prevent. doctor warns on any of them.

Parses the single JSON result object (`{result, usage, total_cost_usd,
is_error}` — verified shape on CLI 2.1.195) — and parses stdout even when the
exit code != 0: on API errors the CLI exits 1 but STILL prints a complete JSON
result with `is_error:true` and the human message in `.result`; that detail
belongs in `rawText`, not the trash. cliPath resolution: `config.brain.cliPath`
→ `which claude` on PATH → `~/.local/bin/claude`. NEVER reads/logs/transmits
anything under `~/.claude/`.

**api-key.mjs**: `fetch POST https://api.anthropic.com/v1/messages`, headers
`x-api-key: process.env[apiKeyEnv]`, `anthropic-version: 2023-06-01`; body
`{model: apiModel, max_tokens: maxOutputTokens, system, messages:[{role:"user",content:user}]}`.
Usage from `response.usage`; costUsd null (unknown pricing → report shows tokens).
Key is read at call time from env, never written anywhere (not into config,
reports, or logs).

**mock.mjs**: `createMockBrain(script)` — array of canned JSON replies popped
per ask; when exhausted returns `{done: true}`. Exported for tests AND used by
`--brain mock` for the free demo run.

**prompts.mjs**: `buildSystemPrompt()` (QA persona: propose ONE action or flag
findings; reply ONLY with JSON); `buildTurnPrompt({pageUrl, title, elements,
recentFailures, visitedUrls, remainingActions, pageTextExcerpt})`;
brain reply schema (documented in the prompt):
```json
{ "action": { ...Action } , "findings": [ { "title", "severity", "expected", "actual",
  "check": { "kind": "text-present", "selector": null, "text": "NaN" } } ], "done": false }
```

### lib/budget.mjs (agent A)
Two scopes, two factories (pure, injectable clock for tests):
- `createSessionBudget(config.budget, clock?) -> { tryConsumeCall() -> boolean,
  timeLeft() -> boolean, summary() -> {llmCalls, minutes} }` — `maxLlmCalls`
  and `maxMinutes` are PER SESSION; the overnight loop creates a fresh one per
  session.
- `createNightBudget(config.budget, clock?) -> { sessionAllowed(nSessionsSoFar)
  -> boolean, beforeStopHour() -> boolean }` — created ONCE by `overnight`.
  `beforeStopHour()` wraps midnight: false when `hour >= stopAtHour && hour <
  12`, true otherwise (a run starting 23:00 with stopAtHour 6 runs through
  midnight and stops at 06:00). This formula only expresses MORNING stop
  hours, so config.mjs validates `stopAtHour` as 0-11 — for 12-23 the stop
  window would be empty and the setting silently ignored.

### lib/elements.mjs / lib/explorer.mjs / lib/session.mjs (agent B)
- `enumerateElements(page, max=30) -> ElementDescriptor[]` — visible, enabled
  interactive elements (button/link/input/select/textarea + role=button/link),
  deduped, stable ordering (document order).
- `executeAction(page, action, elements, {origin}?) -> TraceStep` — maps the
  brain Action to a TraceStep (resolving elementId → locator descriptor,
  same-origin guard on goto — validated against the configured target `origin`
  when provided, since the current page may be foreign after an external-link
  click) and delegates execution to `executeStep`. Never throws (failure
  recorded in the step).
- `executeStep(page, step, {navTimeoutMs}) -> {ok, error, settle}` — lives in
  **lib/trace.mjs next to resolveLocator and is the ONLY code that performs a
  step**: resolve locator → Playwright call with 5s action timeout → settle
  wait. Settle: wait for `networkidle` OR 1500ms cap, whichever first,
  recording `{condition, waitedMs}`; when the step being executed carries a
  recorded `settle` (replay), wait AT LEAST `max(recorded.waitedMs, observed)`
  so a fast replay can't observe less of the world than the recording did.
  Explorer and reverify both call it; reprogen inlines its logic verbatim into
  generated scripts. Recording and replay share one execution path — they
  cannot diverge.
- `runSession({config, brain, runDir, log, mintId?}) -> { findings: Finding[],
  stats }` — the orchestrator: launch chromium (headless), fresh context,
  attach oracles, visit seed routes; per page loop: enumerate → buildTurnPrompt
  → brain.ask → execute action → collect FailureEvents → snapshot findings
  (screenshot at detection); respects budget on every brain call; dedupes
  candidates in-session by signature; discovered same-origin links append to
  the route frontier up to maxRoutes. Returns candidates (status "candidate")
  — session does NOT reverify; caller wires that (separation keeps replay
  LLM-free). Hardening rules (pinned):
  - `mintId` (optional, `createIdMinter()` default) mints NS-nnn ids; the
    overnight loop passes ONE shared minter so ids/screenshots/repro paths
    never collide across sessions aggregating into one run dir.
  - each route ends with a 2s oracle grace + final drain (mirrors reverify's
    GRACE_MS) so a slow failing response from the route's last action attaches
    to the trace that triggered it, and it runs even when the budget ends the
    session mid-route.
  - `executeAction` receives the TARGET origin: goto is validated against it
    (not the current page, which may be foreign), and after any action that
    leaves the page off-origin the session records a recovery goto back to the
    route instead of exploring the foreign site.

### lib/reverify.mjs / lib/reprogen.mjs (agent C)
- `reverifyFinding(finding, {config, log}) -> Finding` — for each of
  `config.reverify.replays`: fresh browser context (LLM never involved),
  replay `finding.trace` via the shared `executeStep`, attach oracles
  (`setStep` before each step), and after the final step wait a fixed 2s grace
  window then run one final oracle/check pass (slow responses must not decide
  verdicts). Check: oracle findings → `signaturesMatch(built, finding.signature)`;
  semantic findings → evaluate `check`. **Semantic check semantics (pinned):
  case-SENSITIVE substring match on `innerText` of the selector's element (or
  the full body when selector is null — last resort); the brain is instructed
  to supply the fullest stable fragment ("Total: NaN", never bare "NaN", which
  would match "Banana"); the matched excerpt ±80 chars is recorded as evidence.
  A non-null selector that resolves NOTHING proves nothing — the replay is
  not-reproduced (a typo'd/renamed selector must not vacuously confirm a
  text-absent check on a healthy page; absence-of-element bugs use
  selector:null body scope).**
  Verdict per replay: "reproduced" | "not-reproduced" | "replay-broken" (a step
  itself failed to execute — e.g. element gone). Status: reproduced count >=
  requiredPasses → `confirmed`; some but < required → `flaky`; zero → `unconfirmed`;
  all replays replay-broken → `unverifiable`.
- **Nav-only control (text-present static-copy guard):** a brain-proposed
  `text-present` check can name text that is ALWAYS on the page (a headline/CTA
  like "Open the planner"), so it "reproduces" on any healthy load and an
  interaction trace proves nothing. When a `text-present` finding reproduces AND
  its trace contains a real interaction (kind ∉ {goto, back}), reverify runs a
  control: fresh context, replay ONLY the goto/back steps through the same
  `executeStep` path, same 2s grace, then `evaluateCheck`. If the check also
  matches on the control the text is static page copy → the reproduced verdicts
  become "control-matched" (finding NOT confirmed, excerpt dropped). Goto-only
  traces skip the control (it would equal the replay — a bug visible on plain
  load, like the demo-app "Deals unavailable right now.", must still confirm);
  `text-absent` checks are unaffected. Mirrored verbatim into the generated
  repro script (parity-tested end-to-end).
- **Minimization** (v1, deterministic): before final replays, try the shortest
  suffix of the trace that starts at the most recent `goto` step; if that
  suffix reproduces once, adopt it as `finding.trace` and set `minimized: true`.
- `generateReproScript(finding, config) -> string` — a standalone `.mjs` file
  (imports only `playwright`), replays the trace, asserts the signature/check,
  exits 0 on reproduce / 1 on not — written to `<runDir>/repro/<id>.mjs` by the
  report layer. Buyers attach it to tickets; CI can run it as a regression test.
  Signature normalization inside the script is NOT hand-copied: reprogen embeds
  the actual `signature.mjs` functions via `.toString()` (they are pinned
  dependency-free for exactly this) — drift between the report's verdict and
  the repro script's verdict is a buyer-visible self-contradiction in the trust
  artifact. A parity test asserts embedded vs imported output is identical.

### lib/report.mjs / lib/runstore.mjs / console + demo-app (agent D)
- `createRun(config) -> { runId, runDir }` — `.nightshift/<YYYYMMDD-HHmmss>/`
  with `shots/`, `repro/`. `latest.json` pointer updated at finalize.
- `writeReport(runDir, {config, findings, stats, brainMeta}) ->
  {jsonPath, mdPath}` — report.json (full data) + report.md (human bug reports:
  title, severity badge, status, numbered ENGLISH repro steps derived from the
  trace, evidence excerpts, path to repro script + screenshot). Confirmed bugs
  first; flaky/unconfirmed/unverifiable in labelled sections. Header states
  brain mode/model + token usage + the softened positioning line. Markdown is
  a rendering context: every string that originated in the page under test
  (console text, element names, excerpts, URLs, fill values) is neutralized —
  newlines flattened, angle brackets entity-encoded, link brackets escaped,
  code fences sized to outrun any embedded backtick run — mirroring the
  console's escapeHtml discipline. reprogen is imported STATICALLY (require()
  of ESM only works on Node >= 22.12 while engines allows >= 22).
- `console/server.mjs`: `nightshift console` / `node console/server.mjs` —
  localhost:4184, zero deps. Routes: `/` (landing: product one-liner with the
  SOFTENED pitch + compliance bullets + run list), `/runs/<id>` (rendered
  report), `/api/health` (`{ok:true,service:"nightshift-console",runs:N}`,
  side-effect-free), 404 else. EVERY response sends the four headers:
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `Content-Security-Policy: default-src 'none';
  style-src 'unsafe-inline'; img-src 'self' data:`. Reads runs from `--data-dir`
  (default `<repo>/.nightshift`). Port via `--port`/`NIGHTSHIFT_CONSOLE_PORT`,
  default 4184. **Binds `127.0.0.1` EXPLICITLY** (`listen(port, "127.0.0.1")`)
  — a bare `listen(port)` binds 0.0.0.0 and exposes buyer-app bug evidence
  (screenshots, console tails) to the whole LAN, drifting out of the
  "never hosted" compliance box. Same rule for demo-app. Tested.
- `demo-app/server.mjs`: "Bugbox" (zero deps, binds 127.0.0.1) — port via
  `--port`/`BUGBOX_PORT`, default 4185, `--port 0` = ephemeral; on ready it
  prints exactly one line `BUGBOX LISTENING <port>` to stdout (the parent
  parses this — pinned protocol for e2e and `nightshift demo`). Also exports
  `startBugbox(port) -> {server, port, close()}` for in-process test use.
  Intentionally buggy shop — **UI pinned exactly** (agent E's demo mock script
  depends on these accessible names; do not rename):
  route `/` ("Bugbox") has buttons "Choose color", "Add to cart", "Load deals",
  "Apply coupon", a nav link "About" → `/about`, and a footer link
  "Warranty info" → `/warranty` (does not exist → 404).
  (1) "Add to cart" throws a TypeError (page-error oracle) but ONLY after
  "Choose color" was clicked first in the same page state (exercises
  multi-step traces);
  (2) "Load deals" fetches `/api/flaky` which always returns 500 (network-5xx);
  (3) "Warranty info" → 404 (dead-link, from a real anchor href);
  (4) "Apply coupon" renders `Total: NaN` into `#total` (semantic — the mock
  brain flags it with check `{kind:"text-present", selector:"#total",
  text:"Total: NaN"}`);
  (5) `/about` is clean and must produce ZERO findings (false-positive canary).
  Deterministic: no randomness, no time dependence, server state (if any) keyed
  per-context via cookie so replays in fresh contexts start clean.

### bin/nightshift.mjs + config/doctor/docs (agent E)
Commands (plain argv parsing, no deps):
- `nightshift init` — write `nightshift.config.json` (from examples/) into cwd.
- `nightshift doctor` — validates: config parses; target URL reachable;
  brain mode subscription-cli → cli found + `--version` exec ok, prints the
  ToS posture line ("uses YOUR login via the official CLI; NightShift never
  touches credentials"), and WARNS loudly if `ANTHROPIC_API_KEY` is exported
  ("stripped from the CLI subprocess so your key is never billed; use
  brain.mode api-key for metered billing"); api-key → env var present (never
  printed); playwright chromium launches. Exit 0/1 with a checklist.
- `nightshift run [--config path] [--brain mock]` — one session → reverify each
  candidate → report; prints summary table + report path. Exit 0 (clean run
  regardless of bugs found; bugs are the product, not an error), 2 on crash.
- `nightshift overnight` — sessions in a loop while budget.sessionAllowed &&
  before stopAtHour; aggregates into one run dir (one shared finding-id
  minter); same reporting. Per-session error containment: a session crash is
  logged and stops the loop, but the candidates from completed sessions are
  ALWAYS reverified and reported — one 3am hiccup must not discard the night.
- `nightshift verify <findingId> [--run <id>]` — re-run reverify for one
  finding from an existing report (buyer-facing trust command).
- `nightshift console [--port 4184]` — start the report console.
- `nightshift demo` — pinned lifecycle: spawn Bugbox with `--port 0`, parse the
  `BUGBOX LISTENING <port>` line (10s timeout), build an in-memory config
  `{target: {url: "http://127.0.0.1:<port>", routes: ["/"], ...defaults},
  brain: {mode: "mock"}}` with the demo mock script, run session → reverify →
  report, PRINT the report path (never auto-open), and kill the Bugbox child in
  a `finally` (SIGTERM, SIGKILL after 3s). THE 60-second first-touch
  experience; zero LLM cost.

### tests (each agent, `tests/<module>.test.mjs`)
- Unit: signature normalization table-driven; budget clock; config
  validation/defaults; prompts extractJson (fenced/bare/garbage); mock brain;
  trace locator resolution (JSDOM-free — use Playwright against demo-app);
  reprogen output is syntactically valid (`new Function` parse or `node --check`).
- brain drivers: claude-cli spawns a FAKE `claude` (tests/fixtures/fake-claude.mjs
  echoing a canned CLI-shaped JSON) via `cliPath` override — never the real CLI in
  tests; api-key driver against a local fetch stub via dependency injection.
  fake-claude additionally asserts, writing results to a side file the test
  reads: (a) its cwd at spawn time is under os.tmpdir() and NOT inside the test
  repo; (b) `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` are absent from its env;
  (c) argv includes `--setting-sources project`. Also test: non-zero-exit +
  valid `is_error` JSON on stdout still yields the parsed message in rawText,
  and ask() resolves `ok:false` (never rejects) on spawn failure and timeout.
- console + demo-app: assert `server.address().address === "127.0.0.1"`.
- reprogen parity: generate a script, extract/execute its embedded normalizer
  against a table of messages, assert byte-identical output vs buildSignature.
- e2e (agent E): boot Bugbox on an ephemeral port → `run --brain mock` with a
  scripted brain → assert: >= 3 confirmed findings (page-error, network-5xx,
  dead-link), NaN semantic finding confirmed via its text-present check, ZERO
  findings on /about, every confirmed finding has a repro script that exits 0
  when executed, report.md exists and contains no banned marketing strings
  (`free forever`, `zero marginal cost`, `unlimited`).

## Ship plan (after green tests + review)
git init → private repo `karoslab/nightshift` → DG register
(name "NightShift QA" → slug `nightshift-qa`, url http://localhost:4184,
paths `/`, contains "NightShift", api + headers REQUIRED, disable tls) →
launchd `com.karoslabs.nightshift` (console :4184, KeepAlive) → `dg-gate
nightshift-qa` exit 0 → add /ship map row → Discord #dev notify.
