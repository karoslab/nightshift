// tests/mockguard.test.mjs — `--brain mock` must refuse to run against
// anything that isn't the bundled Bugbox demo: demoMockScript()'s element
// ids are pinned to Bugbox's DOM and click random elements on a real app.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { assertMockBrainTargetIsBugbox } from "../bin/nightshift.mjs";
import { startBugbox } from "../demo-app/server.mjs";

test("refuses a real app that is not Bugbox", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><head><title>My Real App</title></head><body><button>Buy now</button></body></html>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await assert.rejects(() => assertMockBrainTargetIsBugbox(url), /Bugbox/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("refuses an unreachable target", async () => {
  await assert.rejects(() => assertMockBrainTargetIsBugbox("http://127.0.0.1:1"), /Bugbox/);
});

test("accepts the real bundled Bugbox demo", async () => {
  const bugbox = await startBugbox(0);
  try {
    await assert.doesNotReject(() => assertMockBrainTargetIsBugbox(`http://127.0.0.1:${bugbox.port}`));
  } finally {
    await bugbox.close();
  }
});
