import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * Packages the pi host supplies to extensions. A physical copy in
 * `node_modules` can bypass the extension loader's module mapping and create
 * duplicate runtime modules, so these must stay in `peerDependencies` with a
 * `"*"` range.
 */
const HOST_PROVIDED = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "@sinclair/typebox",
  "typebox",
];

const manifest = JSON.parse(
  await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
);

test("host-provided packages are declared as peers with a * range", () => {
  for (const name of HOST_PROVIDED) {
    const range = manifest.peerDependencies?.[name];
    if (range === undefined) continue;
    assert.equal(range, "*", `${name} must use the "*" peer range, got "${range}"`);
    assert.ok(manifest.peerDependenciesMeta?.[name]?.optional, `${name} must be an optional peer`);
  }
});

test("host-provided packages never appear in dependencies", () => {
  const offenders = Object.keys(manifest.dependencies ?? {}).filter((name) =>
    HOST_PROVIDED.includes(name),
  );
  assert.deepEqual(offenders, []);
});
