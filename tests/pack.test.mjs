// tests/pack.test.mjs — npm pack must ship only the runtime allowlist, never private working files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ALLOWED_PREFIXES = ["bin/", "lib/", "console/", "demo-app/", "examples/"];
const ALLOWED_FILES = ["package.json", "README.md", "TERMS.md", "LICENSE"];

function isAllowed(filePath) {
  if (ALLOWED_FILES.includes(filePath)) return true;
  return ALLOWED_PREFIXES.some((prefix) => filePath.startsWith(prefix));
}

test("npm pack --dry-run ships only the runtime allowlist", () => {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: repoRoot, encoding: "utf8" });
  const [{ files }] = JSON.parse(output);
  const disallowed = files.map((f) => f.path).filter((p) => !isAllowed(p));
  assert.deepEqual(disallowed, []);
});
