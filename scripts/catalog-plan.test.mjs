import test from "node:test";
import assert from "node:assert/strict";
import { choosePlan, mergeReviewedRecipes, preparePublication } from "./catalog-plan.mjs";
import { sha256 } from "./release-source.mjs";

const commit = "a".repeat(40), recipesSHA256 = "b".repeat(64);
const now = new Date("2026-09-26T00:00:00Z");
const reviewed = { schemaVersion: 4, apps: [{ id: "pulse", version: "0.1.0-alpha.4", packageRevision: 1, images: [{ name: "pulse", reference: "old" }] }] };
function setup({ draft = false, expired = false } = {}) {
  const target = Buffer.from(JSON.stringify({ catalog: reviewed, expiresAt: expired ? "2026-09-25T00:00:00Z" : "2026-10-03T00:00:00Z" }));
  const digest = sha256(target);
  const inputCatalog = Buffer.from(JSON.stringify(reviewed));
  const bundle = { schemaVersion: 1, revision: 7, commit, catalogSHA256: sha256(inputCatalog), inputCatalog: inputCatalog.toString("base64"), request: { kind: "renew" }, recipesSHA256, files: Object.fromEntries(Object.entries({ "publication-state.json": JSON.stringify({ revision: 7, channel: "stable", sha256: digest }), "manifest-history.json": '{"pulse":{"0.1.0-alpha.4":"digest"}}', [`targets/${digest}.stable.json`]: target, "timestamp.json": "{}", "7.targets.json": "{}", "7.snapshot.json": "{}" }).map(([name, bytes]) => [name, Buffer.from(bytes).toString("base64")])) };
  return { releases: [{ tag_name: "catalog-r7", target_commitish: commit, draft }], bundles: new Map([["catalog-r7", bundle]]), commit, request: { kind: "renew" }, reviewed, recipesSHA256, now };
}

test("allocates monotonic revisions under the serialized workflow and detects renewal window", () => {
  assert.equal(choosePlan(setup()).revision, 8);
  assert.equal(choosePlan(setup()).renewalDue, false);
  assert.equal(choosePlan(setup({ expired: true })).renewalDue, true);
  assert.throws(() => choosePlan({ ...setup(), releases: [] }), /existing history/);
});

test("pending publication only resumes original commit/request/recipe and exact signed input", () => {
  const input = setup({ draft: true });
  const next = choosePlan(input);
  assert.equal(next.revision, 7); assert.equal(next.resume, true);
  assert.equal(next.catalogBytes.toString(), JSON.stringify(reviewed));
  for (const override of [{ commit: "c".repeat(40) }, { request: { kind: "reviewed" } }, { recipesSHA256: "c".repeat(64) }]) assert.throws(() => choosePlan({ ...input, ...override }), /Pending/);
  assert.throws(() => choosePlan(setup({ draft: true, expired: true })), /expired/);
});

test("a pending poll preserves exact bytes and revision without rediscovery", () => {
  const input = setup({ draft: true });
  input.request = { kind: "poll" };
  input.bundles.get("catalog-r7").request = input.request;
  const plan = choosePlan(input);
  assert.equal(plan.resume, true);
  assert.equal(plan.revision, 7);
  assert.equal(plan.catalogBytes.toString(), JSON.stringify(reviewed));
});

test("reviewed recipes never silently revert automatic upstream version or digest", () => {
  const active = structuredClone(reviewed); active.apps[0].version = "0.1.0-alpha.5"; active.apps[0].images[0].reference = "accepted";
  const merged = mergeReviewedRecipes(reviewed, active);
  assert.equal(merged.apps[0].version, "0.1.0-alpha.5"); assert.equal(merged.apps[0].images[0].reference, "accepted");
  active.apps[0].packageRevision = 2;
  assert.throws(() => mergeReviewedRecipes(reviewed, active), /revision rollback/);
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
