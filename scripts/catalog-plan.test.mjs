import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { choosePlan, mergeReviewedRecipes, preparePublication } from "./catalog-plan.mjs";
import { sha256 } from "./release-source.mjs";

const commit = "a".repeat(40), recipesSHA256 = "b".repeat(64);
const now = new Date("2026-09-26T00:00:00Z");
const reviewed = { schemaVersion: 3, apps: [{ id: "pulse", version: "0.1.0-alpha.4", images: [{ name: "pulse", reference: "old" }] }] };
function setup({ draft = false, expired = false } = {}) {
  const target = Buffer.from(JSON.stringify({ catalog: reviewed, expiresAt: expired ? "2026-09-25T00:00:00Z" : "2026-10-03T00:00:00Z" }));
  const digest = sha256(target);
  const inputCatalog = Buffer.from(JSON.stringify(reviewed));
  const bundle = { schemaVersion: 1, revision: 7, commit, catalogSHA256: sha256(inputCatalog), inputCatalog: inputCatalog.toString("base64"), request: { kind: "reviewed" }, recipesSHA256, files: Object.fromEntries(Object.entries({ "publication-state.json": JSON.stringify({ revision: 7, channel: "stable", sha256: digest }), "manifest-history.json": '{"pulse":{"0.1.0-alpha.4":"digest"}}', [`targets/${digest}.stable.json`]: target, "timestamp.json": "{}", "7.targets.json": "{}", "7.snapshot.json": "{}" }).map(([name, bytes]) => [name, Buffer.from(bytes).toString("base64")])) };
  return { releases: [{ tag_name: "catalog-r7", target_commitish: commit, draft }], bundles: new Map([["catalog-r7", bundle]]), commit, request: { kind: "reviewed" }, reviewed, recipesSHA256, now };
}

test("allocates monotonic revisions under the serialized workflow", () => {
  assert.equal(choosePlan(setup()).revision, 8);
  assert.equal(choosePlan(setup({ expired: true })).revision, 8);
  assert.throws(() => choosePlan({ ...setup(), releases: [] }), /existing history/);
});

test("catalog publication only has a manual trigger", () => {
  const workflow = readFileSync(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /(^|\n)\s*schedule:/);
  assert.doesNotMatch(workflow, /\bpoll\b|\brenew\b|CATALOG_NOTIFY|create-github-app-token/);
});

test("pending publication only resumes original commit/request/recipe and exact signed input", () => {
  const input = setup({ draft: true });
  const next = choosePlan(input);
  assert.equal(next.revision, 7); assert.equal(next.resume, true);
  assert.equal(next.catalogBytes.toString(), JSON.stringify(reviewed));
  for (const override of [{ commit: "c".repeat(40) }, { request: { application: "pulse" } }, { recipesSHA256: "c".repeat(64) }]) assert.throws(() => choosePlan({ ...input, ...override }), /Pending/);
  assert.throws(() => choosePlan(setup({ draft: true, expired: true })), /expired/);
});

test("reviewed recipes never silently revert automatic upstream version or digest", () => {
  const active = structuredClone(reviewed); active.apps[0].version = "0.1.0-alpha.5"; active.apps[0].images[0].reference = "accepted";
  const merged = mergeReviewedRecipes(reviewed, active);
  assert.equal(merged.apps[0].version, "0.1.0-alpha.5"); assert.equal(merged.apps[0].images[0].reference, "accepted");
  const newerRecipe = structuredClone(reviewed);
  newerRecipe.apps[0].packageRevision = 2;
  const olderRecipe = structuredClone(reviewed);
  olderRecipe.apps[0].packageRevision = 1;
  assert.throws(() => mergeReviewedRecipes(olderRecipe, newerRecipe), /revision rollback/);
});

test("a reviewed same-version recipe revision can change its pinned artifact without being overwritten", () => {
  const active = structuredClone(reviewed);
  const changed = structuredClone(reviewed);
  changed.apps[0].packageRevision = 2;
  changed.apps[0].images[0].reference = "security-fixed";
  const merged = mergeReviewedRecipes(changed, active);
  assert.equal(merged.apps[0].packageRevision, 2);
  assert.equal(merged.apps[0].images[0].reference, "security-fixed");
});

test("disabled production never contacts GitHub or creates a signing plan", async () => {
  let contacted = false;
  await assert.rejects(preparePublication({ GITHUB_REPOSITORY: "petauron/catalog", GITHUB_REF: "refs/heads/main", CATALOG_PRODUCTION_ENABLED: "false" }, () => { contacted = true; }), /disabled/);
  assert.equal(contacted, false);
});

test("production recipes use schema 4 and reviewed runtime declarations", () => {
  const recipe = JSON.parse(readFileSync(new URL("../catalog/catalog.json", import.meta.url)));
  assert.equal(recipe.schemaVersion, 4);
  assert.ok(recipe.apps.every(app => app.packageRevision > 0 && app.runtime?.version === 1));
  const plan = readFileSync(new URL("./catalog-plan.mjs", import.meta.url), "utf8");
  assert.match(plan, /readFileSync\("catalog\/catalog.json"\)/);
  assert.doesNotMatch(plan, /legacyV3: true|vastora-v3-catalog-check/);
});

test("schema 4 cutover preserves published v3 versions and coordinates", () => {
  const recipe = { schemaVersion: 4, apps: [{...reviewed.apps[0], packageRevision: 1, runtime: {kind: "docker", version: 1}}] };
  const active = structuredClone(reviewed);
  active.apps[0].version = "0.1.0-alpha.6";
  active.apps[0].images[0].reference = "published-digest";
  const merged = mergeReviewedRecipes(recipe, active);
  assert.equal(merged.schemaVersion, 4);
  assert.equal(merged.apps[0].version, "0.1.0-alpha.6");
  assert.equal(merged.apps[0].images[0].reference, "published-digest");
  assert.deepEqual(merged.apps[0].runtime, recipe.apps[0].runtime);
  assert.equal(merged.apps[0].packageRevision, 1);
});
