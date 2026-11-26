// Pull-only reconciler that discovers eligible upstream releases or reviewed
// recipe updates without holding any signing keys or storage credentials.
// Outputs are untrusted hints re-verified from scratch inside catalog-plan.mjs.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { catalogFromBundle, loadImportedLedger, mergeReviewedRecipes } from "./catalog-plan.mjs";
import { validatePublication, verifyLedgerAsset } from "./publish-catalog.mjs";
import { artifactAppIds, compareVersions, execute, validateRequest } from "./release-source.mjs";

const AUTO_EVENTS = new Set(["schedule", "repository_dispatch"]);
const MAX_CONSECUTIVE_AUTO_FAILURES = 2;
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const CANONICAL_TAG = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(alpha|beta|rc)\.(0|[1-9][0-9]*))?$/;
const AGENT_VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(alpha|beta|rc)\.(0|[1-9][0-9]*))?$/;

function runTimestampMs(run) {
  return Date.parse(run?.run_started_at ?? run?.created_at ?? "");
}

function isPublishJobFailure(jobs) {
  return (jobs ?? []).some(
    job =>
      (job?.name === "publish" || job?.name === "mirror-glivela" || job?.name === "mirror-senlun") &&
      (job.conclusion === "failure" || job.conclusion === "timed_out"),
  );
}

function isPublishJobSuccess(jobs) {
  return (jobs ?? []).some(job => job?.name === "publish" && job.conclusion === "success");
}

export function isCircuitOpen(
  failedRuns,
  manualSuccessRuns,
  { currentRunId = "", sinceIso = "", jobsForRun = null } = {},
) {
  let resetMs = sinceIso ? Date.parse(sinceIso) : Number.NaN;
  for (const run of manualSuccessRuns ?? []) {
    if (String(run?.id) === String(currentRunId)) continue;
    if (run?.event !== "workflow_dispatch" || run?.status !== "completed" || run?.conclusion !== "success") continue;
    const ts = runTimestampMs(run);
    if (!Number.isFinite(ts) || (Number.isFinite(resetMs) && ts <= resetMs)) continue;
    if (jobsForRun) {
      if (!RUN_ID_PATTERN.test(String(run.id))) continue;
      if (!isPublishJobSuccess(jobsForRun(run.id))) continue;
    }
    resetMs = ts;
  }

  const candidates = [...(failedRuns ?? [])]
    .filter(run =>
      run &&
      String(run.id) !== String(currentRunId) &&
      AUTO_EVENTS.has(run.event) &&
      run.status === "completed" &&
      (run.conclusion === "failure" || run.conclusion === "timed_out"),
    )
    .sort((a, b) => (b.run_number ?? 0) - (a.run_number ?? 0));

  let failures = 0;
  for (const run of candidates) {
    const ts = runTimestampMs(run);
    if (Number.isFinite(resetMs) && Number.isFinite(ts) && ts <= resetMs) break;
    if (jobsForRun) {
      if (!RUN_ID_PATTERN.test(String(run.id))) continue;
      if (!isPublishJobFailure(jobsForRun(run.id))) continue;
    }
    failures += 1;
    if (failures >= MAX_CONSECUTIVE_AUTO_FAILURES) return { open: true, failures };
  }
  return { open: false, failures };
}

export function selectCandidateRelease(releases, activeVersion, rule) {
  if (rule?.autoPublish?.enabled !== true) return null;
  const allowPrerelease = rule.autoPublish.allowPrerelease === true && rule.allowPrerelease === true;
  const eligible = releases
    .filter(entry =>
      entry &&
      entry.draft === false &&
      Boolean(entry.published_at) &&
      typeof entry.tag_name === "string" &&
      CANONICAL_TAG.test(entry.tag_name) &&
      entry.prerelease === entry.tag_name.includes("-") &&
      (!entry.tag_name.includes("-") || allowPrerelease) &&
      compareVersions(entry.tag_name.slice(1), activeVersion) > 0,
    )
    .sort((a, b) => compareVersions(b.tag_name.slice(1), a.tag_name.slice(1)));
  return eligible[0] ?? null;
}

export function findVerifiedSourceRun(runs, jobsForRun, rule, sha, tag = "") {
  const candidates = runs
    .filter(run =>
      run &&
      RUN_ID_PATTERN.test(String(run.id)) &&
      run.event === "push" &&
      run.path === rule.workflow &&
      run.head_sha === sha &&
      (run.head_branch === rule.branch || (tag && run.head_branch === tag)) &&
      run.repository?.full_name === rule.repository &&
      run.head_repository?.full_name === rule.repository,
    )
    .sort((a, b) => (b.run_number ?? 0) - (a.run_number ?? 0));
  for (const run of candidates) {
    const jobs = jobsForRun(run.id) ?? [];
    const publishing = jobs.filter(job => job.name === rule.publishJob);
    if (publishing.length === 1 && publishing[0].status === "completed" && publishing[0].conclusion === "success") {
      return run;
    }
  }
  return null;
}

function readSourceFile(api, filePath, sha) {
  const file = api(`contents/${filePath}?ref=${sha}`);
  if (
    file.type !== "file" ||
    file.encoding !== "base64" ||
    typeof file.content !== "string" ||
    !Number.isSafeInteger(file.size) ||
    file.size < 1 ||
    file.size > 65536
  ) {
    throw new Error(`Invalid component version source: ${filePath}`);
  }
  const encoded = file.content.replace(/\s/g, "");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length !== file.size || bytes.toString("base64") !== encoded) {
    throw new Error(`Invalid component version encoding: ${filePath}`);
  }
  return bytes.toString("utf8");
}

function resolveTagCommit(api, tag) {
  let ref;
  try {
    ref = api(`git/ref/tags/${tag}`)?.object;
    for (let i = 0; ref?.type === "tag" && i < 4; i++) {
      if (!/^[a-f0-9]{40}$/.test(ref.sha)) return null;
      ref = api(`git/tags/${ref.sha}`)?.object;
    }
  } catch {
    return null;
  }
  return ref?.type === "commit" && /^[a-f0-9]{40}$/.test(ref.sha) ? ref.sha : null;
}

export function checkSourceCIReady(rule, sha, api, pages = null) {
  const workflowFile = rule.ciWorkflow.split("/").at(-1);
  const runs = api(`actions/workflows/${workflowFile}/runs?head_sha=${sha}&event=push&per_page=100`).workflow_runs ?? [];
  const newest = [...runs].sort((a, b) => (b.run_number ?? 0) - (a.run_number ?? 0))[0];
  if (
    !newest ||
    !RUN_ID_PATTERN.test(String(newest.id)) ||
    newest.head_sha !== sha ||
    newest.head_branch !== rule.branch ||
    newest.event !== "push" ||
    newest.path !== rule.ciWorkflow ||
    newest.repository?.full_name !== rule.repository ||
    newest.head_repository?.full_name !== rule.repository ||
    newest.status !== "completed" ||
    newest.conclusion !== "success"
  ) {
    return { ready: false, reason: `waiting for ${rule.ciWorkflow} push CI on ${sha}` };
  }
  if (rule.ciJob) {
    const jobs = pages
      ? pages(`actions/runs/${newest.id}/jobs?filter=latest&per_page=100`).flatMap(page => page.jobs ?? [])
      : (api(`actions/runs/${newest.id}/jobs?filter=latest&per_page=100`).jobs ?? []);
    const gates = jobs.filter(job => job.name === rule.ciJob);
    if (gates.length !== 1 || gates[0].status !== "completed" || gates[0].conclusion !== "success") {
      return { ready: false, reason: `waiting for required CI job "${rule.ciJob}" on ${sha}` };
    }
  }
  return { ready: true };
}

export function checkAgentReleaseReady(rule, sha, activeAgentVersion, api) {
  const agentVersionFile = rule.agentVersionFile ?? "crates/senlun-agent/version.txt";
  const agentVersion = readSourceFile(api, agentVersionFile, sha).trim();
  if (!AGENT_VERSION_PATTERN.test(agentVersion)) {
    return { ready: false, reason: `invalid agent version at ${sha}` };
  }
  const cmp = compareVersions(agentVersion, activeAgentVersion);
  if (cmp < 0) return { ready: false, reason: `agent version ${agentVersion} is older than active ${activeAgentVersion}` };
  if (cmp === 0) return { ready: true, agentVersion };

  const allowPrerelease = rule?.autoPublish?.allowPrerelease === true && rule?.allowPrerelease === true;
  if (agentVersion.includes("-") && !allowPrerelease) {
    return { ready: false, reason: `prerelease agent version ${agentVersion} is not enabled for autoPublish` };
  }

  const agentTag = `senlun-agent-v${agentVersion}`;
  let agentRelease;
  try {
    agentRelease = api(`releases/tags/${agentTag}`);
  } catch {
    return { ready: false, reason: `waiting for ${agentTag} to be published` };
  }
  const uploadedAssets = (agentRelease.assets ?? []).filter(asset => asset?.state === "uploaded");
  if (
    agentRelease.tag_name !== agentTag ||
    agentRelease.draft !== false ||
    !agentRelease.published_at ||
    agentRelease.prerelease !== agentVersion.includes("-") ||
    agentRelease.target_commitish !== sha ||
    agentRelease.author?.login !== "github-actions[bot]" ||
    uploadedAssets.length < 2
  ) {
    return { ready: false, reason: `waiting for ${agentTag} to finish publishing at ${sha}` };
  }
  const agentTagSha = resolveTagCommit(api, agentTag);
  if (agentTagSha !== sha) {
    return { ready: false, reason: `waiting for ${agentTag} tag ref to resolve to ${sha}` };
  }
  return { ready: true, agentVersion };
}

export function reconcileCatalog(env = process.env, run = execute) {
  if (env.GITHUB_REPOSITORY !== "petauron/catalog" || env.GITHUB_REF !== "refs/heads/main") {
    throw new Error("Reconciler only runs on protected petauron/catalog main");
  }
  if (env.CATALOG_AUTOPUBLISH_DISABLED === "true") {
    return { publish: false, reason: "automatic catalog publication is disabled via CATALOG_AUTOPUBLISH_DISABLED" };
  }

  const repository = env.GITHUB_REPOSITORY;
  const catalogApi = endpoint => JSON.parse(run("gh", ["api", `repos/${repository}/${endpoint}`]));
  const catalogPages = endpoint => JSON.parse(run("gh", ["api", "--paginate", "--slurp", `repos/${repository}/${endpoint}`]));

  const imported = loadImportedLedger("catalog/legacy-ledger");
  const liveReleases = catalogPages("releases?per_page=100")
    .flat()
    .filter(entry => /^catalog-r[1-9][0-9]*$/.test(entry.tag_name));
  if (liveReleases.some(entry => imported.some(item => item.release.tag_name === entry.tag_name))) {
    throw new Error("New and historical revisions collide");
  }
  const allReleases = [...liveReleases, ...imported.map(item => item.release)]
    .sort((a, b) => Number(b.tag_name.slice(9)) - Number(a.tag_name.slice(9)));
  const latest = allReleases[0];
  if (!latest) throw new Error("Catalog history is missing");
  if (latest.draft) {
    return {
      publish: false,
      warning: true,
      reason: `pending draft ${latest.tag_name} blocks automatic publication; operator recovery required`,
    };
  }

  // Query filtered run endpoints so 15-minute no-op cron runs cannot evict failed runs
  // out of a single page, and inspect jobs so transient discover blips do not latch the breaker.
  const failedRuns = [
    ...(catalogApi("actions/workflows/publish.yml/runs?branch=main&status=failure&per_page=20").workflow_runs ?? []),
    ...(catalogApi("actions/workflows/publish.yml/runs?branch=main&status=timed_out&per_page=20").workflow_runs ?? []),
  ];
  const manualSuccessRuns = catalogApi("actions/workflows/publish.yml/runs?branch=main&event=workflow_dispatch&status=success&per_page=10").workflow_runs ?? [];
  const circuit = isCircuitOpen(failedRuns, manualSuccessRuns, {
    currentRunId: env.GITHUB_RUN_ID ?? "",
    sinceIso: latest.published_at ?? latest.created_at ?? "",
    jobsForRun: runId => catalogApi(`actions/runs/${runId}/jobs?filter=latest&per_page=20`).jobs ?? [],
  });
  if (circuit.open) {
    return {
      publish: false,
      warning: true,
      reason: `circuit breaker open after ${circuit.failures} failed automated catalog publish runs; run a manual workflow_dispatch after inspecting the failure`,
    };
  }

  let latestBundle = imported.find(item => item.release.tag_name === latest.tag_name);
  if (latestBundle) {
    latestBundle = JSON.parse(latestBundle.bytes);
  } else {
    const ledgerAssets = (latest.assets ?? []).filter(item => item.name === "catalog-publication.json");
    if (ledgerAssets.length !== 1 || ledgerAssets[0].state !== "uploaded" || ledgerAssets[0].size > 40 * 1024 * 1024) {
      return {
        publish: false,
        warning: true,
        reason: `latest ledger ${latest.tag_name} is incomplete; operator inspection required`,
      };
    }
    const baseTemp = env.RUNNER_TEMP || os.tmpdir();
    const work = mkdtempSync(path.join(baseTemp, "catalog-reconcile-"));
    try {
      run("gh", ["release", "download", latest.tag_name, "--repo", repository, "--pattern", "catalog-publication.json", "--dir", work]);
      const bytes = readFileSync(path.join(work, "catalog-publication.json"));
      verifyLedgerAsset(latest, bytes);
      latestBundle = JSON.parse(bytes);
      validatePublication(latestBundle);
      if (latestBundle.commit !== latest.target_commitish || latestBundle.revision !== Number(latest.tag_name.slice(9))) {
        throw new Error("Release ledger identity mismatch");
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  const { catalog: active, custom: activeCustom } = catalogFromBundle(latestBundle);
  const registry = JSON.parse(readFileSync("catalog/sources.json", "utf8"));

  for (const [application, rule] of Object.entries(registry.sources ?? {})) {
    if (rule?.autoPublish?.enabled !== true) continue;
    const activeApp = active.apps.find(app => app.id === rule.imageApp);
    const artifactIds = artifactAppIds(rule);
    if (!activeApp || artifactIds.length === 0 || artifactIds.some(id => !active.apps.some(app => app.id === id))) continue;

    const upstreamApi = endpoint => JSON.parse(run("gh", ["api", `repos/${rule.repository}/${endpoint}`]));
    const upstreamPages = endpoint => JSON.parse(run("gh", ["api", "--paginate", "--slurp", `repos/${rule.repository}/${endpoint}`]));
    const upstreamReleases = upstreamApi("releases?per_page=100");
    const candidate = selectCandidateRelease(upstreamReleases, activeApp.version, rule);
    if (!candidate) continue;

    const sha = resolveTagCommit(upstreamApi, candidate.tag_name);
    if (!sha) {
      console.log(`Skipping ${application} ${candidate.tag_name}: could not resolve tag commit`);
      continue;
    }
    if (rule.nativeMirror === true && candidate.target_commitish !== sha) {
      console.log(`Skipping ${application} ${candidate.tag_name}: release target commit differs from tag commit ${sha}`);
      continue;
    }
    const branch = upstreamApi(`branches/${rule.branch}`);
    const comparison = upstreamApi(`compare/${sha}...${rule.branch}`);
    if (branch.protected !== true || !["identical", "ahead"].includes(comparison.status)) {
      console.log(`Skipping ${application} ${candidate.tag_name}: tag commit ${sha} is not on protected ${rule.branch}`);
      continue;
    }

    const workflowFile = rule.workflow.split("/").at(-1);
    const sourceRuns = upstreamApi(`actions/workflows/${workflowFile}/runs?head_sha=${sha}&event=push&per_page=20`).workflow_runs ?? [];
    const matchedRun = findVerifiedSourceRun(
      sourceRuns,
      runId => upstreamPages(`actions/runs/${runId}/jobs?filter=latest&per_page=100`).flatMap(page => page.jobs ?? []),
      rule,
      sha,
      candidate.tag_name,
    );
    if (!matchedRun) {
      console.log(`Waiting for ${application} ${candidate.tag_name}: publishing job "${rule.publishJob}" not yet complete`);
      continue;
    }

    if (rule.ciWorkflow) {
      const ciCheck = checkSourceCIReady(rule, sha, upstreamApi, upstreamPages);
      if (!ciCheck.ready) {
        console.log(`Waiting for ${application} ${candidate.tag_name}: ${ciCheck.reason}`);
        continue;
      }
    }

    let detail = `run ${matchedRun.id}`;
    if (rule.agentVersionFile || rule.artifactApp) {
      const activeAgent = active.apps.find(app => app.id === rule.artifactApp);
      const agentCheck = checkAgentReleaseReady(rule, sha, activeAgent.version, upstreamApi);
      if (!agentCheck.ready) {
        console.log(`Waiting for ${application} ${candidate.tag_name}: ${agentCheck.reason}`);
        continue;
      }
      detail = `agent ${agentCheck.agentVersion}, run ${matchedRun.id}`;
    }

    const request = { application, runId: String(matchedRun.id), sha, tag: candidate.tag_name };
    validateRequest(request, registry);
    return {
      publish: true,
      kind: "release",
      application,
      tag: candidate.tag_name,
      sha,
      runId: String(matchedRun.id),
      reason: `discovered verified release ${application} ${candidate.tag_name} (${detail})`,
    };
  }

  if (registry.autoPublishReviewed === true) {
    const reviewed = JSON.parse(readFileSync("catalog/catalog.json", "utf8"));
    const custom = JSON.parse(readFileSync("catalog/target-custom.json", "utf8"));
    const merged = mergeReviewedRecipes(reviewed, active);
    const changed = JSON.stringify(merged.apps) !== JSON.stringify(active.apps) || JSON.stringify(custom) !== JSON.stringify(activeCustom);
    if (changed) {
      return {
        publish: true,
        kind: "reviewed",
        application: "",
        tag: "",
        sha: "",
        runId: "",
        reason: "discovered reviewed recipe or target-custom change on protected main",
      };
    }
  }

  return { publish: false, reason: `catalog ${latest.tag_name} is already up to date` };
}

function writeOutputs(outputPath, values) {
  const lines = [];
  for (const [key, raw] of Object.entries(values)) {
    const value = String(raw ?? "");
    if (/[\r\n]/.test(value)) throw new Error(`Refusing multiline GitHub output for ${key}`);
    lines.push(`${key}=${value}`);
  }
  writeFileSync(outputPath, `${lines.join("\n")}\n`, { flag: "a" });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const result = reconcileCatalog();
    if (result.warning) console.log(`::warning::${result.reason}`);
    else console.log(result.reason);
    if (process.env.GITHUB_OUTPUT) {
      writeOutputs(process.env.GITHUB_OUTPUT, {
        should_publish: result.publish ? "true" : "false",
        kind: result.kind ?? "",
        application: result.application ?? "",
        tag: result.tag ?? "",
        sha: result.sha ?? "",
        run_id: result.runId ?? "",
      });
    }
  } catch {
    console.error("Catalog reconciliation did not complete; check ledger integrity and upstream API access.");
    process.exitCode = 1;
  }
}
