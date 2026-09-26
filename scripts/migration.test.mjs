import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadImportedLedger } from "./catalog-plan.mjs";
import { sha256 } from "./release-source.mjs";

test("historical revisions retain original upstream commit, exact metadata and signed bytes", () => {
  const directory = new URL("../catalog/legacy-ledger/", import.meta.url).pathname;
  const imported = loadImportedLedger(directory);
  assert.ok(imported.length >= 6);
  const latest = imported.find(item => item.release.tag_name === "catalog-r7");
  assert.equal(latest.release.target_commitish, "e98968df7625fe50826aeae966524c1f389997aa");
  assert.equal(sha256(latest.bytes), "a2d00f9fa177feee806e9efbec2ed3de3f618b86bd4d29c94091fab25e188f5e");
  assert.equal(sha256(readFileSync(new URL("../catalog/trust/1.root.json", import.meta.url))), "12a54c90500e312440b6429a07d57ab119f6e97d5dc194924e0d77d1839e42f6");
});

test("signing workflow remains serialized and secrets are not exposed to source resolution", () => {
  const workflow = readFileSync(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
  assert.match(workflow, /queue: max/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /test "\$CATALOG_PRODUCTION_ENABLED" = true/);
  assert.ok(workflow.indexOf("node scripts/catalog-plan.mjs") < workflow.indexOf("CATALOG_SIGNERS:"));
  assert.ok(!workflow.includes("pull_request_target"));
  assert.ok(!workflow.includes("git push"));
});
