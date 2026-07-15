# NightShift in CI

Run NightShift against a PR preview deploy on every pull request. By default it
runs the **deterministic sweep** (zero LLM, no API key) and fails the check only
when it finds a bug it can *deterministically reproduce* at or above a severity
floor. Findings — with runnable repro scripts — are uploaded as an artifact and
summarized in a single sticky PR comment.

## What CI mode does

`nightshift run --ci` (composes with `--sweep`):

- Writes `summary.json` next to `report.json` in the run directory — a small,
  machine-readable object (see [shape](#summaryjson)).
- Prints that same JSON to **stdout** (all human logs go to stderr), so a step
  can parse it directly.
- Exits **non-zero** when a *confirmed* finding is at or above
  `--severity-floor` (default `major`), **or** when exploration did not happen
  (a zero-finding report from an app that never loaded is a false green).
  Otherwise it exits `0`.

Only `confirmed` findings gate the build. `text-verified`, `flaky`, and
`unconfirmed` findings are reported but never fail the check — they are weaker
guarantees than a deterministic replay.

Severity ordering is `critical` > `major` > `minor`.

```bash
# Deterministic, no API key — the CI default:
nightshift run --config nightshift.config.json --ci --sweep

# Gate only on critical confirmed bugs:
nightshift run --config nightshift.config.json --ci --sweep --severity-floor critical
```

## The composite action

The repository ships a composite action at [`action.yml`](../action.yml).

| Input | Default | Description |
| --- | --- | --- |
| `target-url` | *(required)* | Full http(s) URL of the deploy to test (the PR preview URL). |
| `config` | `""` | Path to a `nightshift.config.json` in your repo. Optional. `target.url` and `report.dir` are always overridden by the action. |
| `severity-floor` | `major` | Fail when a confirmed finding is at/above this: `minor` \| `major` \| `critical`. |
| `brain` | `sweep` | `sweep` (deterministic, zero-LLM, **no key**) \| `subscription-cli` \| `api-key` \| `mock`. |
| `report-dir` | `.nightshift` | Where run output is written and uploaded from. |
| `artifact-name` | `nightshift-run` | Base name of the uploaded run-directory artifact. |
| `github-token` | `${{ github.token }}` | Token used to post/update the sticky PR comment. |
| `anthropic-api-key` | `""` | Only needed when `brain: api-key`. Exposed to NightShift as `ANTHROPIC_API_KEY`. |
| `comment` | `true` | Post/update the sticky PR comment. Ignored on non-`pull_request` events. |

The action:

1. Installs its own dependencies and a Chromium build.
2. Merges `target-url` / `report-dir` / `brain` over your (optional) base config.
3. Runs `nightshift run --ci`.
4. Uploads the run directory (report, repro scripts, screenshots) as an artifact.
5. Posts/updates **one** sticky PR comment summarizing the confirmed findings and
   their repro-script paths.
6. Fails the job with NightShift's exit code — *after* the artifact and comment
   steps run, so you always get the evidence even on a red build.

> **Routes must be relative.** Because the preview URL changes per PR, keep
> `target.routes` as paths (`["/", "/pricing"]`), not absolute URLs — absolute
> routes are validated against `target.url` and would fail on a new origin.

## Copy-paste workflow (Vercel / any preview deploy)

This triggers when a preview deployment finishes and reads the preview URL from
the `deployment_status` event — the provider-agnostic way to get a preview URL
(Vercel, Netlify, Render, Cloudflare Pages, and GitHub's own environments all
emit it).

```yaml
# .github/workflows/nightshift.yml
name: NightShift QA

on:
  deployment_status:

permissions:
  contents: read
  pull-requests: write   # post the sticky PR comment
  actions: read

jobs:
  nightshift:
    # Only run once the preview deploy is live.
    if: github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: NightShift QA
        uses: your-org/nightshift@v1   # or: ./ when vendored in-repo
        with:
          target-url: ${{ github.event.deployment_status.target_url }}
          severity-floor: major
          # brain: sweep  # default — deterministic, no API key needed
```

### Triggering on `pull_request` instead

If you deploy the preview yourself inside the workflow (rather than via a
provider integration), trigger on `pull_request` and pass the URL you produced:

```yaml
on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  nightshift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # ... your deploy step sets PREVIEW_URL ...

      - name: NightShift QA
        uses: your-org/nightshift@v1
        with:
          target-url: ${{ env.PREVIEW_URL }}
          config: nightshift.config.json
```

### Brain-driven runs (optional)

The default sweep needs no secrets. To let NightShift's LLM explorer drive the
session, set `brain: api-key` and provide the key as a secret:

```yaml
      - name: NightShift QA
        uses: your-org/nightshift@v1
        with:
          target-url: ${{ github.event.deployment_status.target_url }}
          brain: api-key
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

## summary.json

Written next to `report.json` and echoed to stdout:

```json
{
  "schemaVersion": 1,
  "runId": "20260715-030000",
  "generatedAt": "2026-07-15T03:00:00.000Z",
  "target": { "name": "Bugbox", "url": "https://preview-abc.example.com" },
  "runState": "healthy",
  "severityFloor": "major",
  "exitCode": 1,
  "pass": false,
  "counts": { "total": 3, "confirmed": 2, "text-verified": 0, "flaky": 0,
              "unconfirmed": 0, "unverifiable": 0, "candidate": 0 },
  "blocking": [
    {
      "id": "NS-001",
      "title": "page-error at /: cart.total is not a function",
      "severity": "critical",
      "status": "confirmed",
      "source": "oracle:page-error",
      "page": "https://preview-abc.example.com/",
      "reproScript": "repro/NS-001.mjs"
    }
  ]
}
```

`blocking` is exactly the set of findings that made the run fail; each carries a
`reproScript` path (relative to the run directory) you can run locally — every
repro script exits `0` when the bug reproduces.
