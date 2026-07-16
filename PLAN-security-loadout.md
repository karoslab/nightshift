# NightShift Security Loadout — adoption spec (clean-room, defensive)

> Status: proposed. Owner: TBD. Target: additive module, ships behind a flag.
> This spec adds a **defensive** security-QA pass to NightShift. It adopts only
> generic security-QA *architecture patterns* — no third-party source is copied.
> See §0 for the clean-room rules, provenance, and licensing.

## 0. Legal preamble (load-bearing — read before writing a line)

T3MP3ST is **AGPL-3.0**. NightShift is **MIT**. These are copy-incompatible:
lifting AGPL source into this repo would relicense all of NightShift to AGPL
and trigger network source-disclosure. That is forbidden here.

**This is a clean-room reimplementation.** We adopt only *ideas and
architecture*, which are not copyrightable (idea/expression distinction):
evidence-backed findings, operator-role decomposition, scope-containment
egress gating, loadout composition. We do **not** copy T3MP3ST source, file
layout, identifiers, prompts, or tool wrappers.

Rules for whoever implements this:
1. Work from T3MP3ST's **public README/architecture description only**. Do not
   read its source files to translate them; do not open its `lib/` to "port" a
   function. If you need a behavior, specify it from first principles here.
2. All new code is original, authored for NightShift, and stays MIT.
3. Add one attribution line to `NOTICE` (create it):
   `Security-loadout architecture inspired by the public design of
   elder-plinius/T3MP3ST (AGPL-3.0). No T3MP3ST source is used; this is a
   clean-room reimplementation under MIT.`
4. Do **not** vendor, submodule, npm-install, or fetch any AGPL package.
5. Scope is **defensive only**: scan apps the operator owns/authorizes. No
   exploit-delivery, no lateral movement, no credential harvesting, no
   persistence — those T3MP3ST operator roles are explicitly out of scope and
   must not be reimplemented.

## 1. What we're actually adopting (and why it fits NightShift)

NightShift already is a single-operator, evidence-driven harness: a brain
proposes actions, deterministic oracles watch, and the **repro-re-verification
layer** confirms findings with the LLM out of the loop. T3MP3ST's useful ideas
are the ones that generalize NightShift from "functional bug hunter" to also
"defensive security-QA hunter," reusing the exact same moat.

Adopt (mapped to existing NightShift modules):

| T3MP3ST pattern | NightShift adoption | Reuses |
|---|---|---|
| Evidence-driven findings / verified provenance | Security oracles emit findings that go through the **existing** `reverify.mjs` replay before they're `confirmed` | `reverify.mjs`, `signature.mjs`, `reprogen.mjs` |
| Loadout composition (tools+adapters+benchmarks, no fork) | A `securityLoadout` = a set of extra oracles + a scoped probe list, toggled in config | `oracles.mjs`, `config.mjs` |
| Scope containment / egress receipts | An explicit allowlist gate + an audit log of every probe made | new `lib/security/scope.mjs` |
| Operator decomposition | We keep ONE brain but add named **checks** (not autonomous operators): headers, tls, mixed-content, cookie-flags, dead-auth-links, error-leakage | `lib/security/checks.mjs` |

Explicitly NOT adopting: the offensive kill-chain operators (Exploiter,
Infiltrator, Exfiltrator, Ghost), the 35–83 offensive tool arsenal, any
egress to third-party hosts. Defensive posture is non-negotiable and matches
NightShift's whole "only files what it can prove" ethos.

## 2. Design — every security finding earns its verdict deterministically

The core discipline stays identical to NightShift's product thesis: a security
finding is only `confirmed` after a deterministic re-check, LLM out of the
loop. The brain may *suggest* where to look; it never *decides* a vuln exists.

### 2.1 New module: `lib/security/checks.mjs`
Pure, deterministic checks that run against a page/response NightShift already
loaded during exploration. Each check is a function
`(ctx) => SecurityFinding | null`. No new network capability beyond what the
explorer already does — checks read responses/headers the session captured.

Initial defensive check set (all observe-only):
- **missing-security-headers** — CSP, HSTS, X-Content-Type-Options,
  X-Frame-Options/frame-ancestors, Referrer-Policy absent on a document
  response. (Same class of advisory header hygiene many operators already
  enforce at the edge — NightShift can now verify it from inside the app.)
- **insecure-cookie-flags** — Set-Cookie without `Secure`/`HttpOnly`/`SameSite`
  on an https origin.
- **mixed-content** — https page loading http subresources.
- **tls-downgrade-link** — in-app links that drop to http on an https origin.
- **verbose-error-leakage** — response bodies exposing stack traces / framework
  error pages / server version banners (regex catalog, conservative).
- **open-redirect-candidate** — redirect params that reflect an absolute
  external URL (candidate only; must reproduce in reverify to confirm).

Each returns a `SecurityFinding`:
```
{ id, checkId, severity, url, evidence: {headers?, snippet?, requestId?},
  reproKind: 'http-replay' | 'page-load', signatureInput }
```

### 2.2 Reuse `reverify.mjs` (do NOT write a parallel verifier)
Extend the existing re-verification layer with a `reproKind: 'http-replay'`:
replay the recorded request in a fresh context and assert the same
signature (e.g. header still missing, error page still returned). Page-load
checks reuse the existing browser-context replay path. A security finding with
no reproducible signature is dropped, exactly like a functional bug.

### 2.3 New module: `lib/security/scope.mjs` (egress containment + receipts)
- Loads `config.security.scope` = allowlist of origins/hosts the operator
  authorized. Default: the target app's own origin only.
- Every check that would touch the network passes through `assertInScope(url)`;
  off-scope → skipped + logged, never fetched.
- Writes a `scope-receipt.json` into the run store: what was authorized, what
  was probed, timestamps. This is the "consent-first" audit trail.

### 2.4 `config.mjs` additions
```
security: {
  enabled: false,                 // off by default; opt-in loadout
  scope: { origins: [] },         // empty = target origin only
  checks: ['*'],                  // or explicit check ids
  severityFloor: 'low'
}
```

### 2.5 Report integration
Security findings render in the existing `report.md` under a `## Security`
section, each with the same numbered repro + screenshot + standalone repro
script guarantee. `NS-SEC-001` style ids to keep them distinct from functional
`NS-001` findings.

## 3. Ops wiring

- Operators who already schedule overnight jobs can add a NightShift security
  pass alongside functional runs.
- Complements, does not replace, any external scanner you already run.
  NightShift's version is *in-app, evidence-verified, authorized-scope-only*
  — the differentiator vs a generic scanner.

## 4. Build plan (phased, tests-first, MIT clean)

- **P1** — `scope.mjs` + scope-receipt + config schema + tests. (containment first)
- **P2** — `checks.mjs` header/cookie/mixed-content checks (no network beyond
  session) + unit tests against fixtures in `demo-app`/Bugbox.
- **P3** — `reverify.mjs` `http-replay` reproKind + signature extension + tests.
- **P4** — report + repro-script generation for `NS-SEC-*` + demo wiring.
- **P5** — optional overnight-loop integration note for operators who schedule runs.

Each phase: feature-flagged, `node --test` green, PR per the branch→PR→verdict
workflow. Add `NOTICE` in P1.

## 5. Acceptance

- `security.enabled: false` → zero behavior change (default off).
- With it on against Bugbox: at least one header + one cookie finding, both
  `confirmed` via deterministic replay, both with runnable repro scripts.
- No off-scope network request appears in the run's network log.
- `NOTICE` present; no AGPL dependency in `package.json`; `git grep` finds no
  T3MP3ST source.
