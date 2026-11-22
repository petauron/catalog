// Pull-only reconciler that discovers eligible upstream releases or reviewed
// recipe updates without holding any signing keys or storage credentials.
// Outputs are untrusted hints re-verified from scratch inside catalog-plan.mjs.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { catalogFromBundle, loadImportedLedger, mergeReviewedRecipes } from "./catalog-plan.mjs";
import { validatePublication, verifyLedgerAsset } from "./publish-catalog.mjs";
import { compareVersions, execute, validateRequest } from "./release-source.mjs";

const AUTO_EVENTS = new Set(["schedule", "repository_dispatch"]);
const MAX_CONSECUTIVE_AUTO_FAILURES = 2;
const CANONICAL_TAG = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(alpha|beta|rc)\.(0|[1-9][0-9]*))?$/;
const AGENT_VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(alpha|beta|rc)\.(0|[1-9][0-9]*))?$/;

export function isCircuitOpen(runs, { currentRunId = "", sinceIso = "" } = {}) {
  const sinceMs = sinceIso ? Date.parse(sinceIso) : Number.NaN;
  const ordered = [...runs]
    .filter(run => String(run.id) !== String(currentRunId))
    .sort((a, b) => (b.run_number ?? 0) - (a.run_number ?? 0));
  let failures = 0;
  for (const run of ordered) {
    if (run.status !== "completed" || run.conclusion === "cancelled" || run.conclusion === "skipped") continue;
    const createdMs = Date.parse(run.created_at ?? "");
    if (Number.isFinite(sinceMs) && Number.isFinite(createdMs) && createdMs <= sinceMs) break;
    if (run.event === "workflow_dispatch" && run.conclusion === "success") return { open: false, failures: 0 };
    if (AUTO_EVENTS.has(run.event) && (run.conclusion === "failure" || run.conclusion === "timed_out")) {
      failures += 1;
      if (failures >= MAX_CONSECUTIVE_AUTO_FAILURES) return { open: true, failures };
    }
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
      run.event === "push" &&
      run.path === rule.workflow &&
      run.head_sha === sha &&
      (run.head_branch === rule.branch || (tag && run.head_branch === tag)) &&
      run.repository?.full_name === rule.repository &&
      run.head_repository?.full_name === rule.repository,
    )
    .sort((a, b) => (b.run_number ?? 0) - (a.run_number ?? 0));
  for (const run of candidates) {
    const jobs = jobsForRun(run.id);
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

export function checkAgentReleaseReady(rule, sha, activeAgentVersion, api) {
  const agentVersion = readSourceFile(api, "crates/senlun-agent/version.txt", sha).trim();
  if (!AGENT_VERSION_PATTERN.test(agentVersion)) {
    return { ready: false, reason: `invalid agent version at ${sha}` };
  }
  const cmp = compareVersions(agentVersion, activeAgentVersion);
  if (cmp < 0) return { ready: false, reason: `agent version ${agentVersion} is older than active ${activeAgentVersion}` };
  if (cmp === 0) return { ready: true, agentVersion };
  const agentTag = `senlun-agent-v${agentVersion}`;
  let agentRelease;
  try {
    agentRelease = api(`releases/tags/${agentTag}`);
  } catch {
    return { ready: false, reason: `waiting for ${agentTag} to be published` };
  }
  if (
    agentRelease.tag_name !== agentTag ||
    agentRelease.draft !== false ||
    !agentRelease.published_at ||
    agentRelease.target_commitish !== sha ||
    agentRelease.author?.login !== "github-actions[bot]" ||
    !Array.isArray(agentRelease.assets)
  ) {
    return { ready: false, reason: `waiting for ${agentTag} to finish publishing at ${sha}` };
  }
  return { ready: true, agentVersion };
}

function resolveTagCommit(api, tag) {
  let ref = api(`git/ref/tags/${tag}`).object;
  for (let i = 0; ref?.type === "tag" && i < 4; i++) {
    if (!/^[a-f0-9]{40}$/.test(ref.sha)) return null;
    ref = api(`git/tags/${ref.sha}`).object;
  }
  return ref?.type === "commit" && /^[a-f0-9]{40}$/.test(ref.sha) ? ref.sha : null;
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

  const runsResp = catalogApi("actions/workflows/publish.yml/runs?branch=main&per_page=20");
  const circuit = isCircuitOpen(runsResp.workflow_runs ?? [], {
    currentRunId: env.GITHUB_RUN_ID ?? "",
    sinceIso: latest.published_at ?? latest.created_at ?? "",
  });
  if (circuit.open) {
    return {
      publish: false,
      warning: true,
      reason: `circuit breaker open after ${circuit.failures} consecutive failed automated catalog runs; run a manual workflow_dispatch after inspecting the failure`,
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
    const work = path.join(baseTemp, `catalog-reconcile-${process.pid}-${Date.now()}`);
    mkdirSync(work, { mode: 0o700 });
    try {
      run("gh", ["release", "download", latest.tag_name, "--repo", repository, "--pattern", "catalog-publication.json", "--dir", work]);
      const bytes = readFileSync(path.join(work, "catalog-publication.json"));
      verifyLedgerAsset(latest, bytes);
      latestBundle = JSON.parse(bytes);
      validatePublication(latestBundle);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  const { catalog: active, custom: activeCustom } = catalogFromBundle(latestBundle);
  const registry = JSON.parse(readFileSync("catalog/sources.json", "utf8"));

  for (const [application, rule] of Object.entries(registry.sources ?? {})) {
    if (rule?.autoPublish?.enabled !== true) continue;
    const activeApp = active.apps.find(app => app.id === rule.imageApp);
    const activeAgent = active.apps.find(app => app.id === rule.artifactApp);
    if (!activeApp || !activeAgent) continue;

    const upstreamApi = endpoint => JSON.parse(run("gh", ["api", `repos/${rule.repository}/${endpoint}`]));
    const upstreamPages = endpoint => JSON.parse(run("gh", ["api", "--paginate", "--slurp", `repos/${rule.repository}/${endpoint}`]));
    const upstreamReleases = upstreamApi("releases?per_page=30");
    const candidate = selectCandidateRelease(upstreamReleases, activeApp.version, rule);
    if (!candidate) continue;

    const sha = resolveTagCommit(upstreamApi, candidate.tag_name);
    if (!sha) {
      console.log(`Skipping ${application} ${candidate.tag_name}: could not resolve tag commit`);
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
      runId => upstreamPages(`actions/runs/${runId}/jobs?filter=latest&per_page=100`).flatMap(page => page.jobs),
      rule,
      sha,
      candidate.tag_name,
    );
    if (!matchedRun) {
      console.log(`Waiting for ${application} ${candidate.tag_name}: publishing job "${rule.publishJob}" not yet complete`);
      continue;
    }

    const agentCheck = checkAgentReleaseReady(rule, sha, activeAgent.version, upstreamApi);
    if (!agentCheck.ready) {
      console.log(`Waiting for ${application} ${candidate.tag_name}: ${agentCheck.reason}`);
      continue;
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
      reason: `discovered verified release ${application} ${candidate.tag_name} (agent ${agentCheck.agentVersion}, run ${matchedRun.id})`,
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
  } catch (error) {
    console.error(`Catalog reconciliation failed: ${error?.message ?? "unknown error"}`);
    process.exitCode = 1;
  }
}
