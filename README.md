# NightShift

**Overnight QA that only files bugs it can prove.**

NightShift is an overnight QA employee for your web app. It explores the app
while you sleep, watches every page with deterministic oracles, re-verifies
each suspected bug with the model out of the loop, and files a report of only
the bugs it could reproduce. Bring your own Claude or Anthropic API key; nothing
is hosted, nothing is pooled, everything runs on your machine.

What a run looks like (real output from `nightshift demo`):

```
NS-001: replay 1/2 -> reproduced
NS-001: replay 2/2 -> reproduced

NightShift findings
-------------------
NS-001   confirmed     critical  page-error at /: cart.total is not a function
NS-002   confirmed     critical  network-5xx at /api/flaky: HTTP 500 GET /api/flaky
NS-003   text-verified major     Applying a coupon renders "Total: NaN"
NS-004   confirmed     minor     dead-link at /warranty: navigation landed on HTTP 404

confirmed: 3  text-verified: 1
```

## How it works

A Claude brain proposes one action at a time. Deterministic oracles (console
errors, page crashes, failing API calls, dead links) watch every page. The part
that matters: a **repro-re-verification layer** replays every suspected bug in a
fresh browser context with the LLM completely out of the loop. A finding is only
marked **confirmed** after the exact recorded action trace reproduces the same
failure signature. No replay, no bug report.

Every confirmed bug ships with:

- a numbered, human-readable repro in `report.md`
- a screenshot taken at detection time
- a standalone repro script (`repro/NS-001.mjs`, plain Playwright, exits 0 when
  the bug reproduces) you can attach to a ticket or run in CI as a regression
  test

An LLM that "found a bug" is worthless if it hallucinated. NightShift's verdicts
are earned deterministically, which is the entire point.

## Quickstart: the demo (no Claude account needed)

```bash
npm install
npx playwright install chromium
node bin/nightshift.mjs demo
```

`demo` boots **Bugbox**, a deliberately broken demo shop, on an ephemeral
localhost port, runs a full scripted session against it (mock brain, zero LLM
cost), re-verifies every candidate finding in fresh browser contexts, and prints
the path to the generated report. Open the report, read the confirmed bugs, run
a repro script. That is the whole product in miniature.

Then point it at your own app:

```bash
node bin/nightshift.mjs init      # writes nightshift.config.json, set target.url
node bin/nightshift.mjs doctor    # checks config, target reachable, brain auth, browser
node bin/nightshift.mjs run       # one session, reverify candidates, report
node bin/nightshift.mjs overnight # sessions in a loop, within budget, until the stop hour
```

## Bring your own brain

NightShift never ships or pools credentials. You bring your own Claude, in one
of two modes (switching is a one-line config edit):

1. **`subscription-cli`** (default) — runs on the Claude subscription you already
   have, subject to Anthropic's usage limits and policies. NightShift spawns your
   own unmodified official `claude` CLI in print mode; the CLI owns its own login.
   Conservative default budgets keep usage in ordinary-individual territory.
2. **`api-key`** — the metered option. Set `"brain": { "mode": "api-key" }` and
   export your own Anthropic API key (`ANTHROPIC_API_KEY` by default). NightShift
   calls the Messages API directly and reports token usage per run.

You are responsible for your own Anthropic account, plan limits, and policy
compliance in both modes. See [TERMS.md](TERMS.md).

NightShift makes no network calls except to the target app under test and, in
api-key mode, `api.anthropic.com`. No telemetry. The bundled console is a
localhost report viewer that binds `127.0.0.1` only.

## Sweep mode (deterministic, no LLM)

The default explorer is Claude-guided and budgeted — it picks a handful of
actions per page. **Sweep mode** trades that judgement for exhaustive,
deterministic coverage with zero LLM calls:

```bash
node bin/nightshift.mjs run --sweep                 # deterministic exhaustive crawl
node bin/nightshift.mjs run --sweep --resume <runId> # continue an interrupted sweep
```

or pin it in config with `"target": { "sweep": true }`.

What a sweep does, per run:

- **Crawls every same-origin route** reachable from `target.routes` (BFS over
  real anchors) and deep-links each discovered route directly, up to
  `maxRoutes`.
- **Exercises every interactive element** on each route (no 30-element cap):
  clicks buttons/links, toggles checkboxes/radios, selects options, fills text
  fields — in stable DOM order, honoring `selectorDenylist` and
  `denyActionKinds` exactly as the explorer does.
- **Hits every form three ways**: an empty submit, a hostile submit (overlong +
  non-ASCII + script-tag payload), and a plausible valid submit derived from
  each field's type/name/placeholder (no LLM; a brain hook is left for later).
- **Opens, exercises, and closes modals** (close control, then Escape fallback)
  so an open overlay never masks the rest of the queue.
- **Tracks coverage** — elements found / exercised / skipped (denied) / failed
  per route — and writes a coverage block into `report.json` and a table into
  `report.md`.

Everything downstream is unchanged: the same oracles, the same repro-trace
recording, the same reverify pipeline, and the optional security loadout all
run identically. A sweep finding replays exactly like an explorer finding.
Budget guards still apply: `maxMinutes` is a hard stop, and the element queue is
checkpointed into the run dir after every element, so an interrupted sweep
resumes instead of restarting (`--resume <runId>`).

Sweep is deterministic, so it never surfaces brain-only semantic findings (e.g.
a `Total: NaN` that needs a human-style judgement) — it finds what the oracles
can prove.

## Authenticated roles

By default NightShift explores your app as an anonymous visitor. To cover
logged-in surfaces, declare **roles** under `target.auth`. On session start
NightShift logs in once per role, persists a Playwright `storageState` per role
under the run dir (`.nightshift/<runId>/auth/<role>.json`), and then runs
exploration, sweep, and journeys **once per role** — every finding is tagged
with the role that produced it. Anonymous remains the implicit default role and
always runs; a role whose login fails is skipped with a warning, never
discarding the anonymous pass.

```json
"target": {
  "auth": {
    "roles": [
      {
        "name": "member",
        "loginUrl": "/login",
        "usernameEnv": "NIGHTSHIFT_MEMBER_USER",
        "passwordEnv": "NIGHTSHIFT_MEMBER_PASS",
        "totpSecretEnv": "NIGHTSHIFT_MEMBER_TOTP",
        "steps": [
          { "action": "fill", "selector": "#username", "valueFrom": "username" },
          { "action": "fill", "selector": "#password", "valueFrom": "password" },
          { "action": "fill", "selector": "#otp", "valueFrom": "totp" },
          { "action": "click", "selector": "button[type=submit]" }
        ]
      }
    ]
  }
}
```

- **Credentials never live in config.** `usernameEnv` / `passwordEnv` /
  `totpSecretEnv` are the **names** of environment variables; NightShift reads
  the values from your environment at runtime and never stores, logs, or writes
  them into a finding, repro script, or the report. (Login steps deliberately do
  not build a replayable trace, so a filled password can't leak downstream.)
- **`steps`** is a selector-based `fill`/`click`/`goto`/`press`/`select` script.
  A `fill` uses `valueFrom` (`username` | `password` | `totp`) to inject a
  secret, or a literal `value` for non-secret fields. `totpSecretEnv` enables
  RFC 6238 TOTP MFA — NightShift generates the current code at login time.
- **`setupScript`** is an alternative to `steps`: a path to a module exporting a
  default `async ({ page, context, env, origin }) => {}` for logins the step DSL
  can't express (OAuth popups, custom SSO).
- **`nightshift doctor`** validates auth end to end: every declared credential
  env var is present, each role actually logs in, and its `storageState` comes
  back non-empty.

## Journeys (deterministic critical paths)

Exploration is stochastic; **journeys** are the paths you refuse to ship broken.
A journey is a fixed list of steps run every session with all oracles watching.
It executes through the same recording/replay path as the explorer, so a failed
step or an oracle hit becomes an ordinary candidate finding that flows through
reverify and repro exactly like any other — a confirmed journey bug ships with a
standalone repro script too.

```json
"target": {
  "journeys": [
    {
      "name": "checkout completes",
      "steps": [
        { "action": "goto", "url": "/cart" },
        { "action": "click", "selector": "#checkout" },
        { "action": "fill", "selector": "#card", "value": "4242424242424242" },
        { "action": "click", "selector": "#place-order", "expect": { "textPresent": "Order confirmed" } }
      ]
    }
  ]
}
```

- Each step is `goto` (with `url`) or `click`/`fill`/`select`/`press` (with a CSS
  `selector` and optional `value`).
- An optional `expect` asserts `urlIncludes`, `textPresent`, or `textAbsent`
  (with an optional `selector` to scope the text check). A failed text
  expectation becomes a text-verified finding; a step that fails to execute, or
  an oracle that fires mid-journey (page crash, 5xx, dead link), becomes a
  candidate that reverify can confirm.
- Journeys run **per role**, so a checkout journey runs under each authenticated
  role you declared as well as anonymous.

## Architecture

```
        brain (proposes)                 oracles (observe)
  subscription-cli | api-key | mock      console-error / page-error / network-5xx
            |                            network-4xx / request-failed / dead-link
            v                                        |
  session --> explorer --> trace --------------------+   candidates
  (one page loop: enumerate elements,                v
   ask brain for ONE action, execute,        reverify (LLM-free)
   record TraceStep, collect failures)       fresh context, replay trace,
            |                                match failure signature
            v                                        |
        runstore (.nightshift/<runId>/)              v
   report.json / report.md / shots/ / repro/   confirmed | flaky | unconfirmed | unverifiable
```

- **lib/session.mjs** orchestrates one QA session and never re-verifies, so
  replay stays LLM-free by construction.
- **lib/trace.mjs** owns `executeStep`, the ONLY code that performs a step.
  Recording, replay, and generated repro scripts all run the same path, so they
  cannot diverge.
- **lib/reverify.mjs** replays each candidate in fresh browser contexts and
  issues verdicts. `confirmed` means the failure signature reproduced in at least
  `reverify.requiredPasses` of `reverify.replays` replays.
- **lib/signature.mjs** normalizes failure signatures (dependency-free, embedded
  verbatim into generated repro scripts, with a parity test).
- **lib/oracles.mjs** are the eyes, with load-bearing noise filters: only
  fetch/XHR failures count, expected auth statuses (401/403) never fire,
  navigation-abort races are excluded.
- **lib/security/** is an optional, off-by-default defensive check set (missing
  security headers, insecure cookie flags, mixed content) that reuses the same
  re-verification and scope-containment discipline. See
  [PLAN-security-loadout.md](PLAN-security-loadout.md).

## Configuration

`nightshift init` writes `nightshift.config.json`; every key shown is the
default. See [examples/nightshift.config.json](examples/nightshift.config.json).

- `budget.maxLlmCalls` / `maxMinutes` apply per session; `maxSessionsPerNight`
  and `stopAtHour` bound the `overnight` loop. `stopAtHour` is a morning hour
  (0-11); the config loader rejects afternoon/evening values.
- `oracles.expectedStatuses` are statuses your app returns on purpose that should
  never be filed as bugs.
- `target.sweep` (default `false`) switches the run into deterministic sweep mode
  (see [Sweep mode](#sweep-mode-deterministic-no-llm)); `--sweep` sets it for one
  run without editing config.
- `target.auth.roles` (default `[]`) declares authenticated roles to explore in
  addition to anonymous (see [Authenticated roles](#authenticated-roles)).
- `target.journeys` (default `[]`) declares deterministic critical paths run
  every session (see [Journeys](#journeys-deterministic-critical-paths)).
- Point NightShift only at apps you own or are authorized to test.

## Current state and limitations

NightShift is version 0.1.0 and honest about its edges:

- **Web apps only.** It drives Chromium via Playwright. No mobile, no native, no
  desktop apps.
- **Exploration is shallow-to-medium depth by default.** The Claude-guided
  explorer follows real anchors and configured routes, enumerates interactive
  elements, and takes a bounded number of actions per page (`actionsPerPage`,
  default 6). It will not find bugs behind long multi-step flows unless you seed
  those routes. For exhaustive, LLM-free coverage instead, use
  [sweep mode](#sweep-mode-deterministic-no-llm) (`--sweep`).
- **The bug classes are fixed.** Console errors, page crashes, 4xx/5xx API calls,
  request failures, dead links, and brain-flagged semantic findings that carry a
  deterministic text check. Anything the oracles do not watch, it does not find.
- **Semantic findings need a deterministic check to be confirmed.** A finding the
  brain flags without a machine-checkable assertion is segregated as
  `unverifiable` and never presented as confirmed.
- **Subscription-cli mode depends on Anthropic's policies**, which can change.
  Budgets are conservative but you own your account and limits.
- **Single-machine, single-operator.** No hosting, no fleet, no dashboard beyond
  the localhost report viewer.
- **Reproduction is best-effort against nondeterministic apps.** Findings that do
  not replay a required number of times are marked `flaky`, not `confirmed`, by
  design. Highly nondeterministic UIs will surface fewer confirmed bugs.
- **Sweep mode's modal handling is hygiene, not deep coverage.** Sweep opens,
  exercises, and closes overlays so they don't mask the queue, but a modal
  control's click is deliberately not recorded onto the replayable trace (it has
  no stable locator). A bug that *only* a modal-inner control triggers is
  therefore collected but will not reproduce on reverify, so it stays
  `unconfirmed` rather than being filed — a conservative trade (no false
  positives) until modal controls get stable, replayable locators. Reach those
  flows with the Claude-guided explorer or a seeded route instead.

## Testing

```bash
npm test                          # full suite (298 tests)
node --test tests/config.test.mjs # focused module tests
```

The flagship test (`tests/e2e.test.mjs`) boots Bugbox on an ephemeral port, runs
the whole pipeline with the scripted mock brain, and asserts confirmed findings
for a page crash, a 500ing API, a dead link, and a `Total: NaN` semantic check,
plus zero findings on Bugbox's clean `/about` page, and that every confirmed
finding's repro script exits 0.

## Contributing and security

- [CONTRIBUTING.md](CONTRIBUTING.md) for how to build and send changes.
- [SECURITY.md](SECURITY.md) to report a vulnerability privately.

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Terms of use in
[TERMS.md](TERMS.md).
