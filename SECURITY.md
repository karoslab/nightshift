# Security Policy

## Reporting a vulnerability

Please report security issues privately. Do not open a public GitHub issue for a
vulnerability.

- Use GitHub's private vulnerability reporting for this repository
  (Security tab, "Report a vulnerability"), or
- Email the maintainer at the address on the GitHub profile of the repository
  owner.

Include what you found, the version or commit, and the steps to reproduce.

We aim to acknowledge reports within a few days, but this is a personal project
maintained as time allows, so response may be slower.

There is no bug bounty and no paid reward program.

## Scope notes

- NightShift runs entirely on the operator's machine. It makes no network calls
  except to the target app under test and, in api-key mode, `api.anthropic.com`.
- The bundled console binds `127.0.0.1` only.
- The optional `lib/security/` checks are defensive and observe-only, scoped to
  origins the operator explicitly authorizes.

If you find behavior that contradicts any of the above, that is exactly the kind
of report we want.
