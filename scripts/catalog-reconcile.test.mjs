import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  checkAgentReleaseReady,
  checkSourceCIReady,
  findVerifiedSourceRun,
  isCircuitOpen,
  reconcileCatalog,
  selectCandidateRelease,
} from "./catalog-reconcile.mjs";

const registry = JSON.parse(readFileSync(new URL("../catalog/sources.json", import.meta.url), "utf8"));
const senlunRule = registry.sources.senlun;
const glivelaRule = registry.sources.glivela;
const sha = "a".repeat(40);

test("circuit breaker trips on two publish-job failures since last publication and resets on manual success", () => {
  const sinceIso = "2026-11-22T05:00:00Z";
  const failedRuns = [
    { id: 10, run_number: 10, event: "schedule", status: "completed", conclusion: "failure", run_started_at: "2026-11-22T05:15:00Z" },
    { id: 9, run_number: 9, event: "repository_dispatch", status: "completed", conclusion: "failure", run_started_at: "2026-11-22T05:05:00Z" },
  ];
  const publishFailedJobs = () => [{ name: "publish", conclusion: "failure" }];
  assert.deepEqual(
    isCircuitOpen(failedRuns, [], { currentRunId: "13", sinceIso, jobsForRun: publishFailedJobs }),
    { open: true, failures: 2 },
  );
  // Transient discover-only blips do not latch the permanent publish circuit breaker.
  assert.deepEqual(
    isCircuitOpen(failedRuns, [], {
      currentRunId: "13",
      sinceIso,
      jobsForRun: () => [{ name: "discover", conclusion: "failure" }],
    }),
    { open: false, failures: 0 },
  );
  // Repeated mirror-glivela failures also trip the circuit breaker.
  assert.deepEqual(
    isCircuitOpen(failedRuns, [], {
      currentRunId: "13",
      sinceIso,
      jobsForRun: () => [{ name: "mirror-glivela", conclusion: "failure" }, { name: "publish", conclusion: "skipped" }],
    }),
    { open: true, failures: 2 },
  );
  // A successful manual workflow_dispatch where publish ran resets the breaker,
  // whereas a manual reconcile no-op (publish skipped) does not reset it.
  assert.deepEqual(
    isCircuitOpen(
      failedRuns,
      [{ id: 11, run_number: 11, event: "workflow_dispatch", status: "completed", conclusion: "success", run_started_at: "2026-11-22T05:20:00Z" }],
      {
        currentRunId: "12",
        sinceIso,
        jobsForRun: runId => (runId === 11 ? [{ name: "publish", conclusion: "skipped" }] : [{ name: "publish", conclusion: "failure" }]),
      },
    ),
    { open: true, failures: 2 },
  );
  assert.deepEqual(
    isCircuitOpen(
      failedRuns,
      [{ id: 11, run_number: 11, event: "workflow_dispatch", status: "completed", conclusion: "success", run_started_at: "2026-11-22T05:20:00Z" }],
      {
        currentRunId: "12",
        sinceIso,
        jobsForRun: runId => (runId === 11 ? [{ name: "publish", conclusion: "success" }] : [{ name: "publish", conclusion: "failure" }]),
      },
    ),
    { open: false, failures: 0 },
  );
  // Failures prior to latest catalog publication do not count.
  assert.deepEqual(
    isCircuitOpen(
      [
        { id: 10, run_number: 10, event: "schedule", status: "completed", conclusion: "failure", run_started_at: "2026-11-22T04:55:00Z" },
        { id: 9, run_number: 9, event: "schedule", status: "completed", conclusion: "failure", run_started_at: "2026-11-22T04:40:00Z" },
      ],
      [],
      { currentRunId: "11", sinceIso, jobsForRun: publishFailedJobs },
    ),
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

test("checkAgentReleaseReady verifies published release, assets, prerelease policy, and tag commit", () => {
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
  const noAssets = checkAgentReleaseReady(senlunRule, sha, "0.1.0", endpoint => {
    if (endpoint.startsWith("contents/crates/senlun-agent/version.txt")) return versionFile("0.1.1");
    if (endpoint.startsWith("git/ref/tags/")) return { object: { type: "commit", sha } };
    return {
      tag_name: "senlun-agent-v0.1.1",
      draft: false,
      prerelease: false,
      published_at: "2026-11-22T05:50:00Z",
      target_commitish: sha,
      author: { login: "github-actions[bot]" },
      assets: [],
    };
  });
  assert.equal(noAssets.ready, false);
  const published = checkAgentReleaseReady(senlunRule, sha, "0.1.0", endpoint => {
    if (endpoint.startsWith("contents/crates/senlun-agent/version.txt")) return versionFile("0.1.1");
    if (endpoint.startsWith("git/ref/tags/")) return { object: { type: "commit", sha } };
    return {
      tag_name: "senlun-agent-v0.1.1",
      draft: false,
      prerelease: false,
      published_at: "2026-11-22T05:50:00Z",
      target_commitish: sha,
      author: { login: "github-actions[bot]" },
      assets: [{ state: "uploaded" }, { state: "uploaded" }],
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

test("glivela auto-publish selects newer stable release and requires exact main push CI gate", () => {
  assert.equal(glivelaRule.autoPublish.enabled, true);
  assert.equal(glivelaRule.autoPublish.allowPrerelease, false);
  assert.deepEqual(glivelaRule.artifactApps, ["glivela-entry", "glivela-node", "glivela-dual"]);
  const releases = [
    { tag_name: "v0.2.1-alpha.1", draft: false, prerelease: true, published_at: "2026-11-23T02:00:00Z" },
    { tag_name: "v0.2.0", draft: false, prerelease: false, published_at: "2026-11-23T01:00:00Z" },
    { tag_name: "v0.1.1", draft: false, prerelease: false, published_at: "2026-11-22T01:00:00Z" },
  ];
  assert.equal(selectCandidateRelease(releases, "0.1.1", glivelaRule)?.tag_name, "v0.2.0");
  assert.equal(selectCandidateRelease(releases, "0.2.0", glivelaRule), null);

  const ciRun = {
    id: 901,
    run_number: 50,
    event: "push",
    path: glivelaRule.ciWorkflow,
    head_sha: sha,
    head_branch: "main",
    repository: { full_name: glivelaRule.repository },
    head_repository: { full_name: glivelaRule.repository },
    status: "completed",
    conclusion: "success",
  };
  assert.deepEqual(
    checkSourceCIReady(glivelaRule, sha, endpoint => {
      if (endpoint.includes("/actions/workflows/")) return { workflow_runs: [ciRun] };
      if (endpoint.includes("/jobs?")) return { jobs: [{ name: glivelaRule.ciJob, status: "completed", conclusion: "success" }] };
      throw new Error(`unexpected ${endpoint}`);
    }),
    { ready: true },
  );
  assert.equal(
    checkSourceCIReady(glivelaRule, sha, endpoint => {
      if (endpoint.includes("/actions/workflows/")) return { workflow_runs: [ciRun] };
      if (endpoint.includes("/jobs?")) return { jobs: [{ name: glivelaRule.ciJob, status: "completed", conclusion: "skipped" }] };
      throw new Error(`unexpected ${endpoint}`);
    }).ready,
    false,
  );
  assert.equal(
    checkSourceCIReady(glivelaRule, sha, () => ({
      workflow_runs: [
        { ...ciRun, id: 902, run_number: 51, conclusion: "failure" },
        ciRun,
      ],
    })).ready,
    false,
  );
});
