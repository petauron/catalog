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

test("catalog publication isolates unprivileged discovery from protected signing", () => {
  const workflow = readFileSync(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /options:\s*\[release,\s*reviewed,\s*reconcile\]/);
  assert.match(workflow, /repository_dispatch:\s*\n\s*types:\s*\[catalog-reconcile\]/);
  assert.match(workflow, /(^|\n)\s*schedule:\s*\n\s*-\s*cron:\s*"17 \*\/6 \* \* \*"/);
  assert.match(workflow, /CATALOG_AUTOPUBLISH_DISABLED/);
  assert.doesNotMatch(workflow, /github\.event\.client_payload|create-github-app-token|CATALOG_NOTIFY/);
  const discoverStart = workflow.indexOf("  discover:");
  const mirrorStart = workflow.indexOf("  mirror-glivela:");
  const publishStart = workflow.indexOf("  publish:");
  assert.ok(discoverStart > 0 && mirrorStart > discoverStart && publishStart > mirrorStart);
  const discoverBlock = workflow.slice(discoverStart, mirrorStart);
  const mirrorBlock = workflow.slice(mirrorStart, publishStart);
  const publishBlock = workflow.slice(publishStart);
  assert.ok(discoverBlock.includes("node scripts/catalog-reconcile.mjs"));
  assert.ok(discoverBlock.includes("inputs.kind == 'reconcile'"));
  assert.ok(discoverBlock.includes("contents: write"), "discover needs contents:write to see draft releases fail-closed");
  assert.ok(!discoverBlock.includes("environment: catalog-signing"));
  assert.ok(!discoverBlock.includes("CATALOG_SIGNERS"));
  assert.ok(!discoverBlock.includes("R2_SECRET_ACCESS_KEY"));
  assert.ok(mirrorBlock.includes("environment: catalog-signing"));
  assert.ok(!mirrorBlock.includes("CATALOG_SIGNERS"), "mirror-glivela must never receive TUF signing keys");
  assert.ok(!mirrorBlock.includes("meridian-ui"), "mirror-glivela must never run upstream UI builds");
  assert.ok(mirrorBlock.indexOf("node scripts/stage-glivela-native.mjs") < mirrorBlock.indexOf("R2_SECRET_ACCESS_KEY"), "Glivela provenance staging must run before R2 credentials");
  assert.ok(mirrorBlock.includes("node scripts/mirror-glivela-native.mjs"));
  assert.ok(publishBlock.includes("needs: [discover, mirror-glivela]"));
  assert.ok(publishBlock.includes("needs.mirror-glivela.result == 'success' || needs.mirror-glivela.result == 'skipped'"));
  assert.ok(publishBlock.includes("!cancelled()"), "publish must include !cancelled() so skipped discover or mirror-glivela does not skip publish");
  assert.ok(publishBlock.includes("inputs.kind != 'reconcile'"), "manual reconcile must pass discovered outputs to publish");
  assert.ok(publishBlock.includes("CATALOG_RECONCILED:"), "publish must mark reconciled runs so drafts are never auto-resumed");
  assert.ok(publishBlock.indexOf("Build independent Glivela UI without publication credentials") < publishBlock.indexOf("CATALOG_SIGNERS:"), "Glivela UI build must stay isolated from signing credentials");
});

test("pending publication only resumes original commit/request/recipe on manual workflow_dispatch", () => {
  const input = setup({ draft: true });
  const next = choosePlan(input);
  assert.equal(next.revision, 7); assert.equal(next.resume, true);
  assert.equal(next.catalogBytes.toString(), JSON.stringify(reviewed));
  assert.throws(() => choosePlan({ ...input, allowDraftResume: false }), /automated publication/);
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
  for (const app of recipe.apps) {
    assert.ok(app.packageRevision > 0);
    const glivela = ["glivela-entry", "glivela-node", "glivela-dual"].includes(app.id);
    const staticSite = ["static-site", "static-site-https", "daylight", "daylight-https"].includes(app.id);
    const senlunAgent = app.id === "senlun-agent";
    assert.equal(app.runtime?.version, glivela || staticSite || senlunAgent ? 2 : 1);
    const portable = ["glivela-entry", "senlun-agent", "daylight", "daylight-https"].includes(app.id);
    if (glivela || staticSite || senlunAgent) assert.equal(app.runtime.kind, portable ? "native" : "systemd");
    if (glivela) {
      assert.equal(app.runtime.kind, portable ? "native" : "systemd");
      assert.equal(app.runtime.nativeServices.namespace, "glivela");
      assert.deepEqual(app.runtime.nativeServices.services.map(service => service.name), app.id === "glivela-dual" ? ["node", "entry-xray", "landing-xray"] : ["node", "xray", "companion-xray"]);
    }
  }
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
