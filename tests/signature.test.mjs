// tests/signature.test.mjs — table-driven normalization + subject keying.
// Hermetic: pure functions, no browser, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSignature, signaturesMatch } from "../lib/signature.mjs";

const consoleEvent = (over = {}) => ({
  oracle: "console-error",
  message: "boom",
  url: "http://localhost:4185/shop",
  detail: {},
  atStep: 0,
  ts: 1700000000000,
  ...over,
});

test("buildSignature: normalization table", () => {
  const table = [
    {
      name: "lowercase + page-pathname subject",
      input: consoleEvent({ message: "TypeError: Total is not a function" }),
      expected: "console-error|/shop|typeerror: total is not a function",
    },
    {
      name: "uuid -> #",
      input: consoleEvent({ message: "user 6f9619ff-8b86-d011-b42d-00cf4fc964ff missing" }),
      expected: "console-error|/shop|user # missing",
    },
    {
      name: "hex id >= 8 chars -> #",
      input: consoleEvent({ message: "session deadbeef01cafe expired" }),
      expected: "console-error|/shop|session # expired",
    },
    {
      name: "7-char hex id survives",
      input: consoleEvent({ message: "ref abcdef1 kept" }),
      expected: "console-error|/shop|ref abcdef1 kept",
    },
    {
      name: "integers >= 3 digits -> #, small ints survive",
      input: consoleEvent({ message: "failed after 500 ms with code 12" }),
      expected: "console-error|/shop|failed after # ms with code 12",
    },
    {
      name: "iso timestamp -> single #",
      input: consoleEvent({ message: "at 2026-07-02T07:14:23.123Z boom" }),
      expected: "console-error|/shop|at # boom",
    },
    {
      name: "bare date and clock time -> #",
      input: consoleEvent({ message: "since 2026-07-02 and 07:14:23 gone" }),
      expected: "console-error|/shop|since # and # gone",
    },
    {
      name: "query string stripped from message text",
      input: consoleEvent({ message: "GET /api/items?id=123&x=y died" }),
      expected: "console-error|/shop|get /api/items died",
    },
    {
      name: "query string stripped from the page url",
      input: consoleEvent({ url: "http://localhost:4185/shop?tab=2&q=abc" }),
      expected: "console-error|/shop|boom",
    },
    {
      name: "whitespace collapsed",
      input: consoleEvent({ message: "a\n\n   b\t c" }),
      expected: "console-error|/shop|a b c",
    },
    {
      name: "page-error keyed on page pathname",
      input: consoleEvent({ oracle: "page-error", message: "TypeError: x", url: "http://localhost:4185/cart/checkout" }),
      expected: "page-error|/cart/checkout|typeerror: x",
    },
    {
      name: "numeric path segment normalized in page pathname",
      input: consoleEvent({ message: "boom", url: "http://localhost:4185/orders/98765" }),
      expected: "console-error|/orders/#|boom",
    },
    {
      name: "relative event url still yields a pathname",
      input: consoleEvent({ url: "/shop" }),
      expected: "console-error|/shop|boom",
    },
    {
      name: "network-5xx keyed on request pathname + method + status",
      input: {
        oracle: "network-5xx",
        message: "HTTP 500 GET /api/flaky",
        url: "http://localhost:4185/shop",
        detail: { status: 500, method: "GET", requestUrl: "/api/flaky" },
      },
      expected: "network-5xx|/api/flaky get 500|http # get /api/flaky",
    },
    {
      name: "request pathname ids + query normalized, status kept verbatim",
      input: {
        oracle: "network-4xx",
        message: "HTTP 422 POST /api/items/98765",
        url: "http://localhost:4185/shop",
        detail: { status: 422, method: "POST", requestUrl: "/api/items/98765?retry=1" },
      },
      expected: "network-4xx|/api/items/# post 422|http # post /api/items/#",
    },
    {
      name: "request-failed: null status omitted from the subject",
      input: {
        oracle: "request-failed",
        message: "net::ERR_CONNECTION_REFUSED",
        url: "http://localhost:4185/shop",
        detail: { status: null, method: "GET", requestUrl: "/api/x" },
      },
      expected: "request-failed|/api/x get|net::err_connection_refused",
    },
    {
      name: "dead-link keyed on destination pathname + method + status",
      input: {
        oracle: "dead-link",
        message: "navigation landed on HTTP 404",
        url: "http://localhost:4185/warranty",
        detail: { status: 404, method: "GET", requestUrl: "/warranty" },
      },
      expected: "dead-link|/warranty get 404|navigation landed on http #",
    },
    {
      name: "nav-failure is page-keyed (event.url), not request-keyed",
      input: {
        oracle: "nav-failure",
        message: "net::ERR_CONNECTION_REFUSED",
        url: "http://localhost:4185/page",
        detail: { status: null, method: "GET", requestUrl: "/other-dest" },
      },
      expected: "nav-failure|/page|net::err_connection_refused",
    },
    {
      name: "semantic text-present check keyed on page pathname + check text",
      input: { kind: "text-present", selector: "#total", text: "Total: NaN", url: "http://127.0.0.1:4185/" },
      expected: "text-present|/|total: nan",
    },
    {
      name: "semantic text-absent check",
      input: { kind: "text-absent", selector: null, text: "Order confirmed", url: "http://127.0.0.1:4185/cart" },
      expected: "text-absent|/cart|order confirmed",
    },
  ];
  for (const row of table) {
    assert.equal(buildSignature(row.input), row.expected, row.name);
  }
});

test("buildSignature: truncates to 200 chars and stays deterministic", () => {
  const long = consoleEvent({ message: "x".repeat(500) });
  const sig = buildSignature(long);
  assert.equal(sig.length, 200);
  assert.ok(sig.startsWith("console-error|/shop|xxxx"));
  assert.equal(sig, buildSignature(structuredClone(long)), "same input -> same signature");
});

test("buildSignature: request-URL keying separates endpoints and merges pages", () => {
  const onPage = (page, requestUrl) => ({
    oracle: "network-4xx",
    message: "HTTP 422 GET " + requestUrl,
    url: page,
    detail: { status: 422, method: "GET", requestUrl },
  });
  // two failing endpoints triggered from the same page are two distinct bugs
  assert.notEqual(
    buildSignature(onPage("http://x/shop", "/api/a")),
    buildSignature(onPage("http://x/shop", "/api/b")),
  );
  // the same failing endpoint from two pages is one bug
  assert.equal(
    buildSignature(onPage("http://x/shop", "/api/a")),
    buildSignature(onPage("http://x/cart", "/api/a")),
  );
});

test("buildSignature: throws on inputs that are neither event nor check", () => {
  assert.throws(() => buildSignature(null), /expected a FailureEvent or semantic check/);
  assert.throws(() => buildSignature("network-5xx"), /expected a FailureEvent or semantic check/);
  assert.throws(() => buildSignature({}), /neither/);
  assert.throws(() => buildSignature({ kind: "screenshot-diff", text: "x" }), /neither/);
});

test("signaturesMatch: exact string equality, strings only", () => {
  const a = buildSignature(consoleEvent());
  assert.equal(signaturesMatch(a, buildSignature(consoleEvent())), true);
  assert.equal(signaturesMatch(a, a + "x"), false);
  assert.equal(signaturesMatch(null, null), false);
  assert.equal(signaturesMatch(undefined, undefined), false);
});

test("buildSignature is self-contained: rehydrated source behaves identically", () => {
  // reprogen embeds these functions via .toString() — closures over module
  // state would silently break the generated scripts.
  const rehydrated = new Function(buildSignature.toString() + "; return buildSignature;")();
  const samples = [
    consoleEvent({ message: "TypeError: Total is not a function at 2026-07-02T07:14:23Z id 6f9619ff-8b86-d011-b42d-00cf4fc964ff" }),
    {
      oracle: "network-5xx",
      message: "HTTP 500 GET /api/flaky",
      url: "http://localhost:4185/shop",
      detail: { status: 500, method: "GET", requestUrl: "/api/flaky?cache=1700000000000" },
    },
    { kind: "text-present", selector: "#total", text: "Total: NaN", url: "http://127.0.0.1:4185/" },
  ];
  for (const sample of samples) {
    assert.equal(rehydrated(sample), buildSignature(sample));
  }
});
