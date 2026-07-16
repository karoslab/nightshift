// tests/oracles.test.mjs — hermetic: chromium + in-test node:http servers on
// port 0 produce console errors, 500s, 401s, 404s, aborted requests. Asserts
// the noise filters drop the noise and keep the signal.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";
import { attachOracles } from "../lib/oracles.mjs";

let browser;
let server;
let origin;

const DEFAULT_ORACLES_CONFIG = {
  expectedStatuses: [401, 403],
  ignoreConsole: ["ResizeObserver loop", "\\[HMR\\]", "Download the React DevTools"],
};

function makeServer() {
  return http.createServer((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    if (p === "/api/500") return void (res.writeHead(500), res.end("boom"));
    if (p === "/api/401") return void (res.writeHead(401), res.end("no"));
    if (p === "/api/404") return void (res.writeHead(404), res.end("nope"));
    if (p === "/api/slow") return void setTimeout(() => { res.writeHead(200); res.end("slow"); }, 400);
    if (p === "/missing.png") return void (res.writeHead(404), res.end());
    if (p === "/gone") return void (res.writeHead(404, { "content-type": "text/html" }), res.end("<h1>404</h1>"));
    if (p === "/account") return void (res.writeHead(403, { "content-type": "text/html" }), res.end("<h1>login required</h1>"));
    if (p === "/api/503") return void (res.writeHead(503), res.end("maintenance"));
    if (p === "/old-docs") return void (res.writeHead(302, { location: "/gone" }), res.end());
    // 400 validation responses for the auth-400 suppression tests
    if (p === "/api/auth/signup") return void (res.writeHead(400), res.end("bad fields"));
    if (p === "/api/items") return void (res.writeHead(400), res.end("bad"));
    if (p === "/api/authors") return void (res.writeHead(400), res.end("bad"));
    if (p === "/api/auth/probe") return void (res.writeHead(403), res.end("no"));
    if (p === "/api/auth/missing") return void (res.writeHead(404), res.end("nope"));
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body>page</body></html>");
  });
}

before(async () => {
  browser = await chromium.launch({ headless: true });
  server = makeServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = "http://127.0.0.1:" + server.address().port;
});

after(async () => {
  await browser.close();
  await new Promise((r) => server.close(r));
});

// Fresh context + oracles per scenario so events never bleed between tests.
async function withOracles(fn, attachOptions = {}) {
  const context = await browser.newContext();
  const oracles = attachOracles(context, {
    origin,
    oraclesConfig: DEFAULT_ORACLES_CONFIG,
    ...attachOptions,
  });
  const page = await context.newPage();
  await page.goto(origin + "/blank");
  try {
    return await fn(page, oracles);
  } finally {
    oracles.dispose();
    await context.close();
  }
}

async function eventually(fn, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fn();
}

const ofOracle = (events, oracle) => events.filter((e) => e.oracle === oracle);

test("console-error: captured with page url; ignoreConsole regexes drop the noise", async () => {
  await withOracles(async (page, { events }) => {
    await page.evaluate(() => {
      console.error("ResizeObserver loop limit exceeded");
      console.error("[HMR] rebuilding");
      console.error("Download the React DevTools for a better experience");
      console.error("Real bad thing happened");
    });
    await eventually(() => ofOracle(events, "console-error").length >= 1);
    const errs = ofOracle(events, "console-error");
    assert.equal(errs.length, 1);
    assert.match(errs[0].message, /Real bad thing/);
    assert.equal(errs[0].url, origin + "/blank");
    assert.ok(Number.isFinite(errs[0].ts));
  });
});

test("page-error: uncaught exception fires page-error", async () => {
  await withOracles(async (page, { events }) => {
    await page.evaluate(() => setTimeout(() => { throw new Error("kaboom"); }, 0));
    await eventually(() => ofOracle(events, "page-error").length >= 1);
    const errs = ofOracle(events, "page-error");
    assert.equal(errs.length, 1);
    assert.match(errs[0].message, /kaboom/);
  });
});

test("network-5xx: same-origin fetch 500 fires with request detail", async () => {
  await withOracles(async (page, { events }) => {
    await page.evaluate(() => fetch("/api/500").catch(() => {}));
    await eventually(() => ofOracle(events, "network-5xx").length >= 1);
    const e = ofOracle(events, "network-5xx")[0];
    assert.deepEqual(e.detail, { status: 500, method: "GET", requestUrl: "/api/500" });
    assert.equal(e.url, origin + "/blank");
    assert.equal(e.atStep, 0);
  });
});

test("network-4xx: fetch 404 fires; expectedStatuses (401) never fires", async () => {
  await withOracles(async (page, { events }) => {
    await page.evaluate(() => fetch("/api/401").catch(() => {}));
    await page.evaluate(() => fetch("/api/404").catch(() => {}));
    await eventually(() => ofOracle(events, "network-4xx").length >= 1);
    const errs = ofOracle(events, "network-4xx");
    assert.equal(errs.length, 1);
    assert.equal(errs[0].detail.status, 404);
    assert.equal(errs[0].detail.requestUrl, "/api/404");
  });
});

test("network-4xx: non-fetch/xhr subresource 404 (image) is noise, not signal", async () => {
  await withOracles(async (page, { events }) => {
    await page.evaluate(() => new Promise((resolve) => {
      const img = document.createElement("img");
      img.onerror = resolve;
      img.src = "/missing.png";
      document.body.append(img);
    }));
    await page.waitForTimeout(200);
    assert.equal(ofOracle(events, "network-4xx").length, 0);
  });
});

test("request-failed: aborted fetch (net::ERR_ABORTED family) is excluded", async () => {
  await withOracles(async (page, { events }) => {
    await page.evaluate(() => {
      const c = new AbortController();
      const p = fetch("/api/slow", { signal: c.signal }).catch(() => {});
      setTimeout(() => c.abort(), 20);
      return p;
    });
    await page.waitForTimeout(300);
    assert.equal(ofOracle(events, "request-failed").length, 0);
    assert.equal(ofOracle(events, "nav-failure").length, 0);
  });
});

test("request-failed: genuinely failed fetch (connection refused) is signal", async () => {
  // reserve an ephemeral port, then close it so the fetch is refused
  const dead = makeServer();
  await new Promise((r) => dead.listen(0, "127.0.0.1", r));
  const deadOrigin = "http://127.0.0.1:" + dead.address().port;
  await new Promise((r) => dead.close(r));
  await withOracles(async (page, { events }) => {
    await page.evaluate((u) => fetch(u + "/api/x").catch(() => {}), deadOrigin);
    await eventually(() => ofOracle(events, "request-failed").length >= 1);
    const errs = ofOracle(events, "request-failed");
    assert.equal(errs.length, 1);
    assert.match(errs[0].message, /ERR_CONNECTION_REFUSED/);
    assert.equal(errs[0].detail.requestUrl, "/api/x");
  });
});

test("nav-failure: unreachable navigation fires (not request-failed)", async () => {
  const dead = makeServer();
  await new Promise((r) => dead.listen(0, "127.0.0.1", r));
  const deadOrigin = "http://127.0.0.1:" + dead.address().port;
  await new Promise((r) => dead.close(r));
  await withOracles(async (page, { events }) => {
    await page.goto(deadOrigin + "/", { timeout: 3000 }).catch(() => {});
    await eventually(() => ofOracle(events, "nav-failure").length >= 1);
    assert.equal(ofOracle(events, "nav-failure").length, 1);
    assert.equal(ofOracle(events, "request-failed").length, 0);
  });
});

test("dead-link: fires only for anchor-harvested/seed destinations when navAllowList is provided", async () => {
  // harvested destination -> fires
  await withOracles(
    async (page, { events }) => {
      await page.goto(origin + "/gone").catch(() => {});
      await eventually(() => ofOracle(events, "dead-link").length >= 1);
      const e = ofOracle(events, "dead-link")[0];
      assert.deepEqual(e.detail, { status: 404, method: "GET", requestUrl: "/gone" });
      assert.equal(ofOracle(events, "network-4xx").length, 0, "document 404 must not double-file as network-4xx");
    },
    { navAllowList: new Set(["/gone"]) },
  );
  // brain-invented destination -> silence
  await withOracles(
    async (page, { events }) => {
      await page.goto(origin + "/gone").catch(() => {});
      await page.waitForTimeout(200);
      assert.equal(ofOracle(events, "dead-link").length, 0);
    },
    { navAllowList: new Set(["/other"]) },
  );
});

test("dead-link: without navAllowList (reverify replay) every qualifying document nav fires", async () => {
  await withOracles(async (page, { events }) => {
    await page.goto(origin + "/gone").catch(() => {});
    await eventually(() => ofOracle(events, "dead-link").length >= 1);
    assert.equal(ofOracle(events, "dead-link").length, 1);
  });
});

test("same-origin filter: cross-origin 500s never fire network oracles", async () => {
  const other = makeServer();
  await new Promise((r) => other.listen(0, "127.0.0.1", r));
  const otherOrigin = "http://127.0.0.1:" + other.address().port;
  try {
    await withOracles(async (page, { events }) => {
      await page.evaluate((u) => fetch(u + "/api/500").catch(() => {}), otherOrigin);
      await page.waitForTimeout(300);
      assert.equal(ofOracle(events, "network-5xx").length, 0);
      assert.equal(ofOracle(events, "network-4xx").length, 0);
    });
  } finally {
    await new Promise((r) => other.close(r));
  }
});

test("setStep stamps atStep on subsequent events", async () => {
  await withOracles(async (page, { events, setStep }) => {
    setStep(3);
    await page.evaluate(() => fetch("/api/500").catch(() => {}));
    await eventually(() => ofOracle(events, "network-5xx").length >= 1);
    assert.equal(ofOracle(events, "network-5xx")[0].atStep, 3);
    setStep(7);
    await page.evaluate(() => fetch("/api/404").catch(() => {}));
    await eventually(() => ofOracle(events, "network-4xx").length >= 1);
    assert.equal(ofOracle(events, "network-4xx")[0].atStep, 7);
  });
});

test("dispose detaches all listeners", async () => {
  const context = await browser.newContext();
  const oracles = attachOracles(context, { origin, oraclesConfig: DEFAULT_ORACLES_CONFIG });
  const page = await context.newPage();
  await page.goto(origin + "/blank");
  oracles.dispose();
  await page.evaluate(() => {
    console.error("after dispose");
    return fetch("/api/500").catch(() => {});
  });
  await page.waitForTimeout(300);
  assert.equal(oracles.events.length, 0);
  await context.close();
});

// --- fixes: findings review 2026-07-02 ---

test("console oracle drops Chromium network-log entries (missing image / expected 401) — the network filters own those", async () => {
  await withOracles(async (page, { events }) => {
    // a missing <img> and an expected auth probe both emit
    // "Failed to load resource: ..." console entries in Chromium
    await page.evaluate(() => new Promise((resolve) => {
      const img = document.createElement("img");
      img.onerror = resolve;
      img.src = "/missing.png";
      document.body.append(img);
    }));
    await page.evaluate(() => fetch("/api/401").catch(() => {}));
    await page.waitForTimeout(400);
    assert.equal(ofOracle(events, "console-error").length, 0, JSON.stringify(events));
    // and the network oracles stay quiet too (non-fetchy type / expected status)
    assert.equal(ofOracle(events, "network-4xx").length, 0);
  });
});

test("expectedStatuses suppress dead-link: a login-gated anchor landing on 403 is not a bug", async () => {
  await withOracles(
    async (page, { events }) => {
      await page.goto(origin + "/account").catch(() => {});
      await page.waitForTimeout(300);
      assert.equal(ofOracle(events, "dead-link").length, 0, JSON.stringify(events));
    },
    { navAllowList: new Set(["/account"]) }, // harvested from a real anchor
  );
});

test("expectedStatuses suppress network-5xx: a buyer-declared 503 never files", async () => {
  await withOracles(
    async (page, { events }) => {
      await page.evaluate(() => fetch("/api/503").catch(() => {}));
      await page.waitForTimeout(300);
      assert.equal(ofOracle(events, "network-5xx").length, 0, JSON.stringify(events));
    },
    { oraclesConfig: { ...DEFAULT_ORACLES_CONFIG, expectedStatuses: [401, 403, 503] } },
  );
});

test("dead-link allow-list keys on pathname+search: a harvested ?query anchor does not whitelist the bare pathname", async () => {
  // real anchor /gone?id=1 harvested; the brain invents goto /gone -> silence
  await withOracles(
    async (page, { events }) => {
      await page.goto(origin + "/gone").catch(() => {});
      await page.waitForTimeout(300);
      assert.equal(ofOracle(events, "dead-link").length, 0, JSON.stringify(events));
    },
    { navAllowList: new Set(["/gone?id=1"]) },
  );
  // while the harvested URL itself still fires
  await withOracles(
    async (page, { events }) => {
      await page.goto(origin + "/gone?id=1").catch(() => {});
      await eventually(() => ofOracle(events, "dead-link").length >= 1);
      assert.equal(ofOracle(events, "dead-link").length, 1);
    },
    { navAllowList: new Set(["/gone?id=1"]) },
  );
});

// --- fixes: false-positive review 2026-07-04 (NS-001 auth-400 validation) ---

test("network-4xx: a 400 from an auth endpoint is validation, not a bug — suppressed", async () => {
  // A POST to an /api/auth/signup endpoint returns 400 when required fields are empty
  // (the server correctly rejecting bad input). That is not a bug in the app.
  await withOracles(async (page, { events }) => {
    await page.evaluate(() => fetch("/api/auth/signup", { method: "POST" }).catch(() => {}));
    await page.waitForTimeout(400);
    assert.equal(ofOracle(events, "network-4xx").length, 0, JSON.stringify(events));
  });
});

test("network-4xx: a 400 from a NON-auth endpoint still fires (suppression is narrow)", async () => {
  await withOracles(async (page, { events }) => {
    await page.evaluate(() => fetch("/api/items", { method: "POST" }).catch(() => {}));
    await eventually(() => ofOracle(events, "network-4xx").length >= 1);
    const errs = ofOracle(events, "network-4xx");
    assert.equal(errs.length, 1);
    assert.equal(errs[0].detail.status, 400);
    assert.equal(errs[0].detail.requestUrl, "/api/items");
  });
});

test("network-4xx: /api/authors is not an auth endpoint — its 400 still fires (regex precision)", async () => {
  // the AUTH_PATH_RE `s?` must not let "authors" ride on the "auth" branch
  await withOracles(async (page, { events }) => {
    await page.evaluate(() => fetch("/api/authors", { method: "POST" }).catch(() => {}));
    await eventually(() => ofOracle(events, "network-4xx").length >= 1);
    assert.equal(ofOracle(events, "network-4xx").length, 1);
    assert.equal(ofOracle(events, "network-4xx")[0].detail.requestUrl, "/api/authors");
  });
});

test("auth 401/403 behavior unchanged: expectedStatuses still suppress, no 400 crossover", async () => {
  // 403 on an auth endpoint is suppressed by expectedStatuses (unchanged);
  // a genuine auth 404 (not 400, not expected) still fires — the auth-400 gate
  // is scoped to status 400 only.
  await withOracles(async (page, { events }) => {
    await page.evaluate(() => fetch("/api/auth/probe").catch(() => {})); // 403, expected
    await page.evaluate(() => fetch("/api/auth/missing").catch(() => {})); // 404, /api/auth/missing not a real route -> auth path but 404
    await eventually(() => ofOracle(events, "network-4xx").length >= 1);
    const errs = ofOracle(events, "network-4xx");
    assert.equal(errs.length, 1, JSON.stringify(events));
    assert.equal(errs[0].detail.status, 404, "auth-endpoint 404 still fires; only 400 is suppressed");
  });
});

test("dead-link checks the redirect chain's ORIGINAL request: a real anchor redirecting to a 404 fires", async () => {
  // <a href="/old-docs"> harvested; /old-docs 302-redirects to /gone (404).
  // The final URL /gone is not in the allow-list — the anchor URL is what the
  // list is about, so this genuinely broken link must still be reported.
  await withOracles(
    async (page, { events }) => {
      await page.goto(origin + "/old-docs").catch(() => {});
      await eventually(() => ofOracle(events, "dead-link").length >= 1);
      const e = ofOracle(events, "dead-link")[0];
      assert.equal(e.detail.status, 404);
      assert.equal(e.detail.requestUrl, "/gone", "event detail keeps the FINAL landing URL");
    },
    { navAllowList: new Set(["/old-docs"]) },
  );
});
