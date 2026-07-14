# NightShift open-source launch kit

Ordered launch-day checklist for taking NightShift public under MIT. Owner
labels: **AGENT** = done in the `feat/oss-launch-kit` PR, **KARTHIK-ONLY** =
requires a human (GUI, account, publishing, or a judgment call).

## Pre-publication security sweep

Swept the tree for secrets, machine-layout paths, internal webhooks, and
personal data. Results:

**Fixed in this PR (AGENT):**

- `ops/com.karoslabs.nightshift.plist` leaked absolute machine paths
  (`/Users/karthik/...`, `/Users/karthik/karoslabs/ops/logs/...`). Replaced with
  `ops/com.nightshift.example.plist` using `/path/to/nightshift` and
  `/path/to/node` placeholders and install instructions.
- `scripts/dry-run-vidi.mjs` was an internal adversarial harness targeting the
  private `vidi-chat` product (port 4199, references a non-shipped
  `setup-isolated-vidi.sh`). Removed from the tree. No test depended on it.
- `tests/trace.test.mjs` used the literal fill value `"karthik"`. Genericized to
  `"tester"`.

**Reviewed, no action needed (AGENT):**

- `tests/doctor.test.mjs` contains `sk-ant-test-should-never-print`. This is a
  fixture that asserts the doctor never prints a secret; it is not a real key.
  Kept intentionally.
- `.gitignore` already excludes `GTM/`, `ops/logs/`, `UNDERSTOOD-*.md`,
  `.nightshift/`, `.nightshift-*/`, `undefined/`, `.env*`, `*.pem`, `*.p12`.
  Confirmed none of those are tracked.
- No API keys, private keys, Discord/Slack webhooks, or OAuth tokens found in
  tracked files.

**KARTHIK-ONLY review before flipping public:**

- `PLAN-security-loadout.md` names internal apps (watchling, hernudge, vidi-chat)
  and the internal `ops/tasks/bumblebee_security_scan.py` job in its ops-wiring
  section. These are roadmap references, not secrets, and several names are
  already public (askvidi.com). Decide whether to keep the plan doc as-is, trim
  the internal ops references, or drop it before publishing. Low risk either way.
- `DESIGN.md` (33 KB) is a full internal design doc. Grep found no machine paths
  or credentials in it, but skim it once for anything you would not want public
  before flipping the repo.

## Launch checklist (ordered)

1. **AGENT** Add LICENSE (MIT, 2026 karoslabs), NOTICE, README rewrite,
   CONTRIBUTING.md, SECURITY.md, LAUNCH.md. Done in this PR. (LICENSE and NOTICE
   already existed and were verified correct.)
2. **AGENT** Security sweep and fixes above. Done in this PR.
3. **AGENT** Full test suite green (247 tests). Done, see PR body.
4. **KARTHIK-ONLY** Review the two flagged items above (PLAN-security-loadout.md,
   DESIGN.md) and decide keep/trim/drop.
5. **KARTHIK-ONLY** Merge this PR to `master` via the standard
   `APPROVE PR n` flow.
6. **KARTHIK-ONLY** Flip the GitHub repo `karoslab/nightshift` from private to
   public (Settings, General, Danger Zone, "Change repository visibility").
   Confirm branch protection on `master` survives the flip.
7. **KARTHIK-ONLY** Record the "watch it find a real bug overnight" clip.
   Exact scenes to capture, in order:
   1. A terminal tailing the nightloop / overnight log while a session runs
      (`node bin/nightshift.mjs overnight` output, or the ops nightloop log).
   2. The generated `report.md` open, scrolled to a confirmed finding with its
      numbered repro and screenshot.
   3. A repro script run in the terminal exiting 0
      (`node .nightshift/<runId>/repro/NS-001.mjs`).
   4. The PR that NightShift's fix pipeline opened for that bug.
   5. The Discord approval message (`APPROVE PR n`) that gated the merge.
   Drop the file in and replace the three TODO placeholders at the top of
   README.md (two screenshots, one clip).
8. **KARTHIK-ONLY** Post the launch article. It is already drafted in the Plume
   drafts desk (http://localhost:4182/studio/drafts). Review, then publish.
9. **KARTHIK-ONLY (optional)** Submit to newsletters and Hacker News if desired.
   Suggested: Show HN with the demo one-liner, a link to the repo, and the clip.
   Node/JS and QA/testing newsletters are the closest audience fit.

## Notes

- `package.json` has `"private": true`, which blocks accidental `npm publish`.
  Keep it unless you actually intend to publish to npm; making the GitHub repo
  public does not require changing it.
- The repo must stay private until step 6. Nothing in this PR publishes anything.
