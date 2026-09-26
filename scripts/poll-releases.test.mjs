import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { discoverRelease } from "./poll-releases.mjs";

const registry = JSON.parse(readFileSync(new URL("../catalog/sources.json", import.meta.url)));
const sha = "a".repeat(40);
const catalog = { apps: [{ id: "pulse", version: "0.1.0-alpha.4" }, { id: "pulse-agent", version: "0.1.0-alpha.3" }] };
const release = tag => ({ tag_name: tag, draft: false, published_at: "2026-09-26T00:00:00Z" });
function mock(releases, { success = true, annotated = false, wrongSHA = false } = {}) {
  const calls = [];
  const run = (cmd, args) => {
    assert.equal(cmd, "gh");
    const endpoint = args.at(-1); calls.push(endpoint);
    if (endpoint.endsWith("releases?per_page=100")) return JSON.stringify(releases);
    if (endpoint.includes("git/ref/tags/")) return JSON.stringify({ object: { type: annotated ? "tag" : "commit", sha } });
    if (endpoint.includes("git/tags/")) return JSON.stringify({ object: { type: "commit", sha } });
    if (endpoint.includes("actions/workflows/")) return JSON.stringify({ workflow_runs: [{ id: 42, head_sha: wrongSHA ? "b".repeat(40) : sha, path: ".github/workflows/release.yml", event: "push" }] });
    if (endpoint.includes("/jobs?")) return JSON.stringify({ jobs: [{ name: "Publish GitHub release", status: "completed", conclusion: success ? "success" : "failure" }] });
    throw new Error("Unexpected API");
  };
  return { run, calls };
}
test("poll chooses semantic newest alpha, ignoring drafts and API ordering", () => {
  const m = mock([release("v0.1.0-alpha.5"), release("v0.1.0-alpha.10"), { ...release("v1.0.0"), draft: true }, release("bad")], { annotated: true });
  assert.deepEqual(discoverRelease("pulse", registry, catalog, m.run), { application: "pulse", tag: "v0.1.0-alpha.10", sha, runId: "42" });
});
test("equal versions and old releases do not query builds or publish", () => {
  const m = mock([release("v0.1.0-alpha.2")]);
  assert.equal(discoverRelease("pulse", registry, catalog, m.run), null);
  assert.equal(m.calls.length, 1);
  const equal = structuredClone(catalog); equal.apps[1].version = equal.apps[0].version;
  assert.equal(discoverRelease("pulse", registry, equal, mock([release("v0.1.0-alpha.4")]).run), null);
});
test("Service and Agent mappings catch up independently without downgrade", () => {
  assert.equal(discoverRelease("pulse", registry, catalog, mock([release("v0.1.0-alpha.4")]).run).tag, "v0.1.0-alpha.4");
});
test("failed publishing and mismatched commit block latest rather than fallback", () => {
  for (const options of [{ success: false }, { wrongSHA: true }]) {
    assert.throws(() => discoverRelease("pulse", registry, catalog, mock([release("v0.1.0-alpha.6"), release("v0.1.0-alpha.5")], options).run), /successful publishing/);
  }
});
test("source prerelease policy is enforced and unknown source fails before requests", () => {
  const stable = structuredClone(registry); stable.sources.pulse.allowPrerelease = false;
  assert.equal(discoverRelease("pulse", stable, catalog, mock([release("v0.1.0-alpha.5")]).run), null);
  assert.throws(() => discoverRelease("unknown", registry, catalog, () => assert.fail("network")), /source policy/);
});
test("workflow polls without cross-repository notification credentials", () => {
  const workflow = readFileSync(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
  assert.match(workflow, /13,43 \* \* \* \*/);
  assert.match(workflow, /'schedule' && 'poll'/);
  assert.doesNotMatch(workflow, /CATALOG_NOTIFY|create-github-app-token/);
  assert.match(workflow, /queue: max/);
});
