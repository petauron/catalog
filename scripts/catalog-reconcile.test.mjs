import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  checkAgentReleaseReady,
  findVerifiedSourceRun,
  isCircuitOpen,
  reconcileCatalog,
  selectCandidateRelease,
} from "./catalog-reconcile.mjs";

const registry = JSON.parse(readFileSync(new URL("../catalog/sources.json", import.meta.url), "utf8"));
const senlunRule = registry.sources.senlun;
const sha = "a".repeat(40);

test("circuit breaker trips after two automated failures since last publication and ignores noop runs", () => {
  const sinceIso = "2026-11-22T05:00:00Z";
  assert.deepEqual(
    isCircuitOpen([
      { id: 12, run_number: 12, event: "schedule", status: "completed", conclusion: "success", created_at: "2026-11-22T05:30:00Z" },
      { id: 10, run_number: 10, event: "schedule", status: "completed", conclusion: "failure", created_at: "2026-11-22T05:15:00Z" },
      { id: 9, run_number: 9, event: "repository_dispatch", status: "completed", conclusion: "failure", created_at: "2026-11-22T05:05:00Z" },
    ], { currentRunId: "13", sinceIso }),
    { open: true, failures: 2 },
  );
  assert.deepEqual(
    isCircuitOpen([
      { id: 11, run_number: 11, event: "workflow_dispatch", status: "completed", conclusion: "success", created_at: "2026-11-22T05:20:00Z" },
      { id: 10, run_number: 10, event: "schedule", status: "completed", conclusion: "failure", created_at: "2026-11-22T05:15:00Z" },
      { id: 9, run_number: 9, event: "schedule", status: "completed", conclusion: "failure", created_at: "2026-11-22T05:05:00Z" },
    ], { currentRunId: "12", sinceIso }),
    { open: false, failures: 0 },
  );
  assert.deepEqual(
    isCircuitOpen([
      { id: 10, run_number: 10, event: "schedule", status: "completed", conclusion: "failure", created_at: "2026-11-22T04:55:00Z" },
      { id: 9, run_number: 9, event: "schedule", status: "completed", conclusion: "failure", created_at: "2026-11-22T04:40:00Z" },
    ], { currentRunId: "11", sinceIso }),
    { open: false, failures: 0 },
  );
});

test("selectCandidateRelease picks highest newer stable release and excludes drafts/prereleases/agent tags", () => {
  const releases = [
    { tag_name: "senlun-agent-v0.1.2", draft: false, prerelease: false, published_at: "2026-11-22T01:00:00Z" },
    { tag_name: "v0.1.3-alpha.1", draft: false, prerelease: true, published_at: "2026-11-22T02:00:00Z" },
    { tag_name: "v0.1.2", draft: true, prerelease: false, published_at: null },
    { tag_name: "v0.1.1", draft: false, prerelease: false, published_at: "2026-11-22T01:00:00Z" },
    { tag_name: "v0.1.0", draft: false, prerelease: false, published_at: "2026-11-21T01:00:00Z" },
  ];
  assert.equal(selectCandidateRelease(releases, "0.1.0", senlunRule)?.tag_name, "v0.1.1");
  assert.equal(selectCandidateRelease(releases, "0.1.1", senlunRule), null);
  assert.equal(
    selectCandidateRelease(releases, "0.1.1", { ...senlunRule, autoPublish: { enabled: true, allowPrerelease: true } })?.tag_name,
    "v0.1.3-alpha.1",
  );
  assert.equal(
    selectCandidateRelease(releases, "0.1.0", { ...senlunRule, autoPublish: { enabled: false, allowPrerelease: false } }),
    null,
  );
});

test("findVerifiedSourceRun admits in-progress push run once publishing job succeeded", () => {
  const runs = [
    {
      id: 42,
      run_number: 187,
      event: "push",
      path: senlunRule.workflow,
      head_sha: sha,
      head_branch: "main",
      repository: { full_name: senlunRule.repository },
      head_repository: { full_name: senlunRule.repository },
      status: "in_progress",
    },
    {
      id: 41,
      run_number: 186,
      event: "workflow_dispatch",
      path: senlunRule.workflow,
      head_sha: sha,
      head_branch: "main",
      repository: { full_name: senlunRule.repository },
      head_repository: { full_name: senlunRule.repository },
      status: "completed",
    },
  ];
  const matched = findVerifiedSourceRun(
    runs,
    () => [{ name: senlunRule.publishJob, status: "completed", conclusion: "success" }],
    senlunRule,
    sha,
    "v0.1.1",
  );
  assert.equal(matched?.id, 42);
  const pending = findVerifiedSourceRun(
    runs,
    () => [{ name: senlunRule.publishJob, status: "in_progress", conclusion: null }],
    senlunRule,
    sha,
    "v0.1.1",
  );
  assert.equal(pending, null);
});

test("checkAgentReleaseReady waits when bumped Agent release is still draft or missing", () => {
  const versionFile = version => ({
    type: "file",
    encoding: "base64",
    size: Buffer.byteLength(`${version}\n`),
    content: Buffer.from(`${version}\n`).toString("base64"),
  });
  assert.deepEqual(
    checkAgentReleaseReady(senlunRule, sha, "0.1.0", endpoint => {
      if (endpoint.startsWith("contents/crates/senlun-agent/version.txt")) return versionFile("0.1.0");
      throw new Error("should not query agent release when unchanged");
    }),
    { ready: true, agentVersion: "0.1.0" },
  );
  const missing = checkAgentReleaseReady(senlunRule, sha, "0.1.0", endpoint => {
    if (endpoint.startsWith("contents/crates/senlun-agent/version.txt")) return versionFile("0.1.1");
    throw new Error("404");
  });
  assert.equal(missing.ready, false);
  const published = checkAgentReleaseReady(senlunRule, sha, "0.1.0", endpoint => {
    if (endpoint.startsWith("contents/crates/senlun-agent/version.txt")) return versionFile("0.1.1");
    return {
      tag_name: "senlun-agent-v0.1.1",
      draft: false,
      published_at: "2026-11-22T05:50:00Z",
      target_commitish: sha,
      author: { login: "github-actions[bot]" },
      assets: [],
    };
  });
  assert.deepEqual(published, { ready: true, agentVersion: "0.1.1" });
});

test("reconcileCatalog respects kill switch without calling GitHub", () => {
  let called = false;
  const result = reconcileCatalog(
    {
      GITHUB_REPOSITORY: "petauron/catalog",
      GITHUB_REF: "refs/heads/main",
      CATALOG_AUTOPUBLISH_DISABLED: "true",
    },
    () => {
      called = true;
      return "{}";
    },
  );
  assert.equal(result.publish, false);
  assert.equal(called, false);
});
