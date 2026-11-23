// The notification is a hint, not authority. Every artifact and source identity
// is independently resolved against the reviewed registry. Never execute assets.
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import semver from "semver";
import { nativeMirrorURL, verifyNativeMirror } from "./mirror-glivela-native.mjs";

export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export const execute = (command, args, { maxBuffer = 8 * 1024 * 1024, timeout = 180000 } = {}) =>
  execFileSync(command, args, { stdio: ["ignore", "pipe", "pipe"], maxBuffer, timeout });
const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(alpha|beta|rc)\.(0|[1-9][0-9]*))?$/;
const appIdPattern = /^[a-z][a-z0-9-]*$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const commitPattern = /^[a-f0-9]{40}$/;

export function artifactAppIds(rule) {
  if (Array.isArray(rule?.artifactApps) && rule.artifactApps.length > 0) return rule.artifactApps;
  return rule?.artifactApp ? [rule.artifactApp] : [];
}

export function compareVersions(left, right) {
  if ([left, right].some(value => typeof value !== "string" || value.trim() !== value || !/^[0-9]/.test(value) || !semver.valid(value))) throw new Error("Unsupported noncanonical application version");
  return semver.compare(left, right);
}

export function validateRequest(request, registry) {
  if (!request || Object.keys(request).sort().join(",") !== "application,runId,sha,tag" || !appIdPattern.test(request.application) || !commitPattern.test(request.sha) || !/^[1-9][0-9]{0,19}$/.test(request.runId) || !request.tag?.startsWith("v") || !versionPattern.test(request.tag.slice(1))) throw new Error("Invalid release notification");
  const rule = registry.sources?.[request.application];
  if (registry.schemaVersion !== 1 || !rule || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(rule.repository) || !/^\.github\/workflows\/[a-zA-Z0-9_-]+\.yml$/.test(rule.workflow) || rule.branch !== "main" || !rule.publishJob || !/^ghcr\.io\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(rule.image)) throw new Error("Application has no reviewed source policy");
  const artifactApps = artifactAppIds(rule);
  if (!appIdPattern.test(rule.imageApp ?? "") || !rule.imageName || !rule.artifactName || artifactApps.length === 0 || artifactApps.some(id => !appIdPattern.test(id))) throw new Error("Application has invalid recipe mapping policy");
  if (request.tag.includes("-") && rule.allowPrerelease !== true) throw new Error("Prerelease is not permitted by source policy");
  if (rule.recovery && (!/^\.github\/workflows\/[a-zA-Z0-9_-]+\.yml$/.test(rule.recovery.ciWorkflow) || !rule.recovery.ciJob || !rule.recovery.verifyJob)) throw new Error("Invalid recovery source policy");
  if (rule.ciWorkflow && (!/^\.github\/workflows\/[a-zA-Z0-9_-]+\.yml$/.test(rule.ciWorkflow) || (rule.ciJob !== undefined && !rule.ciJob))) throw new Error("Invalid source CI policy");
  if (rule.nativeMirror === true) {
    if (rule.archivePrefix !== "glivela" || !rule.iperf3?.version || !sha256Pattern.test(rule.iperf3?.digests?.amd64 ?? "") || !sha256Pattern.test(rule.iperf3?.digests?.arm64 ?? "")) throw new Error("Invalid native mirror source policy");
  }
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
  if (!commitPattern.test(run.head_sha) || String(run.id) !== request.runId || run.path !== rule.workflow || run.head_repository?.full_name !== rule.repository || run.repository?.full_name !== rule.repository) throw new Error("Release run identity mismatch");
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

function readSourceFile(api, name, sha) {
  const file = api(`contents/${name}?ref=${sha}`);
  if (file.type !== "file" || file.encoding !== "base64" || typeof file.content !== "string" || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 65536) throw new Error("Invalid component version source");
  const encoded = file.content.replace(/\s/g, ""), bytes = Buffer.from(encoded, "base64");
  if (bytes.length !== file.size || bytes.toString("base64") !== encoded) throw new Error("Invalid component version encoding");
  return bytes.toString("utf8");
}

function resolveTagCommit(api, tag) {
  let ref = api(`git/ref/tags/${tag}`)?.object;
  for (let i = 0; ref?.type === "tag" && i < 4; i++) {
    if (!commitPattern.test(ref.sha ?? "")) return undefined;
    ref = api(`git/tags/${ref.sha}`)?.object;
  }
  return ref?.type === "commit" && commitPattern.test(ref.sha ?? "") ? ref.sha : undefined;
}

function requireWorkflowCI(pages, rule, sha, ciWorkflow, ciJob) {
  const workflow = ciWorkflow.split("/").at(-1);
  const runs = pages(`actions/workflows/${workflow}/runs?head_sha=${sha}&event=push&per_page=100`).flatMap(page => page.workflow_runs ?? []);
  // Select the newest run, never cherry-pick an older green result after failure.
  const run = runs.sort((a, b) => b.run_number - a.run_number)[0];
  if (!run || run.head_sha !== sha || run.head_branch !== rule.branch || run.event !== "push" || run.path !== ciWorkflow || run.repository?.full_name !== rule.repository || run.head_repository?.full_name !== rule.repository || run.status !== "completed" || run.conclusion !== "success") throw new Error("Source commit has no successful exact main CI");
  if (ciJob) {
    const jobs = pages(`actions/runs/${run.id}/jobs?filter=latest&per_page=100`).flatMap(page => page.jobs ?? []).filter(job => job.name === ciJob);
    if (jobs.length !== 1 || jobs[0].status !== "completed" || jobs[0].conclusion !== "success") throw new Error("Source commit required CI gate did not succeed");
  }
}

function requireRecoveryCI(pages, rule, sha) {
  requireWorkflowCI(pages, rule, sha, rule.recovery.ciWorkflow, rule.recovery.ciJob);
}

// Resolve the immutable protected-main commit SHA for a released Glivela version
// so independent UI builds always check out an authenticated commit, never a branch or tag.
export function resolveGlivelaUIRevision(version, rule, runCommand = execute) {
  if (!versionPattern.test(version ?? "") || rule?.repository !== "petauron/glivela" || rule?.branch !== "main") throw new Error("Invalid Glivela UI resolution policy");
  const tag = `v${version}`;
  const api = endpoint => JSON.parse(runCommand("gh", ["api", `repos/${rule.repository}/${endpoint}`]));
  const release = api(`releases/tags/${tag}`);
  if (release.tag_name !== tag || release.draft !== false || !release.published_at || release.prerelease !== version.includes("-")) throw new Error("Glivela UI release is not published");
  const sha = resolveTagCommit(api, tag);
  if (!sha || release.target_commitish !== sha) throw new Error("Glivela UI tag commit mismatch");
  const branch = api(`branches/${rule.branch}`);
  const comparison = api(`compare/${sha}...${rule.branch}`);
  if (branch.protected !== true || !["identical", "ahead"].includes(comparison.status)) throw new Error("Glivela UI source is not on protected main");
  const uiPackage = JSON.parse(readSourceFile(api, "ui/package.json", sha));
  if (uiPackage.version !== version) throw new Error("Glivela UI package version differs from release");
  return sha;
}

async function verifyGlivelaRelease(request, rule, work, { release, run, api, pages, sourceRef, runCommand, download, verifyMirror = true, verifyMirrorFn = verifyNativeMirror }) {
  const version = request.tag.slice(1);
  if (release.target_commitish !== request.sha) throw new Error("Release target commit differs from source SHA");
  if (rule.ciWorkflow) {
    console.log("Release verification stage: exact-product-ci");
    requireWorkflowCI(pages, rule, request.sha, rule.ciWorkflow, rule.ciJob);
  }
  const sourceManifest = JSON.parse(readSourceFile(api, ".release-please-manifest.json", request.sha));
  const uiPackage = JSON.parse(readSourceFile(api, "ui/package.json", request.sha));
  if (sourceManifest["."] !== version || uiPackage.version !== version) throw new Error("Glivela manifest or UI version differs from release source");
  mkdirSync(work, { mode: 0o700 });
  const asset = (name, maximum) => {
    const found = release.assets.filter(item => item.name === name);
    const expectedURL = `https://github.com/${rule.repository}/releases/download/${request.tag}/${name}`;
    if (found.length !== 1 || found[0].state !== "uploaded" || found[0].browser_download_url !== expectedURL || !Number.isSafeInteger(found[0].id) || found[0].id <= 0 || !Number.isSafeInteger(found[0].size) || found[0].size <= 0 || found[0].size > maximum) throw new Error("Required release asset is absent or invalid");
    if (!/^sha256:[a-f0-9]{64}$/.test(found[0].digest ?? "")) throw new Error("Required release asset digest is missing");
    // Resolve via authenticated GitHub asset ID to avoid browser-URL HTTP 504s.
    const raw = runCommand("gh", ["api", "--header", "Accept: application/octet-stream", `repos/${rule.repository}/releases/assets/${found[0].id}`], { maxBuffer: maximum });
    if (raw.length !== found[0].size || found[0].digest !== `sha256:${sha256(raw)}`) throw new Error("Release asset digest mismatch");
    return raw;
  };
  const sums = parseChecksums(asset("SHA256SUMS", 64 * 1024).toString("utf8").replace(/^([a-f0-9]{64} [ *])\.\//gm, "$1"));
  const attest = location => {
    runCommand("gh", ["attestation", "verify", location, "--repo", rule.repository, "--signer-workflow", `${rule.repository}/${rule.workflow}`, "--source-digest", run.head_sha, "--signer-digest", run.head_sha, "--source-ref", sourceRef, "--deny-self-hosted-runners"]);
  };

  console.log("Release verification stage: multiarch-image-and-attestation");
  const imageMetaBytes = asset("glivela-controller-image.json", 64 * 1024);
  if (sums.get("glivela-controller-image.json") !== sha256(imageMetaBytes)) throw new Error("Release checksum mismatch");
  const imageMetaLocation = path.join(work, "glivela-controller-image.json");
  writeFileSync(imageMetaLocation, imageMetaBytes, { mode: 0o600, flag: "wx" });
  attest(imageMetaLocation);
  const imageMeta = JSON.parse(imageMetaBytes.toString("utf8"));
  if (imageMeta.version !== version || imageMeta.commit !== request.sha || !imageMeta.reference?.startsWith(`${rule.image}@sha256:`) || !sha256Pattern.test(imageMeta.reference.slice(rule.image.length + 8)) || JSON.stringify(imageMeta.platforms) !== '["linux/amd64","linux/arm64"]') throw new Error("Controller image identity differs from the release");
  const repositoryPath = rule.image.slice("ghcr.io/".length);
  const token = JSON.parse((await download(`https://ghcr.io/token?scope=repository:${repositoryPath}:pull`, 64 * 1024)).toString()).token;
  if (typeof token !== "string" || token.length > 16384) throw new Error("Registry authorization failed");
  const manifest = await download(`https://ghcr.io/v2/${repositoryPath}/manifests/${imageMeta.reference.split("@")[1]}`, 4 * 1024 * 1024, { Authorization: `Bearer ${token}`, Accept: "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json" });
  const index = JSON.parse(manifest);
  if (imageMeta.reference !== `${rule.image}@sha256:${sha256(manifest)}` || !Array.isArray(index.manifests) || ["amd64", "arm64"].some(arch => index.manifests.filter(entry => entry.platform?.os === "linux" && entry.platform?.architecture === arch && /^sha256:[a-f0-9]{64}$/.test(entry.digest)).length !== 1)) throw new Error("Multiarchitecture image is incomplete");
  attest(`oci://${imageMeta.reference}`);

  console.log("Release verification stage: native-archives-and-attestations");
  const artifacts = [];
  const stagedFiles = [];
  let ui = null;
  for (const [architecture, archiveArch] of Object.entries(rule.archives)) {
    if (!["amd64", "arm64"].includes(architecture) || archiveArch !== architecture) throw new Error("Unsupported source artifact mapping");
    const name = `${rule.archivePrefix}-${version}-linux-${archiveArch}.tar.gz`;
    const raw = asset(name, 128 * 1024 * 1024);
    const digest = sha256(raw);
    if (sums.get(name) !== digest) throw new Error("Release checksum mismatch");
    const location = path.join(work, name);
    writeFileSync(location, raw, { mode: 0o600, flag: "wx" });
    attest(location);
    const members = runCommand("tar", ["-tzf", location]).toString("utf8").trim().split("\n");
    for (const required of ["iperf3", "LICENSE.iperf3", "runtime.json"]) {
      if (members.filter(member => member === required).length !== 1) throw new Error("Glivela release is missing a unique required diagnostic member");
    }
    const iperf = runCommand("tar", ["-xOzf", location, "iperf3"], { maxBuffer: 32 * 1024 * 1024 });
    const metadata = JSON.parse(runCommand("tar", ["-xOzf", location, "runtime.json"]).toString("utf8"));
    if (metadata.version !== version || metadata.commit !== request.sha || metadata.os !== "linux" || metadata.architecture !== architecture || metadata.hostTCPBudget !== "vastora-v1") throw new Error("Glivela runtime metadata differs from reviewed contract");
    if (sha256(iperf) !== rule.iperf3.digests[architecture] || metadata.iperf3?.version !== rule.iperf3.version || metadata.iperf3?.sha256 !== rule.iperf3.digests[architecture]) throw new Error("Glivela diagnostic identity differs from the reviewed release");
    const bundleUI = metadata.ui;
    if (!bundleUI || !sha256Pattern.test(bundleUI["glivela-ui.js"] ?? "") || !sha256Pattern.test(bundleUI["glivela-ui.css"] ?? "")) throw new Error("Glivela runtime metadata is missing UI digests");
    const normalizedUI = { "glivela-ui.js": bundleUI["glivela-ui.js"], "glivela-ui.css": bundleUI["glivela-ui.css"] };
    if (ui && !isDeepStrictEqual(ui, normalizedUI)) throw new Error("Native architectures disagree on UI digests");
    ui = normalizedUI;
    if (verifyMirror) await verifyMirrorFn(version, architecture, digest, raw.length);
    artifacts.push({ name: rule.artifactName, operatingSystem: "linux", architecture, url: nativeMirrorURL(version, architecture), sha256: digest });
    stagedFiles.push({ architecture, name, size: raw.length, sha256: digest, location });
  }
  if (artifacts.length !== 2 || !ui) throw new Error("Both native platforms are required");
  return { request, version, image: imageMeta.reference, artifacts, ui, stagedFiles };
}

export async function verifyRelease(request, registry, work, runCommand = execute, download = fetchBounded, options = {}) {
  console.log("Release verification stage: authenticated-source-identity");
  const rule = validateRequest(request, registry);
  const api = endpoint => JSON.parse(runCommand("gh", ["api", `repos/${rule.repository}/${endpoint}`]));
  const pages = endpoint => JSON.parse(runCommand("gh", ["api", "--paginate", "--slurp", `repos/${rule.repository}/${endpoint}`]));
  const release = api(`releases/tags/${request.tag}`);
  const run = api(`actions/runs/${request.runId}`);
  const jobs = pages(`actions/runs/${request.runId}/jobs?filter=latest&per_page=100`).flatMap(page => page.jobs);
  const tagCommit = resolveTagCommit(api, request.tag);
  const recovery = run.event === "workflow_dispatch";
  verifyReleaseIdentity(request, rule, { release, run, jobs, tag: tagCommit, comparison: api(`compare/${request.sha}...${rule.branch}`), branch: api(`branches/${rule.branch}`),
    ...(recovery ? { signerComparison: api(`compare/${run.head_sha}...${rule.branch}`), sourceToSigner: api(`compare/${request.sha}...${run.head_sha}`) } : {}),
  });
  const sourceRef = releaseSourceRef(request, rule, run);
  if (rule.nativeMirror === true) {
    return verifyGlivelaRelease(request, rule, work, { release, run, api, pages, sourceRef, runCommand, download, verifyMirror: options.verifyMirror, verifyMirrorFn: options.verifyMirrorFn });
  }
  // The Service tag and Agent version are independent. Read both the Agent
  // version and Release Please manifest from the exact checked source commit.
  const agentVersionFile = rule.agentVersionFile ?? "crates/senlun-agent/version.txt";
  const agentVersion = readSourceFile(api, agentVersionFile, request.sha).trim();
  const sourceManifest = JSON.parse(readSourceFile(api, ".release-please-manifest.json", request.sha));
  if (!versionPattern.test(agentVersion) || sourceManifest.crates !== agentVersion || sourceManifest["."] !== request.tag.slice(1)) throw new Error("Independent component versions do not match the release source");
  if (recovery) {
    console.log("Release verification stage: exact-product-ci");
    requireRecoveryCI(pages, rule, request.sha);
    if (run.head_sha !== request.sha) {
      console.log("Release verification stage: exact-workflow-ci");
      requireRecoveryCI(pages, rule, run.head_sha);
    }
  }
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
  const attest = location => {
    const result = runCommand("gh", ["attestation", "verify", location, "--repo", rule.repository, "--signer-workflow", `${rule.repository}/${rule.workflow}`, "--source-digest", run.head_sha, "--signer-digest", run.head_sha, "--source-ref", sourceRef, "--deny-self-hosted-runners", ...(recovery ? ["--format", "json"] : [])]);
    if (recovery) verifyRecoveryProvenance(JSON.parse(result), request, rule, run);
  };
  const artifacts = [];
  console.log("Release verification stage: native-archives-and-attestations");
  for (const [architecture, archiveArch] of Object.entries(rule.archives)) {
    if (!["amd64", "arm64"].includes(architecture) || !["x86_64", "aarch64"].includes(archiveArch)) throw new Error("Unsupported source artifact mapping");
    if (rule.archivePrefix !== "senlun") throw new Error("Unreviewed archive naming contract");
    const name = `${rule.archivePrefix}-${request.tag}-linux-${archiveArch}.tar.gz`;
    const raw = await asset(name, 128 * 1024 * 1024);
    const digest = sha256(raw);
    if (sums.get(name) !== digest) throw new Error("Release checksum mismatch");
    const location = path.join(work, name);
    writeFileSync(location, raw, { mode: 0o600, flag: "wx" });
    attest(location);
    artifacts.push({ name: rule.artifactName, operatingSystem: "linux", architecture, url: `https://github.com/${rule.repository}/releases/download/${request.tag}/${name}`, sha256: digest });
  }
  if (artifacts.length !== 2) throw new Error("Both native platforms are required");
  console.log("Release verification stage: multiarch-image-and-attestation");
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
  return { request, version: request.tag.slice(1), agentVersion, artifacts, image };
}

// An increased Agent version is eligible only after its own Release Please
// release is public at the same source SHA and contains the verified archives.
export function verifyAgentRelease(verified, rule, runCommand = execute) {
  if (!versionPattern.test(verified.agentVersion)) throw new Error("Invalid Agent version");
  const tag = `senlun-agent-v${verified.agentVersion}`;
  const api = endpoint => JSON.parse(runCommand("gh", ["api", `repos/${rule.repository}/${endpoint}`]));
  const release = api(`releases/tags/${tag}`);
  if (release.tag_name !== tag || release.draft !== false || !release.published_at || release.target_commitish !== verified.request.sha || release.author?.login !== "github-actions[bot]" || !Array.isArray(release.assets)) throw new Error("Independent Agent release is not published at the verified source");
  const tagCommit = resolveTagCommit(api, tag);
  if (tagCommit !== verified.request.sha) throw new Error("Agent tag does not identify the checked source");
  for (const artifact of verified.artifacts) {
    const name = new URL(artifact.url).pathname.split("/").at(-1);
    const assets = release.assets.filter(asset => asset.name === name && asset.state === "uploaded" && asset.digest === `sha256:${artifact.sha256}`);
    if (assets.length !== 1) throw new Error("Agent release does not contain the verified native artifact");
  }
}

export function applyRelease(catalog, verified, rule) {
  const next = structuredClone(catalog);
  const artifactIds = artifactAppIds(rule);
  const hasIndependentAgent = Boolean(rule.agentVersionFile || rule.artifactApp);
  for (const id of [rule.imageApp, ...artifactIds]) {
    const app = next.apps.find(item => item.id === id);
    if (!app) throw new Error("Release policy references an unregistered recipe");
    const isIndependentAgent = hasIndependentAgent && id === rule.artifactApp;
    const version = isIndependentAgent ? verified.agentVersion : verified.version;
    if (compareVersions(version, app.version) < 0) throw new Error("Refusing application version rollback");
    // New Service builds contain a freshly built Agent archive even when the
    // Agent version is unchanged. Keep its previously signed coordinates.
    if (isIndependentAgent && version === app.version) continue;
    const original = structuredClone(app);
    app.version = version;
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
    if (rule.runtimeBrand === "senlun" && app.runtime) migrateSenlunRecipe(app, id === rule.imageApp);
    if (original.version === app.version && JSON.stringify(original) !== JSON.stringify(app)) throw new Error("Published application identity is immutable");
  }
  return next;
}

// Only materialize new runtime contracts alongside a newly verified release.
// Never rewrite the reviewed historical recipe or its immutable release bytes.
export function migrateSenlunRecipe(app, service) {
  for (const field of ["name", "description"]) {
    for (const locale of Object.keys(app[field] ?? {})) app[field][locale] = app[field][locale].replaceAll("Senulun", "Senlun");
  }
  for (const field of app.config ?? []) {
    for (const key of ["label", "description", "help"]) {
      if (typeof field[key] === "string") field[key] = field[key].replaceAll("Senulun", "Senlun");
      else for (const locale of Object.keys(field[key] ?? {})) field[key][locale] = field[key][locale].replaceAll("Senulun", "Senlun");
    }
  }
  const renameEnvironment = environment => Object.fromEntries(Object.entries(environment ?? {}).map(([key, value]) => [key.replace(/^SENULUN_/, "SENLUN_"), value]));
  if (service) {
    for (const container of app.runtime.docker.containers) {
      container.environment = renameEnvironment(container.environment);
      for (const mount of container.mounts ?? []) {
        if (mount.storage === "data" && mount.target === "/var/lib/senulun") mount.target = "/var/lib/senlun";
      }
      container.arguments = [{ literal: "migrate-and-serve" }];
    }
  } else {
    const native = app.runtime.version === 2 ? app.runtime.nativeServices?.services.find(service => service.name === "agent")?.process : app.runtime.systemd;
    if (!native) throw new Error("Reviewed Senlun Agent runtime is missing");
    native.environment = renameEnvironment(native.environment);
    native.executable = "senlun-agent";
    if (app.runtime.version === 1) native.user = "vastora-senlun";
    native.files = native.files.map(file => file.path === "senulun-agent" ? { ...file, path: "senlun-agent" } : file);
  }
}
