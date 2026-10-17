import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sha256 } from "./release-source.mjs";
import { mergeReviewedRecipes } from "./catalog-plan.mjs";

const recipe = JSON.parse(readFileSync(new URL("../catalog/catalog.json", import.meta.url)));
const products = [
  ["meridian", "Glivela", "Glivela", "74a3c30be25e8346e97a265398babf6a3de83129b19e953296fe8bc94626e4c0"],
  ["pulse", "Senulun", "Senulun 监控主机", "4e3a01566d67cc1ab7a691dd55ea3e301dd5f016eef6ab4001f18b36e0d75c5a"],
  ["pulse-agent", "Senulun Agent", "Senulun 探针", "d3267f6d22115fe9f9d7f879400372890e779cd9efda32a82371c08ddf014a35"],
];

test("branding changes display metadata, not installation or artifact identities", () => {
  for (const [id, en, zh, machineDigest] of products) {
    const app = recipe.apps.find(item => item.id === id);
    assert.deepEqual(app.name, { en, "zh-CN": zh });
    assert.equal(app.packageRevision, 2);
    const identity = structuredClone(app);
    delete identity.name;
    delete identity.description;
    delete identity.packageRevision;
    identity.config = identity.config.map(({ label, description, ...field }) => field);
    // Reviewed baseline includes Glivela alpha.22 and all executable,
    // data path, user, config key, service, capability, image and artifact fields.
    assert.equal(sha256(JSON.stringify(identity)), machineDigest);
  }
  assert.ok(!recipe.apps.some(app => ["glivela", "senulun", "senulun-agent"].includes(app.id)));
});

test("brand metadata does not roll back a later published upstream version", () => {
  const active = structuredClone(recipe);
  for (const [id] of products) {
    const app = active.apps.find(item => item.id === id);
    app.version = "0.2.0";
    app.packageRevision = 1;
    for (const image of app.images ?? []) image.reference = "accepted-image-digest";
    for (const artifact of app.artifacts ?? []) {
      artifact.url = "https://example.invalid/accepted-artifact";
      artifact.sha256 = "a".repeat(64);
    }
  }
  const merged = mergeReviewedRecipes(recipe, active);
  for (const [id, en] of products) {
    const app = merged.apps.find(item => item.id === id);
    assert.equal(app.name.en, en);
    assert.equal(app.version, "0.2.0");
    assert.equal(app.packageRevision, 2);
    for (const image of app.images ?? []) assert.equal(image.reference, "accepted-image-digest");
    for (const artifact of app.artifacts ?? []) {
      assert.equal(artifact.url, "https://example.invalid/accepted-artifact");
      assert.equal(artifact.sha256, "a".repeat(64));
    }
  }
});
