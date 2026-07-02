# NightShift QA

**The overnight QA employee that only files bugs it can prove.**

NightShift explores your web app while you sleep: a Claude brain proposes one
action at a time, deterministic oracles (console errors, page crashes, failing
API calls, dead links) watch every page, and — the part that actually matters —
a **repro-re-verification layer** replays every suspected bug in a fresh
browser context with the LLM completely out of the loop. A finding is only
marked **confirmed** after the exact recorded action trace reproduces the same
failure signature. No replay, no bug report.

Every confirmed bug ships with:

- a numbered, human-readable repro in `report.md`
- a screenshot taken at detection time
- a **standalone repro script** (`repro/NS-001.mjs`, plain Playwright, exits 0
  when the bug reproduces) you can attach to a ticket or run in CI as a
  regression test

An LLM that "found a bug" is worthless if it hallucinated. NightShift's
verdicts are earned deterministically, which is the entire point.

## Quickstart — the 60-second demo (no Claude account needed)

```bash
npm install
npx playwright install chromium
node bin/nightshift.mjs demo
```

`demo` boots **Bugbox**, a deliberately broken demo shop, on an ephemeral
localhost port, runs a full scripted session against it (mock brain, zero LLM
cost), re-verifies every candidate finding in fresh browser contexts, and
prints the path to the generated report. Open the report, read the confirmed
bugs, run a repro script. That is the whole product in miniature.

Then point it at your own app:

```bash
nightshift init      # writes nightshift.config.json — set target.url
nightshift doctor    # checks config, target reachability, brain auth, browser
nightshift run       # one session -> reverify candidates -> report
nightshift overnight # sessions in a loop, within budget, until the stop hour
```

## Two ways to bring the brain

NightShift never ships or pools credentials — you bring your own Claude, in
one of two modes (switching is a one-line config edit):

1. **`subscription-cli`** (default) — runs on the Claude subscription you
   already have — today, subject to Anthropic's usage limits and policies,
   which can change. NightShift spawns your own unmodified official `claude`
   CLI in print mode; the CLI owns its own login. Conservative default budgets
   keep usage in ordinary-individual territory.
2. **`api-key`** — the metered/business option. Set
   `"brain": { "mode": "api-key" }` and export your own Anthropic API key
   (`ANTHROPIC_API_KEY` by default). NightShift calls the Messages API
   directly and reports token usage per run. Predictable, meterable, yours.

You are responsible for your own Anthropic account, plan limits, and policy
compliance in both modes — see [TERMS.md](TERMS.md).

## Commands

| command | what it does |
|---|---|
| `nightshift init` | write `nightshift.config.json` into the current directory |
| `nightshift doctor` | environment checklist: config, target reachable, brain auth, chromium — exit 0/1 |
| `nightshift run [--config path] [--brain mock]` | one session → reverify each candidate → report (exit 0 even when bugs are found; bugs are the product) |
| `nightshift overnight` | sessions in a loop while the night budget allows and before `budget.stopAtHour` |
| `nightshift verify <findingId> [--run <id>]` | replay one finding from an existing report — the buyer-facing trust command |
| `nightshift console [--port 4184]` | localhost report viewer (binds 127.0.0.1 only) |
| `nightshift demo` | boot Bugbox + scripted session + report, then tear it all down |

## Architecture

```
        brain (proposes)                 oracles (observe)
  subscription-cli | api-key | mock      console-error / page-error / network-5xx
            |                            network-4xx / request-failed / dead-link
            v                                        |
  session ──> explorer ──> trace ────────────────────┤   candidates
  (one page loop: enumerate elements,                v
   ask brain for ONE action, execute,        reverify (LLM-free)
   record TraceStep, collect failures)       fresh context, replay trace,
            |                                match failure signature
            v                                        |
        runstore (.nightshift/<runId>/)              v
   report.json / report.md / shots/ / repro/   confirmed | flaky | unconfirmed | unverifiable
```

- **lib/session.mjs** orchestrates one QA session: visit seed routes, ask the
  brain for one action per turn, execute it, collect failure events, snapshot
  candidate findings with screenshots. The session never re-verifies — replay
  stays LLM-free by construction.
- **lib/trace.mjs** owns `executeStep`, the ONLY code that performs a step.
  Recording (explorer), replay (reverify), and generated repro scripts all run
  the same execution path, so they cannot diverge.
- **lib/reverify.mjs** replays each candidate in fresh browser contexts and
  issues verdicts. `confirmed` means the failure signature reproduced in at
  least `reverify.requiredPasses` of `reverify.replays` replays.
- **lib/signature.mjs** normalizes failure signatures (dependency-free — the
  exact same functions are embedded into generated repro scripts, with a
  parity test).
- **lib/reprogen.mjs** emits standalone Playwright repro scripts: exit 0 =
  reproduced, exit 1 = not.
- **lib/oracles.mjs** are the eyes, with load-bearing noise filters: only
  fetch/XHR failures count (a missing favicon is noise), expected auth
  statuses (401/403) never fire, navigation-abort races are excluded, and
  dead-links only count when they come from real anchors or configured routes.
- Brain-flagged **semantic findings** (wrong content, e.g. `Total: NaN`) must
  carry a deterministic text check to be verifiable; findings without one are
  segregated as `unverifiable` and never presented as confirmed.

## Compliance box

1. **BYO-subscription mode** spawns the buyer's OWN unmodified official
   `claude` CLI (`claude -p`, print mode) as a subprocess. NightShift **never
   reads, stores, logs, or transmits** OAuth tokens or any file under
   `~/.claude/`. No Agent SDK under subscription credentials, no harness
   spoofing. The CLI owns its own login. The subprocess runs from an empty
   temp cwd with `--setting-sources project` and a billing-var-stripped env,
   so the buyer's hooks/settings/memory never execute or leak into QA turns.
2. **API-key mode** is a first-class config toggle (`brain.mode: "api-key"`),
   calling `https://api.anthropic.com/v1/messages` with the buyer's own key
   from an env var. Switching modes is a config edit, not a rewrite.
3. **Never hosted, never pooled.** Execution is 100% local to the buyer's
   machine. No server component touches any Claude credential; the bundled
   console is a localhost report viewer only (binds 127.0.0.1 explicitly).
4. Conservative default budgets keep subscription-mode usage inside ordinary
   individual usage territory; buyers are responsible for their own Anthropic
   account and limits ([TERMS.md](TERMS.md)).
5. **Telemetry: none.** NightShift makes no network calls except to the target
   app under test and (in api-key mode) api.anthropic.com.

## Configuration

`nightshift init` writes this file; every key shown is the default:

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

Notes:

- `budget.maxLlmCalls` / `maxMinutes` apply **per session**;
  `maxSessionsPerNight` and `stopAtHour` bound the `overnight` loop (a run
  starting at 23:00 with `stopAtHour: 6` runs through midnight and stops at
  06:00).
- `oracles.expectedStatuses` — statuses your app returns on purpose (auth
  probes) that should never be filed as bugs.
- Point NightShift only at apps you own or are authorized to test.

## Testing

```bash
npm test                          # full suite
node --test tests/config.test.mjs # focused module tests
```

The flagship test (`tests/e2e.test.mjs`) boots Bugbox on an ephemeral port,
runs the whole pipeline with the scripted mock brain, and asserts confirmed
findings for a page crash, a 500ing API, a dead link, and a `Total: NaN`
semantic check — plus zero findings on Bugbox's clean `/about` page, and that
every confirmed finding's repro script exits 0.

## Terms

See [TERMS.md](TERMS.md). Short version: everything runs locally, NightShift
never touches your credentials, you are responsible for your own Anthropic
account and for only testing apps you are allowed to test.
