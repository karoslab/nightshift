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
- Point NightShift only at apps you own or are authorized to test.

## Current state and limitations

NightShift is version 0.1.0 and honest about its edges:

- **Web apps only.** It drives Chromium via Playwright. No mobile, no native, no
  desktop apps.
- **Exploration is shallow-to-medium depth.** It follows real anchors and
  configured routes, enumerates interactive elements, and takes a bounded number
  of actions per page (`actionsPerPage`, default 6). It is not a full crawler and
  will not find bugs behind long multi-step flows unless you seed those routes.
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

## Testing

```bash
npm test                          # full suite (247 tests)
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
