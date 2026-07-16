# Contributing to NightShift

Thanks for helping. NightShift is a small, personal project maintained as time
allows, so reviews may be slow. Small, focused changes land fastest.

## Setup

```bash
npm install
npx playwright install chromium
npm test            # full suite, 247 tests, must stay green
node bin/nightshift.mjs demo   # end-to-end sanity check against Bugbox
```

Requires Node 22 or newer.

## Ground rules

- **Every change keeps the suite green.** Run `npm test` before you open a PR and
  add tests for new behavior. NightShift's entire value is that findings are
  deterministically verified, so untested changes to the trace, oracle,
  signature, or reverify paths will not be merged.
- **One execution path.** All step execution goes through `lib/trace.mjs`
  (`executeStep`). Recording, replay, and generated repro scripts must share it.
  Do not add a parallel executor.
- **Replay stays LLM-free.** Re-verification must never call the model. Keep the
  brain out of `lib/reverify.mjs` and anything it calls.
- **Determinism in signatures.** `lib/signature.mjs` is dependency-free and is
  embedded verbatim into generated repro scripts. Keep the parity test passing.
- **Defensive only.** The `lib/security/` checks are observe-only and scoped to
  authorized origins. Do not add offensive probing, credential handling, or
  off-scope network calls.

## Copy and docs

Plain, grounded wording. No em or en dashes in published copy. Prefer numbers
over adjectives.

## Sending a change

1. Branch from `master`.
2. Commit with a clear message.
3. Open a pull request describing what changed and how you verified it, including
   test output.

## License of contributions

By contributing you agree your contributions are licensed under the MIT License
in [LICENSE](LICENSE). See [NOTICE](NOTICE) for the clean-room attribution note
on the security loadout architecture.
