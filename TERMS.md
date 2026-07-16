# NightShift QA — Terms of Use & Disclaimer

Plain-English terms for buyers and users of NightShift QA. Read this before
pointing NightShift at anything.

## 1. Your Anthropic account is yours

- In `subscription-cli` mode, NightShift drives the official `claude` CLI that
  **you** installed and logged into on **your** machine. Your subscription,
  your login, your responsibility.
- You are responsible for your own Anthropic account, plan limits, rate
  limits, and compliance with Anthropic's Terms of Service and Usage Policy in
  both modes (`subscription-cli` and `api-key`).
- Anthropic's policies, limits, and pricing **can change at any time** —
  including whether and how subscription usage is metered or billed.
  NightShift makes no promise about the ongoing availability, suitability, or
  cost characteristics of either mode. If subscription-mode usage stops making
  sense for you, `api-key` mode is a one-line config change to metered
  billing under your own key.
- NightShift's default budgets are deliberately conservative, but staying
  within your plan's limits and Anthropic's policies is your responsibility,
  not NightShift's.

## 2. What NightShift touches — and what it never touches

- NightShift's **execution and storage are 100% local** to your machine: the
  browser, the run store, and the report console all run on your box only.
  There is no hosted component, no account pooling, and no shared credential
  of any kind. The bundled report console binds to 127.0.0.1 only.
- Page content IS processed by a model, under your own account. Every brain
  turn sends page state (URL, title, element names, up to 1500 characters of
  page text, recent failure messages, visited URLs) to the model — in
  `subscription-cli` mode via your own logged-in `claude` CLI, in `api-key`
  mode directly to `api.anthropic.com` under your own key. See
  [What gets sent to the model](README.md#what-gets-sent-to-the-model).
- NightShift **never reads, stores, logs, or transmits** OAuth tokens, API
  keys, or any file under `~/.claude/`. In `api-key` mode, your key is read
  from your environment variable at call time and sent only to
  `api.anthropic.com`; it is never written to config files, reports, or logs.
- **No telemetry.** The only network traffic NightShift generates is to the
  target application you configure and, in `api-key` mode, to
  `api.anthropic.com`.

## 3. Test only what you are allowed to test

- Point NightShift only at applications you own or are explicitly authorized
  to test. Automated exploration clicks buttons, submits forms, and follows
  links — it can create, modify, or delete data in the target application.
  Never aim it at production systems or third-party services without
  permission.

## 4. No warranty

- NightShift is provided **"as is"**, without warranty of any kind, express or
  implied. No guarantee is made that it will find all bugs, that its findings
  are complete or correct, or that a "confirmed" finding is exhaustive proof
  of a defect. You are responsible for reviewing findings before acting on
  them.
- To the maximum extent permitted by law, the authors are not liable for any
  damages arising from the use of NightShift, including damage to target
  applications, data loss, or costs incurred on your Anthropic account.

## 5. Not legal advice

- This document is a plain-language summary written for clarity, not legal
  advice. It does not modify or interpret Anthropic's terms — those are
  between you and Anthropic. If you need certainty about your obligations,
  consult the current Anthropic terms and, where it matters, a lawyer.
