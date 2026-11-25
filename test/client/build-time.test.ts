import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BUILD_TIME } from "../../src/client/auth/build-time.ts";
import { FALLBACK_CRL_BUILD_TIME, FALLBACK_CRL_DEFAULT_BUILD_TIME } from "../../src/client/auth/trust-data.ts";
import { buildTimeMs, stampFile } from "../../scripts/stamp-build-time.mjs";

test("a source checkout is unstamped and uses the default window start", () => {
  assert.equal(BUILD_TIME, undefined);
  assert.equal(FALLBACK_CRL_BUILD_TIME, FALLBACK_CRL_DEFAULT_BUILD_TIME);
});

test("stampFile rewrites the ESM and CommonJS emit of build-time.ts", () => {
  const dir = mkdtempSync(join(tmpdir(), "stamp-"));
  try {
    const esm = join(dir, "esm.js");
    const cjs = join(dir, "cjs.js");
    writeFileSync(esm, "export const BUILD_TIME = undefined;\n");
    writeFileSync(cjs, '"use strict";\nexports.BUILD_TIME = undefined;\n');
    stampFile(esm, 1234567890123);
    stampFile(cjs, 1234567890123);
    assert.equal(readFileSync(esm, "utf8"), "export const BUILD_TIME = 1234567890123;\n");
    assert.equal(readFileSync(cjs, "utf8"), '"use strict";\nexports.BUILD_TIME = 1234567890123;\n');
    assert.throws(() => stampFile(esm, 1), /no "BUILD_TIME = undefined"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the build time is now, or SOURCE_DATE_EPOCH when set", () => {
  const before = Date.now();
  const now = buildTimeMs({});
  assert.ok(now >= before && now <= Date.now());
  assert.equal(buildTimeMs({ SOURCE_DATE_EPOCH: "1700000000" }), 1700000000000);
  assert.throws(() => buildTimeMs({ SOURCE_DATE_EPOCH: "soon" }));
});
