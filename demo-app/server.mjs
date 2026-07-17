// demo-app/server.mjs — "Bugbox", the seeded-bug demo target. Zero deps.
// UI is PINNED (accessible names must not change — the demo mock script keys
// on them): buttons "Choose color", "Add to cart", "Load deals",
// "Apply coupon"; nav link "About" -> /about; footer link "Warranty info" ->
// /warranty (404). Seeded bugs:
//   1. "Add to cart" throws a TypeError ONLY after "Choose color" was clicked
//      first in the same page state (multi-step trace).
//   2. "Load deals" fetches /api/flaky, which always returns 500.
//   3. "Warranty info" -> 404 (dead link from a real anchor href).
//   4. "Apply coupon" renders "Total: NaN" into #total (semantic bug).
//   5. /about is clean — the zero-findings false-positive canary.
// Auth fixtures (for `target.auth` / `target.journeys` demos and tests):
//   - /login serves a login form (#username, #password, #login) that POSTs to
//     /api/login. Correct creds (DEMO_CREDENTIALS) set cookie bugbox_auth=ok
//     and the page redirects to /account. Wrong creds -> 401 (an expected auth
//     status, never a finding).
//   - /account is GATED: authenticated (cookie present) -> 200 account page;
//     anonymous -> 302 redirect to /login (redirected, never crashed).
// The pinned home/about/404 pages are UNCHANGED — no anchors point at the auth
// routes, so the anonymous crawl never wanders into them.
// Deterministic: no randomness, no time dependence, and NO cross-request
// server state (auth is a single fixed cookie, all bug state lives in per-page
// JS, so fresh contexts start clean). Binds 127.0.0.1 explicitly.

import http from "node:http";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const DEFAULT_PORT = 4185;

// Seeded demo credentials. Point a role's usernameEnv/passwordEnv at env vars
// holding these to log in against the demo. Never a real secret.
export const DEMO_CREDENTIALS = Object.freeze({ username: "demo", password: "swordfish" });
const AUTH_COOKIE = "bugbox_auth=ok";

const STYLE = `
  body { font: 16px/1.6 -apple-system, "Segoe UI", sans-serif; background: #101418;
         color: #e8e4da; max-width: 640px; margin: 3rem auto; padding: 0 1.25rem; }
  h1 { letter-spacing: .05em; }
  nav, footer { opacity: .85; margin: 1rem 0; }
  a { color: #8ab4f8; }
  button { font: inherit; background: #2b3440; color: #e8e4da; border: 1px solid #4a5568;
           border-radius: 6px; padding: .55rem 1.1rem; margin: .3rem .5rem .3rem 0; cursor: pointer; }
  button:hover { background: #3a4656; }
  #total { font-weight: 600; }
`;

const PAGE_HOME = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Bugbox</title><style>${STYLE}</style></head>
<body>
<nav><a href="/about">About</a></nav>
<h1>Bugbox</h1>
<p>A tiny shop with something wrong in every aisle.</p>
<section>
  <button id="choose-color">Choose color</button>
  <button id="add-to-cart">Add to cart</button>
  <button id="load-deals">Load deals</button>
  <button id="apply-coupon">Apply coupon</button>
</section>
<p id="status">No color chosen.</p>
<p id="deals"></p>
<p id="total"></p>
<footer><a href="/warranty">Warranty info</a></footer>
<script>
  var chosenColor = null;
  var cartCount = 0;
  function el(id) { return document.getElementById(id); }
  el("choose-color").addEventListener("click", function () {
    chosenColor = "aubergine";
    el("status").textContent = "Color: " + chosenColor;
  });
  el("add-to-cart").addEventListener("click", function () {
    if (chosenColor) {
      var cart = { items: [chosenColor] };
      // Seeded bug 1: cart.total does not exist -> uncaught TypeError.
      el("status").textContent = "Cart total: " + cart.total();
    }
    cartCount += 1;
    el("status").textContent = "Items in cart: " + cartCount;
  });
  el("load-deals").addEventListener("click", function () {
    // Seeded bug 2: /api/flaky always answers 500 (handled gracefully here —
    // the failing response itself is the signal).
    fetch("/api/flaky").then(function (res) {
      el("deals").textContent = res.ok ? "Deals loaded." : "Deals unavailable right now.";
    });
  });
  el("apply-coupon").addEventListener("click", function () {
    var prices = { candle: 12 };
    // Seeded bug 4: "lamp" has no price -> undefined * 2 = NaN.
    var subtotal = prices["lamp"] * 2;
    el("total").textContent = "Total: " + subtotal;
  });
</script>
</body>
</html>`;

const PAGE_ABOUT = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>About — Bugbox</title><style>${STYLE}</style></head>
<body>
<nav><a href="/">Shop</a></nav>
<h1>About Bugbox</h1>
<p>Bugbox is the deliberately broken demo shop that NightShift QA hunts in.
This page, however, is perfectly fine — a false-positive canary. If a QA tool
files a bug against this page, the bug is in the tool.</p>
</body>
</html>`;

const PAGE_404 = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>404 — Bugbox</title><style>${STYLE}</style></head>
<body>
<h1>404 — page not found</h1>
<p>Bugbox has no such aisle.</p>
<p><a href="/">Back to the shop</a></p>
</body>
</html>`;

const PAGE_LOGIN = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Sign in — Bugbox</title><style>${STYLE}</style></head>
<body>
<h1>Sign in to Bugbox</h1>
<form id="login-form">
  <p><label>Username <input id="username" name="username" autocomplete="username"></label></p>
  <p><label>Password <input id="password" name="password" type="password" autocomplete="current-password"></label></p>
  <button id="login" type="submit">Sign in</button>
</form>
<p id="login-error"></p>
<script>
  document.getElementById("login-form").addEventListener("submit", function (e) {
    e.preventDefault();
    fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: document.getElementById("username").value,
        password: document.getElementById("password").value,
      }),
    }).then(function (res) {
      if (res.ok) { window.location = "/account"; }
      else { document.getElementById("login-error").textContent = "Invalid credentials."; }
    });
  });
</script>
</body>
</html>`;

// Responsive fixture for the expected-element census oracle. The "Search"
// control is visible at every width by default; when hideTabletControl is set
// it computes to display:none in the 640–900px band (the short4movies PR #29
// case) — so it drops out of enumeration at the tablet class (760px) only,
// while mobile (375) and desktop (1280) still see it. Not linked from any other
// page, so it never perturbs the pinned home/about crawl.
function pageResponsive(hideTabletControl) {
  const hideRule = hideTabletControl
    ? "@media (min-width: 640px) and (max-width: 900px) { #search-btn { display: none; } }"
    : "";
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Responsive — Bugbox</title><meta name="viewport" content="width=device-width, initial-scale=1">
<style>${STYLE}${hideRule}</style></head>
<body>
<nav><a href="/">Home</a></nav>
<h1>Store tools</h1>
<div class="toolbar">
  <button id="search-btn">Search</button>
  <button id="menu-btn">Menu</button>
  <a href="/about" id="help-link">Help</a>
</div>
<p><input id="query" name="query" placeholder="Find products"></p>
</body>
</html>`;
}

const PAGE_ACCOUNT = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Your account — Bugbox</title><style>${STYLE}</style></head>
<body>
<nav><a href="/">Shop</a></nav>
<h1>Your account</h1>
<p id="who">Signed in as demo</p>
<p>This aisle is only open to signed-in shoppers.</p>
</body>
</html>`;

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 10_000) data = data.slice(0, 10_000); // demo-scale guard
    });
    req.on("end", () => resolve(data));
    req.on("error", () => resolve(""));
  });
}

function isAuthed(req) {
  const cookie = req.headers.cookie || "";
  return cookie.split(/;\s*/).includes(AUTH_COOKIE);
}

async function handleRequest(req, res, state = {}) {
  const send = (status, contentType, body) => {
    res.writeHead(status, { "Content-Type": contentType });
    res.end(body);
  };
  const { pathname } = new URL(req.url, "http://127.0.0.1");
  if (pathname === "/responsive") return send(200, "text/html; charset=utf-8", pageResponsive(state.hideTabletControl === true));
  if (pathname === "/login") return send(200, "text/html; charset=utf-8", PAGE_LOGIN);
  if (pathname === "/api/login") {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" });
      return res.end(JSON.stringify({ ok: false, error: "method not allowed" }));
    }
    let creds = {};
    try {
      creds = JSON.parse(await readBody(req));
    } catch {
      creds = {};
    }
    const ok = creds.username === DEMO_CREDENTIALS.username && creds.password === DEMO_CREDENTIALS.password;
    if (!ok) {
      // 401 is a declared expected auth status — a wrong-password probe is not a bug.
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "invalid credentials" }));
    }
    res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": `${AUTH_COOKIE}; Path=/` });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (pathname === "/account") {
    if (isAuthed(req)) return send(200, "text/html; charset=utf-8", PAGE_ACCOUNT);
    // Anonymous: redirect to login (never a crash, never a 4xx/5xx).
    res.writeHead(302, { Location: "/login" });
    return res.end();
  }
  if (pathname === "/") {
    // Seeded security fixture (opt-in `security.enabled` loadout only, never
    // read by the default functional session): a session cookie with none of
    // Secure/HttpOnly/SameSite set, and no security headers at all — Bugbox
    // exercises the same false-positive discipline for security checks that
    // it does for functional oracles.
    res.setHeader("Set-Cookie", "bugbox_session=demo; Path=/");
    return send(200, "text/html; charset=utf-8", PAGE_HOME);
  }
  if (pathname === "/about") return send(200, "text/html; charset=utf-8", PAGE_ABOUT);
  if (pathname === "/api/flaky") {
    // Seeded bug 2: always 500, deterministically.
    return send(500, "application/json", JSON.stringify({ ok: false, error: "deal service exploded (it always does)" }));
  }
  return send(404, "text/html; charset=utf-8", PAGE_404);
}

// `state` is a live, mutable object (default { hideTabletControl: false }) read
// per request — tests flip state.hideTabletControl between runs to simulate a
// responsive CSS regression landing while the server stays on one port.
export function startBugbox(port = DEFAULT_PORT, state = {}) {
  const server = http.createServer((req, res) => {
    handleRequest(req, res, state).catch(() => {
      try {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      } catch {
        // response already torn down
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve({
        server,
        port: server.address().port,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function argValue(argv, name) {
  const i = argv.indexOf(name);
  if (i !== -1 && argv[i + 1] !== undefined) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}

export function resolvePort(argv = [], env = {}) {
  const raw = argValue(argv, "--port") ?? env.BUGBOX_PORT;
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const port = Number(raw); // "--port 0" means: pick an ephemeral port
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid bugbox port: ${raw}`);
  }
  return port;
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const port = resolvePort(process.argv.slice(2), process.env);
  const { port: boundPort } = await startBugbox(port);
  // Pinned protocol: exactly one stdout line; the parent parses it.
  process.stdout.write(`BUGBOX LISTENING ${boundPort}\n`);
}
