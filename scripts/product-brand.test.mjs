import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sha256 } from "./release-source.mjs";
import { mergeReviewedRecipes } from "./catalog-plan.mjs";

const recipe = JSON.parse(readFileSync(new URL("../catalog/catalog.json", import.meta.url)));
const products = [
  ["meridian", "Glivela", "Glivela", "961002ddad89947db94ef1165ce6e505d24f03538615d00890ddae4a23f63f26"],
  ["senlun", "Senlun", "Senlun", "228c5818adbf51da6cc9825d84e523b913c19f0f5d57e730fe46e6f95f599133"],
  ["senlun-agent", "Senlun Agent", "Senlun 探针", "979931c62a87cad39ba5a8da3298b1558d8a765094c5e4de50c7da810b565308"],
];

test("reviewed product identities and release coordinates are pinned", () => {
  for (const [id, en, zh, machineDigest] of products) {
    const app = recipe.apps.find(item => item.id === id);
    assert.deepEqual(app.name, { en, "zh-CN": zh });
    assert.equal(app.packageRevision, id === "senlun-agent" ? 9 : 5);
    const identity = structuredClone(app);
    delete identity.name;
    delete identity.description;
    delete identity.packageRevision;
    identity.config = identity.config.map(({ label, description, ...field }) => field);
    // Reviewed baseline includes Glivela alpha.124 release coordinates, managed panel credential binding and the retained controller port 19443, standalone Senlun inputs, the portable native probe contract with its optional explicit management proxy and all executable,
    // data path, user, config key, service, capability, image and artifact fields.
    assert.equal(sha256(JSON.stringify(identity)), machineDigest);
  }
  assert.ok(!recipe.apps.some(app => ["glivela", "pulse", "pulse-agent", "senulun", "senulun-agent"].includes(app.id)));
});

test("brand metadata does not roll back a later published upstream version", () => {
  const active = structuredClone(recipe);
  for (const [id] of products) {
    const app = active.apps.find(item => item.id === id);
    app.version = "0.2.0";
    app.packageRevision = id === "meridian" ? 1 : 4;
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
    assert.equal(app.packageRevision, id === "senlun-agent" ? 9 : 5);
    for (const image of app.images ?? []) assert.equal(image.reference, "accepted-image-digest");
    for (const artifact of app.artifacts ?? []) {
      assert.equal(artifact.url, "https://example.invalid/accepted-artifact");
      assert.equal(artifact.sha256, "a".repeat(64));
    }
  }
});
