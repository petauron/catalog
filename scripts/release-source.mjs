// The notification is a hint, not authority. Every artifact and source identity
// is independently resolved against the reviewed registry. Never execute assets.
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import semver from "semver";

export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export const execute = (command, args) => execFileSync(command, args, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024, timeout: 180000 });
const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(alpha|beta|rc)\.(0|[1-9][0-9]*))?$/;

export function compareVersions(left, right) {
  if ([left, right].some(value => typeof value !== "string" || value.trim() !== value || !/^[0-9]/.test(value) || !semver.valid(value))) throw new Error("Unsupported noncanonical application version");
  return semver.compare(left, right);
}

export function validateRequest(request, registry) {
  if (!request || Object.keys(request).sort().join(",") !== "application,runId,sha,tag" || !/^[a-z][a-z0-9-]*$/.test(request.application) || !/^[a-f0-9]{40}$/.test(request.sha) || !/^[1-9][0-9]{0,19}$/.test(request.runId) || !request.tag?.startsWith("v") || !versionPattern.test(request.tag.slice(1))) throw new Error("Invalid release notification");
  const rule = registry.sources?.[request.application];
  if (registry.schemaVersion !== 1 || !rule || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(rule.repository) || !/^\.github\/workflows\/[a-zA-Z0-9_-]+\.yml$/.test(rule.workflow) || rule.branch !== "main" || !rule.publishJob || !/^ghcr\.io\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(rule.image)) throw new Error("Application has no reviewed source policy");
  if (request.tag.includes("-") && rule.allowPrerelease !== true) throw new Error("Prerelease is not permitted by source policy");
  if (rule.recovery && (!/^\.github\/workflows\/[a-zA-Z0-9_-]+\.yml$/.test(rule.recovery.ciWorkflow) || !rule.recovery.ciJob || !rule.recovery.verifyJob)) throw new Error("Invalid recovery source policy");
  return rule;
}

export function parseChecksums(raw) {
  if (Buffer.byteLength(raw) > 64 * 1024) throw new Error("Oversized checksum document");
  const result = new Map();
  for (const line of raw.trim().split("\n")) {
    const match = /^([a-f0-9]{64}) [ *]([a-zA-Z0-9_.-]+)$/.exec(line);
    if (!match || result.has(match[2])) throw new Error("Invalid or duplicate checksum entry");
    result.set(match[2], match[1]);
  }
  return result;
}

// Fixed upstream services only. Redirects cannot carry credentials or leave the
// provider's download hosts; body sizes are enforced while streaming as well.
export async function fetchBounded(rawURL, maximum, headers = {}, fetcher = fetch) {
  let url = new URL(rawURL);
  const allowed = new Set(["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com", "ghcr.io"]);
  for (let redirect = 0; redirect < 5; redirect++) {
    if (url.protocol !== "https:" || url.username || url.password || url.port || !allowed.has(url.hostname)) throw new Error("Unapproved artifact origin");
    const response = await fetcher(url, { headers, redirect: "manual", signal: AbortSignal.timeout(120000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const next = new URL(response.headers.get("location"), url);
      if (headers.Authorization && next.origin !== url.origin) throw new Error("Registry credential redirect rejected");
      url = next;
      continue;
    }
    if (!response.ok || Number(response.headers.get("content-length") ?? 0) > maximum || !response.body) throw new Error("Artifact unavailable or oversized");
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > maximum) throw new Error("Artifact exceeds byte limit"); chunks.push(chunk); }
    return Buffer.concat(chunks);
  }
  throw new Error("Artifact redirect limit exceeded");
}

export function releaseSourceRef(request, rule, run) {
  // Manual recovery is admitted only by an explicitly reviewed source policy.
  if (run.event === "workflow_dispatch" && rule.recovery && run.head_branch === rule.branch) return `refs/heads/${rule.branch}`;
  if (run.event !== "push") throw new Error("Release run event/ref is not trusted");
  if (run.head_branch === rule.branch) return `refs/heads/${rule.branch}`;
  if (run.head_branch === request.tag) return `refs/tags/${request.tag}`;
  throw new Error("Release run source ref is not trusted");
}

export function verifyReleaseIdentity(request, rule, { release, run, jobs, tag, comparison, branch, signerComparison, sourceToSigner }) {
  if (release.tag_name !== request.tag || release.draft !== false || !release.published_at || release.prerelease !== request.tag.includes("-") || !Array.isArray(release.assets)) throw new Error("Release is not fully published");
  if (!/^[a-f0-9]{40}$/.test(run.head_sha) || String(run.id) !== request.runId || run.path !== rule.workflow || run.head_repository?.full_name !== rule.repository || run.repository?.full_name !== rule.repository) throw new Error("Release run identity mismatch");
  releaseSourceRef(request, rule, run);
  if (run.event === "workflow_dispatch") {
    const gates = jobs.filter(job => job.name === rule.recovery.verifyJob);
    if (run.status !== "completed" || run.conclusion !== "success" || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1 || !Number.isSafeInteger(run.repository.id) || !Number.isSafeInteger(run.repository.owner?.id) || release.target_commitish !== request.sha || !["identical", "ahead"].includes(signerComparison?.status) || !["identical", "ahead"].includes(sourceToSigner?.status) || gates.length !== 1 || gates[0].status !== "completed" || gates[0].conclusion !== "success") throw new Error("Recovery source or signer is not verified on protected main");
  } else if (run.head_sha !== request.sha) throw new Error("Release run identity mismatch");
  // The notify job belongs to this same run; requiring overall success here
  // would race its still-running status. The publishing job must be complete.
  const publishing = jobs.filter(job => job.name === rule.publishJob);
  if (publishing.length !== 1 || publishing[0].status !== "completed" || publishing[0].conclusion !== "success") throw new Error("Release publishing job has not succeeded");
  if (tag !== request.sha || branch.protected !== true || !["identical", "ahead"].includes(comparison.status)) throw new Error("Release source is not on protected main");
}

// CLI verification binds the certificate to the actual workflow commit, not
// the older product commit. Only its verified statements may bind that product.
export function verifyRecoveryProvenance(results, request, rule, run) {
  const repository = `https://github.com/${rule.repository}`;
  const ref = `refs/heads/${rule.branch}`;
  if (!Array.isArray(results) || results.length === 0) throw new Error("Missing verified recovery provenance");
  const matched = results.some(result => {
    const statement = result.verificationResult?.statement;
    const definition = statement?.predicate?.buildDefinition;
    const details = statement?.predicate?.runDetails;
    const github = definition?.internalParameters?.github;
    return statement?.predicateType === "https://slsa.dev/provenance/v1" &&
      definition?.buildType === "https://actions.github.io/buildtypes/workflow/v1" &&
      isDeepStrictEqual(definition.externalParameters, { workflow: { repository, path: rule.workflow, ref }, inputs: { release_tag: request.tag } }) &&
      isDeepStrictEqual(definition.resolvedDependencies, [
        { uri: `git+${repository}@${ref}`, digest: { gitCommit: run.head_sha } },
        { name: "release-source", uri: `git+${repository}@${request.sha}`, digest: { gitCommit: request.sha } },
      ]) &&
      github?.event_name === "workflow_dispatch" && github.runner_environment === "github-hosted" &&
      github.repository_id === String(run.repository.id) && github.repository_owner_id === String(run.repository.owner?.id) &&
      details?.builder?.id === `${repository}/${rule.workflow}@${ref}` &&
      details?.metadata?.invocationId === `${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}`;
  });
  if (!matched) throw new Error("Recovery provenance does not bind the exact source, signer, tag and run attempt");
}

function requireRecoveryCI(pages, rule, sha) {
  const workflow = rule.recovery.ciWorkflow.split("/").at(-1);
  const runs = pages(`actions/workflows/${workflow}/runs?head_sha=${sha}&event=push&per_page=100`).flatMap(page => page.workflow_runs);
  // Select the newest run, never cherry-pick an older green result after failure.
  const run = runs.sort((a, b) => b.run_number - a.run_number)[0];
  if (!run || run.head_sha !== sha || run.head_branch !== rule.branch || run.event !== "push" || run.path !== rule.recovery.ciWorkflow || run.repository?.full_name !== rule.repository || run.head_repository?.full_name !== rule.repository || run.status !== "completed" || run.conclusion !== "success") throw new Error("Recovery commit has no successful exact main CI");
  const jobs = pages(`actions/runs/${run.id}/jobs?filter=latest&per_page=100`).flatMap(page => page.jobs).filter(job => job.name === rule.recovery.ciJob);
  if (jobs.length !== 1 || jobs[0].status !== "completed" || jobs[0].conclusion !== "success") throw new Error("Recovery commit required CI gate did not succeed");
}

export async function verifyRelease(request, registry, work, runCommand = execute, download = fetchBounded) {
  const rule = validateRequest(request, registry);
  const api = endpoint => JSON.parse(runCommand("gh", ["api", `repos/${rule.repository}/${endpoint}`]));
  const pages = endpoint => JSON.parse(runCommand("gh", ["api", "--paginate", "--slurp", `repos/${rule.repository}/${endpoint}`]));
  const release = api(`releases/tags/${request.tag}`);
  const run = api(`actions/runs/${request.runId}`);
  const jobs = pages(`actions/runs/${request.runId}/jobs?filter=latest&per_page=100`).flatMap(page => page.jobs);
  let ref = api(`git/ref/tags/${request.tag}`).object;
  for (let i = 0; ref?.type === "tag" && i < 4; i++) ref = api(`git/tags/${ref.sha}`).object;
  const recovery = run.event === "workflow_dispatch";
  verifyReleaseIdentity(request, rule, { release, run, jobs, tag: ref?.type === "commit" ? ref.sha : undefined, comparison: api(`compare/${request.sha}...${rule.branch}`), branch: api(`branches/${rule.branch}`),
    ...(recovery ? { signerComparison: api(`compare/${run.head_sha}...${rule.branch}`), sourceToSigner: api(`compare/${request.sha}...${run.head_sha}`) } : {}),
  });
  if (recovery) for (const sha of new Set([request.sha, run.head_sha])) requireRecoveryCI(pages, rule, sha);
  mkdirSync(work, { mode: 0o700 });
  const asset = async (name, maximum) => {
    const found = release.assets.filter(item => item.name === name);
    if (found.length !== 1 || found[0].state !== "uploaded" || !Number.isSafeInteger(found[0].size) || found[0].size <= 0 || found[0].size > maximum) throw new Error("Required release asset is absent or invalid");
    const expectedURL = `https://github.com/${rule.repository}/releases/download/${request.tag}/${name}`;
    if (found[0].browser_download_url !== expectedURL) throw new Error("Unexpected release download URL");
    const raw = await download(expectedURL, maximum);
    if (raw.length !== found[0].size || (found[0].digest && found[0].digest !== `sha256:${sha256(raw)}`)) throw new Error("Release asset digest mismatch");
    return raw;
  };
  const sums = parseChecksums((await asset("SHA256SUMS", 64 * 1024)).toString());
  const sourceRef = releaseSourceRef(request, rule, run);
  const attest = location => {
    const result = runCommand("gh", ["attestation", "verify", location, "--repo", rule.repository, "--signer-workflow", `${rule.repository}/${rule.workflow}`, "--source-digest", run.head_sha, "--signer-digest", run.head_sha, "--source-ref", sourceRef, "--deny-self-hosted-runners", ...(recovery ? ["--format", "json"] : [])]);
    if (recovery) verifyRecoveryProvenance(JSON.parse(result), request, rule, run);
  };
  const artifacts = [];
  for (const [architecture, archiveArch] of Object.entries(rule.archives)) {
    if (!["amd64", "arm64"].includes(architecture) || !["x86_64", "aarch64"].includes(archiveArch)) throw new Error("Unsupported source artifact mapping");
    const name = `pulse-${request.tag}-linux-${archiveArch}.tar.gz`;
    const raw = await asset(name, 128 * 1024 * 1024);
    const digest = sha256(raw);
    if (sums.get(name) !== digest) throw new Error("Release checksum mismatch");
    const location = path.join(work, name);
    writeFileSync(location, raw, { mode: 0o600, flag: "wx" });
    attest(location);
    artifacts.push({ name: rule.artifactName, operatingSystem: "linux", architecture, url: `https://github.com/${rule.repository}/releases/download/${request.tag}/${name}`, sha256: digest });
  }
  if (artifacts.length !== 2) throw new Error("Both native platforms are required");
  const repositoryPath = rule.image.slice("ghcr.io/".length);
  const token = JSON.parse((await download(`https://ghcr.io/token?scope=repository:${repositoryPath}:pull`, 64 * 1024)).toString()).token;
  if (typeof token !== "string" || token.length > 16384) throw new Error("Registry authorization failed");
  const manifest = await download(`https://ghcr.io/v2/${repositoryPath}/manifests/${request.tag}`, 4 * 1024 * 1024, { Authorization: `Bearer ${token}`, Accept: "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json" });
  const index = JSON.parse(manifest);
  if (!Array.isArray(index.manifests) || ["amd64", "arm64"].some(arch => index.manifests.filter(entry => entry.platform?.os === "linux" && entry.platform?.architecture === arch && /^sha256:[a-f0-9]{64}$/.test(entry.digest)).length !== 1)) throw new Error("Multiarchitecture image is incomplete");
  const image = `${rule.image}@sha256:${sha256(manifest)}`;
  attest(`oci://${image}`);
  // catalog-check independently reads both OCI platform configs and verifies
  // archive members/ELF headers after this materializes the candidate catalog.
  return { request, version: request.tag.slice(1), artifacts, image };
}

export function applyRelease(catalog, verified, rule) {
  const next = structuredClone(catalog);
  for (const id of [rule.imageApp, rule.artifactApp]) {
    const app = next.apps.find(item => item.id === id);
    if (!app) throw new Error("Release policy references an unregistered recipe");
    if (compareVersions(verified.version, app.version) < 0) throw new Error("Refusing application version rollback");
    const original = structuredClone(app);
    app.version = verified.version;
    if (id === rule.imageApp) {
      const image = app.images?.find(item => item.name === rule.imageName);
      if (!image) throw new Error("Reviewed image mapping is missing");
      image.reference = verified.image;
    } else {
      app.artifacts = verified.artifacts.map(artifact => {
        const previous = app.artifacts?.find(item => item.name === artifact.name && item.operatingSystem === artifact.operatingSystem && item.architecture === artifact.architecture);
        if (!previous) throw new Error("Reviewed native artifact mapping is missing");
        return { ...previous, url: artifact.url, sha256: artifact.sha256 };
      });
    }
    if (original.version === app.version && JSON.stringify(original) !== JSON.stringify(app)) throw new Error("Published application identity is immutable");
  }
  return next;
}
