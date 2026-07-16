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
// Deterministic: no randomness, no time dependence, and NO server-side state
// at all (all bug state lives in per-page JS, so fresh contexts start clean).
// Binds 127.0.0.1 explicitly (never exposed to the LAN).

import http from "node:http";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const DEFAULT_PORT = 4185;

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

function handleRequest(req, res) {
  const send = (status, contentType, body) => {
    res.writeHead(status, { "Content-Type": contentType });
    res.end(body);
  };
  const { pathname } = new URL(req.url, "http://127.0.0.1");
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

export function startBugbox(port = DEFAULT_PORT) {
  const server = http.createServer(handleRequest);
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
