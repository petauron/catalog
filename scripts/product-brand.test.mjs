import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sha256 } from "./release-source.mjs";
import { mergeReviewedRecipes } from "./catalog-plan.mjs";

const recipe = JSON.parse(readFileSync(new URL("../catalog/catalog.json", import.meta.url)));
const products = [
  ["meridian", "Glivela", "Glivela", "3de97a56ecaefb7197d819800eba5adc005dcb4934d1eb298a5b152f296b6621"],
  ["pulse", "Senulun", "Senulun 监控主机", "f6fa93043b3f87659559d03e438879a2df90a359f0e5e046be8de45252cd86b3"],
  ["pulse-agent", "Senulun Agent", "Senulun 探针", "94e31046266627401232c4fea0352da453477ce7724cdf3b042eeca1ebd9d05e"],
];

test("branding changes display metadata, not installation or artifact identities", () => {
  for (const [id, en, zh, machineDigest] of products) {
    const app = recipe.apps.find(item => item.id === id);
    assert.deepEqual(app.name, { en, "zh-CN": zh });
    assert.equal(app.packageRevision, id === "meridian" ? 5 : 3);
    const identity = structuredClone(app);
    delete identity.name;
    delete identity.description;
    delete identity.packageRevision;
    identity.config = identity.config.map(({ label, description, ...field }) => field);
    // Reviewed baseline includes Glivela alpha.75 release coordinates, managed panel credential binding and the retained controller port 19443, standalone Senulun inputs and all executable,
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
    assert.equal(app.packageRevision, id === "meridian" ? 5 : 3);
    for (const image of app.images ?? []) assert.equal(image.reference, "accepted-image-digest");
    for (const artifact of app.artifacts ?? []) {
      assert.equal(artifact.url, "https://example.invalid/accepted-artifact");
      assert.equal(artifact.sha256, "a".repeat(64));
    }
  }
});
