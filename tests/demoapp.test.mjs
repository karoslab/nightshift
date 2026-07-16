// Tests for demo-app/server.mjs "Bugbox" (agent D). Hermetic: port 0 only.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startBugbox, resolvePort, DEFAULT_PORT } from "../demo-app/server.mjs";

const SERVER_PATH = fileURLToPath(new URL("../demo-app/server.mjs", import.meta.url));

let handle;
let base;

test.before(async () => {
  handle = await startBugbox(0);
  base = `http://127.0.0.1:${handle.port}`;
});

test.after(async () => {
  await handle?.close();
});

test("binds 127.0.0.1 explicitly on an ephemeral port", () => {
  assert.equal(handle.server.address().address, "127.0.0.1");
  assert.ok(handle.port > 0);
});

test("/ serves the pinned UI: exact button names, nav About, footer Warranty info", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  const html = await res.text();
  assert.ok(html.includes("Bugbox"));
  // Pinned accessible names — the demo mock script keys on these exactly.
  assert.ok(html.includes(">Choose color</button>"));
  assert.ok(html.includes(">Add to cart</button>"));
  assert.ok(html.includes(">Load deals</button>"));
  assert.ok(html.includes(">Apply coupon</button>"));
  assert.ok(html.includes('<a href="/about">About</a>'));
  assert.ok(html.includes('<a href="/warranty">Warranty info</a>'));
});

test("seeded bugs are wired: TypeError gated on color, coupon NaN, flaky fetch", async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.ok(html.includes("cart.total()"), "gated TypeError bug missing");
  assert.ok(html.includes("if (chosenColor)"), "TypeError must require Choose color first");
  assert.ok(html.includes('"Total: " + subtotal'), "coupon NaN bug missing");
  assert.ok(html.includes('fetch("/api/flaky")'), "flaky fetch missing");
});

test("/api/flaky always returns 500", async () => {
  for (let i = 0; i < 3; i++) {
    const res = await fetch(`${base}/api/flaky`);
    assert.equal(res.status, 500);
    assert.equal((await res.json()).ok, false);
  }
});

test("/warranty is a 404 (dead link from a real anchor)", async () => {
  const res = await fetch(`${base}/warranty`);
  assert.equal(res.status, 404);
  assert.ok((await res.text()).includes("404"));
});

test("/about is clean: 200, no scripts, no bug references", async () => {
  const res = await fetch(`${base}/about`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("About Bugbox"));
  assert.ok(!html.includes("<script"), "/about must run zero JS (false-positive canary)");
  assert.ok(!html.includes("/api/flaky"));
});

test("unknown routes 404", async () => {
  assert.equal((await fetch(`${base}/admin`)).status, 404);
});

test("resolvePort: --port beats BUGBOX_PORT beats default 4185; 0 allowed", () => {
  assert.equal(resolvePort([], {}), DEFAULT_PORT);
  assert.equal(DEFAULT_PORT, 4185);
  assert.equal(resolvePort([], { BUGBOX_PORT: "6000" }), 6000);
  assert.equal(resolvePort(["--port", "0"], { BUGBOX_PORT: "6000" }), 0);
  assert.equal(resolvePort(["--port=1234"], {}), 1234);
  assert.throws(() => resolvePort(["--port", "not-a-port"], {}));
});

test('CLI prints exactly one "BUGBOX LISTENING <port>" line on stdout', async () => {
  const child = spawn(process.execPath, [SERVER_PATH, "--port", "0"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));

  const firstLine = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no LISTENING line in 10s; stderr: ${stderr}`)), 10000);
    const check = () => {
      const nl = stdout.indexOf("\n");
      if (nl !== -1) {
        clearTimeout(timer);
        resolve(stdout.slice(0, nl));
      }
    };
    child.stdout.on("data", check);
    check();
  });

  const match = firstLine.match(/^BUGBOX LISTENING (\d+)$/);
  assert.ok(match, `pinned line format violated: ${JSON.stringify(firstLine)}`);
  const port = Number(match[1]);
  assert.ok(port > 0);

  // The spawned server actually answers on the advertised port.
  const res = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(res.status, 200);

  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(stdout, `BUGBOX LISTENING ${port}\n`, "stdout must be exactly one line");
});
