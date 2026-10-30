#!/usr/bin/env node
// Operator-run handoff only: prepare reviewed source changes, never publish,
// sign, create tags, dispatch workflows or contact a Center/Agent.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { compareVersions, execute, fetchBounded, parseChecksums, sha256 } from "./release-source.mjs";

try {
  const [tag, sha, runId, ...extra] = process.argv.slice(2);
  if (extra.length || !/^v[0-9]+\.[0-9]+\.[0-9]+(?:-(?:alpha|beta|rc)\.[0-9]+)?$/.test(tag ?? "") || !/^[a-f0-9]{40}$/.test(sha ?? "") || !/^[1-9][0-9]*$/.test(runId ?? "")) throw new Error("Usage: node scripts/prepare-glivela-release.mjs TAG EXACT_SHA SUCCESSFUL_RUN_ID");
  const branch = execute("git", ["branch", "--show-current"]).toString().trim();
  if (!branch || branch === "main" || execute("git", ["status", "--porcelain"]).length) throw new Error("Use a clean feature worktree; existing drafts and main must not be changed");
  const repository = "petauron/glivela";
  const api = endpoint => JSON.parse(execute("gh", ["api", `repos/${repository}/${endpoint}`]));
  const release = api(`releases/tags/${tag}`);
  const run = api(`actions/runs/${runId}`);
  const jobs = JSON.parse(execute("gh", ["api", "--paginate", "--slurp", `repos/${repository}/actions/runs/${runId}/jobs?filter=latest&per_page=100`])).flatMap(page => page.jobs);
  const publishing = jobs.filter(job => job.name === "Publish checked native and source release");
  if (String(run.id) !== runId || run.path !== ".github/workflows/release-please.yml" || run.event !== "push" || run.head_branch !== "main" || run.head_sha !== sha || run.repository?.full_name !== repository || run.head_repository?.full_name !== repository || run.status !== "completed" || run.conclusion !== "success" || publishing.length !== 1 || publishing[0].conclusion !== "success" || publishing[0].status !== "completed") throw new Error("Exact source release workflow has not succeeded");
  if (release.tag_name !== tag || release.draft !== false || !release.published_at || release.target_commitish !== sha || release.prerelease !== tag.includes("-") || api(`git/ref/tags/${tag}`).object?.sha !== sha || api("branches/main").protected !== true || !["identical", "ahead"].includes(api(`compare/${sha}...main`).status)) throw new Error("Release/tag must identify the exact published protected-main commit");
  const ci = api(`actions/workflows/ci.yml/runs?event=push&head_sha=${sha}&per_page=100`).workflow_runs.sort((a, b) => b.run_number - a.run_number)[0];
  if (!ci || ci.head_sha !== sha || ci.head_branch !== "main" || ci.path !== ".github/workflows/ci.yml" || ci.status !== "completed" || ci.conclusion !== "success") throw new Error("Latest exact-source main CI has not succeeded");
  const asset = async (name, maximum) => {
    const found = release.assets.filter(item => item.name === name);
    const url = `https://github.com/${repository}/releases/download/${tag}/${name}`;
    if (found.length !== 1 || found[0].state !== "uploaded" || found[0].browser_download_url !== url || !Number.isSafeInteger(found[0].size) || found[0].size <= 0 || found[0].size > maximum) throw new Error("Required published asset is missing or invalid");
    const bytes = await fetchBounded(url, maximum);
    if (bytes.length !== found[0].size || found[0].digest !== `sha256:${sha256(bytes)}`) throw new Error("Published asset does not match authenticated inventory");
    return bytes;
  };
  // GNU sha256sum preserves the native builder's explicit ./ prefix. Remove
  // only that prefix before reusing the existing strict filename parser.
  const sums = parseChecksums((await asset("SHA256SUMS", 64 * 1024)).toString().replace(/^([a-f0-9]{64} [ *])\.\//gm, "$1"));
  const checked = async (name, maximum) => {
    const bytes = await asset(name, maximum);
    if (sums.get(name) !== sha256(bytes)) throw new Error("Published SHA256SUMS mismatch");
    return bytes;
  };
  const version = tag.slice(1);
  const image = JSON.parse(await checked("glivela-controller-image.json", 64 * 1024));
  if (image.version !== version || image.commit !== sha || !/^ghcr\.io\/petauron\/glivela@sha256:[a-f0-9]{64}$/.test(image.reference) || JSON.stringify(image.platforms) !== '["linux/amd64","linux/arm64"]') throw new Error("Controller image identity differs from the release");
  const token = JSON.parse(await fetchBounded("https://ghcr.io/token?scope=repository:petauron/glivela:pull", 64 * 1024)).token;
  if (typeof token !== "string" || token.length > 16384) throw new Error("Registry authorization failed");
  const manifest = await fetchBounded(`https://ghcr.io/v2/petauron/glivela/manifests/${image.reference.split("@")[1]}`, 4 * 1024 * 1024, { Authorization: `Bearer ${token}`, Accept: "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json" });
  const index = JSON.parse(manifest);
  if (image.reference !== `ghcr.io/petauron/glivela@sha256:${sha256(manifest)}` || JSON.stringify(index.manifests?.filter(item => item.platform?.os === "linux").map(item => item.platform.architecture).sort()) !== '["amd64","arm64"]') throw new Error("Immutable image index must contain both supported platforms");
  const digests = {};
  const iperfDigests = { amd64: "ef4c89f3fc01c56cf00d34b900024c74f68e540dab452eef4fd902544d9c1c64", arm64: "34364466812357fe021a8647cb433c8006b0360e3b690ecda470a979a2601031" };
  const temporary = mkdtempSync(path.join(tmpdir(), "glivela-release-"));
  try {
    for (const arch of ["amd64", "arm64"]) {
      const bundle = await checked(`glivela-${version}-linux-${arch}.tar.gz`, 128 * 1024 * 1024);
      digests[arch] = sha256(bundle);
      const file = path.join(temporary, `${arch}.tar.gz`);
      writeFileSync(file, bundle, { mode: 0o600, flag: "wx" });
      const members = execute("tar", ["-tzf", file]).toString("utf8").trim().split("\n");
      for (const required of ["iperf3", "LICENSE.iperf3", "runtime.json"]) {
        if (members.filter(member => member === required).length !== 1) throw new Error("Glivela release is missing a unique required diagnostic member");
      }
      const iperf = execute("tar", ["-xOzf", file, "iperf3"]);
      const metadata = JSON.parse(execute("tar", ["-xOzf", file, "runtime.json"]));
      if (sha256(iperf) !== iperfDigests[arch] || metadata.iperf3?.version !== "3.22" || metadata.iperf3.sha256 !== iperfDigests[arch]) throw new Error("Glivela diagnostic identity differs from the reviewed release");
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  const catalogPath = "catalog/catalog.json";
  const catalog = JSON.parse(readFileSync(catalogPath));
  const apps = ["meridian", "glivela-entry", "glivela-node", "glivela-dual"].map(id => catalog.apps.find(app => app.id === id));
  if (apps.some(app => !app) || new Set(apps.map(app => app.version)).size !== 1) throw new Error("Reviewed Glivela recipes do not have one version");
  const oldVersion = apps[0].version;
  if (compareVersions(version, oldVersion) <= 0) throw new Error("Only a newer release can prepare a catalog update");
  // Match the existing brand contract's machine-identity projection. Verify
  // the old identity before touching release coordinates, never bless an
  // unrelated runtime/config change by blindly regenerating test hashes.
  const machineDigest = app => {
    const identity = structuredClone(app);
    delete identity.name;
    delete identity.description;
    delete identity.packageRevision;
    identity.config = identity.config.map(({ label, description, ...field }) => field);
    return sha256(JSON.stringify(identity));
  };
  const brandPath = "scripts/product-brand.test.mjs";
  const brandContract = readFileSync(brandPath, "utf8");
  const brandPin = /^(\s*\["meridian", "Glivela", "Glivela", ")([a-f0-9]{64})("\],)$/gm;
  const brandMatches = [...brandContract.matchAll(brandPin)];
  const baseline = `Reviewed baseline includes Glivela ${oldVersion.replace(/^0\.1\.0-/, "")} release coordinates`;
  if (brandMatches.length !== 1 || brandMatches[0][2] !== machineDigest(apps[0]) || brandContract.split(baseline).length !== 2) throw new Error("Reviewed Glivela brand identity baseline differs from the current recipe");
  const workflowPath = ".github/workflows/publish.yml";
  const workflow = readFileSync(workflowPath, "utf8");
  const pin = /repository: petauron\/glivela\n          ref: ([a-f0-9]{40})/g;
  const matches = [...workflow.matchAll(pin)];
  if (matches.length !== 1) throw new Error("Expected one reviewed UI source pin");
  const oldSHA = matches[0][1];
  const testPath = "scripts/ui-publication-pins.test.mjs";
  const contract = readFileSync(testPath, "utf8");
  if (!contract.includes(oldVersion) || !contract.includes(oldSHA)) throw new Error("Reviewed UI contract differs from source pins");
  const controller = apps[0].images?.find(item => item.name === "controller");
  if (!controller) throw new Error("Reviewed controller image mapping is missing");
  controller.reference = image.reference;
  for (const app of apps) app.version = version;
  for (const app of apps.slice(1)) {
    // Only add the reviewed application-owned diagnostic files to the existing
    // runtime. Never carry unrelated template changes into release coordinates.
    const nextRuntime = JSON.parse(readFileSync(`catalog/recipes/${app.id}.runtime.json`));
    const previousRuntime = structuredClone(nextRuntime);
    const files = previousRuntime.nativeServices?.services?.find(service => service.name === "node")?.process?.files;
    if (!Array.isArray(files) || files.filter(file => file.path === "iperf3" && file.executable === true).length !== 1 || files.filter(file => file.path === "LICENSE.iperf3" && !Object.hasOwn(file, "executable")).length !== 1) throw new Error("Reviewed diagnostic allowlist is invalid");
    previousRuntime.nativeServices.services.find(service => service.name === "node").process.files = files.filter(file => !["iperf3", "LICENSE.iperf3"].includes(file.path));
    if (files.length !== previousRuntime.nativeServices.services.find(service => service.name === "node").process.files.length + 2 || (!isDeepStrictEqual(previousRuntime, app.runtime) && !isDeepStrictEqual(nextRuntime, app.runtime))) throw new Error("Unrelated native runtime change requires separate review");
    app.runtime = nextRuntime;
    if (JSON.stringify(app.artifacts?.map(entry => entry.architecture).sort()) !== '["amd64","arm64"]') throw new Error("Expected two reviewed native artifact mappings");
    for (const entry of app.artifacts) {
      if (entry.name !== "bundle" || entry.operatingSystem !== "linux" || !digests[entry.architecture]) throw new Error("Unreviewed native artifact mapping");
      entry.url = `https://github.com/${repository}/releases/download/${tag}/glivela-${version}-linux-${entry.architecture}.tar.gz`;
      entry.sha256 = digests[entry.architecture];
    }
  }
  const nextBrandContract = brandContract
    .replace(brandPin, (_, prefix, oldDigest, suffix) => `${prefix}${machineDigest(apps[0])}${suffix}`)
    .replace(baseline, `Reviewed baseline includes Glivela ${version.replace(/^0\.1\.0-/, "")} release coordinates`);
  // Resolve and validate every input before changing these four review files.
  writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  writeFileSync(workflowPath, workflow.replace(pin, `repository: petauron/glivela\n          ref: ${sha}`));
  writeFileSync(testPath, contract.replace(`Glivela ${oldVersion.replace(/^0\.1\.0-/, "")} publication`, `Glivela ${version.replace(/^0\.1\.0-/, "")} publication`).replace(`'${oldVersion}'`, `'${version}'`).replaceAll(oldSHA, sha));
  writeFileSync(brandPath, nextBrandContract);
  console.log(`Prepared review-only Glivela ${tag} from https://github.com/${repository}/actions/runs/${runId}`);
  console.log("Review git diff, submit a PR and wait for its required CI. Merging does not sign, publish or deploy the catalog.");
} catch (error) {
  // Child-process stderr can contain authentication details. Print only our own
  // fixed diagnostics; no release bytes, registry tokens or signed URLs.
  console.error(error.status !== undefined || error.code ? "Release handoff failed; no publication was attempted. Check authenticated source access and retained worktree state." : error.message);
  process.exitCode = 1;
}
