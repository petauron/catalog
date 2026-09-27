// Resolve a candidate from immutable history while holding the workflow lock.
// Nothing in this module installs apps, writes source branches, or signs data.
import { readFileSync, writeFileSync, mkdirSync, lstatSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validatePublication, verifyLedgerAsset } from "./publish-catalog.mjs";
import { applyRelease, compareVersions, execute, sha256, validateRequest, verifyRelease } from "./release-source.mjs";

export function loadImportedLedger(directory) {
  const index = JSON.parse(readFileSync(path.join(directory, "index.json")));
  if (index.schemaVersion !== 1 || index.source !== "petauron/vastora" || !Array.isArray(index.entries) || !index.entries.length || index.entries.length > 10000) throw new Error("Missing reviewed migration baseline");
  const seen = new Set();
  return index.entries.map(entry => {
    const tag = entry.release?.tag_name;
    if (!/^catalog-r[1-9][0-9]*$/.test(tag) || seen.has(tag) || entry.file !== `${tag}.base64` || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error("Invalid imported ledger entry");
    seen.add(tag);
    if (entry.metadataFile !== `${tag}.release.base64` || !/^[a-f0-9]{64}$/.test(entry.metadataSHA256)) throw new Error("Missing original legacy release metadata");
    const metadataEncoded = readFileSync(path.join(directory, entry.metadataFile), "utf8").trim();
    const metadata = Buffer.from(metadataEncoded, "base64");
    if (metadata.length > 1024 * 1024 || metadata.toString("base64") !== metadataEncoded || sha256(metadata) !== entry.metadataSHA256 || JSON.stringify(JSON.parse(metadata)) !== JSON.stringify(entry.release)) throw new Error("Imported release metadata changed");
    const location = path.join(directory, entry.file), stat = lstatSync(location);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 55 * 1024 * 1024) throw new Error("Invalid imported ledger file");
    const encoded = readFileSync(location, "utf8").trim();
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) throw new Error("Invalid imported ledger encoding");
    if (sha256(bytes) !== entry.sha256) throw new Error("Imported ledger bytes changed");
    verifyLedgerAsset(entry.release, bytes, { legacy: true });
    const bundle = JSON.parse(bytes); validatePublication(bundle);
    if (bundle.commit !== entry.release.target_commitish || bundle.revision !== Number(tag.slice(9))) throw new Error("Imported release identity changed");
    return { release: entry.release, bytes };
  });
}

export function catalogFromBundle(bundle) {
  const state = validatePublication(bundle);
  const target = JSON.parse(Buffer.from(bundle.files[`targets/${state.sha256}.stable.json`], "base64"));
  if (!target.catalog?.apps || !Number.isFinite(Date.parse(target.expiresAt))) throw new Error("Ledger target has no catalog");
  return { catalog: target.catalog, expiresAt: target.expiresAt };
}

export function mergeReviewedRecipes(reviewed, active) {
  const next = structuredClone(reviewed);
  for (const app of next.apps) {
    const previous = active?.apps.find(item => item.id === app.id);
    if (!previous || compareVersions(app.version, previous.version) > 0) continue;
    if (app.packageRevision < (previous.packageRevision ?? 0)) throw new Error("Recipe revision rollback");
    // A reviewed same-version recipe is authoritative, including an explicitly
    // bumped packageRevision/digest fix. The signer rejects unbumped mutations.
    // Only overlay coordinates when source recipes lag an automatic release.
    if (app.version === previous.version) continue;
    app.version = previous.version;
    app.images = app.images?.map(image => ({ ...image, reference: previous.images?.find(old => old.name === image.name)?.reference ?? image.reference }));
    app.artifacts = app.artifacts?.map(artifact => {
      const old = previous.artifacts?.find(item => item.name === artifact.name && item.operatingSystem === artifact.operatingSystem && item.architecture === artifact.architecture);
      return old ? { ...artifact, url: old.url, sha256: old.sha256 } : artifact;
    });
  }
  return next;
}

export function choosePlan({ releases, bundles, commit, request, reviewed, recipesSHA256, now = new Date() }) {
  const entries = releases.filter(entry => /^catalog-r[1-9][0-9]*$/.test(entry.tag_name)).sort((a, b) => Number(b.tag_name.slice(9)) - Number(a.tag_name.slice(9)));
  const latest = entries[0];
  if (!latest) throw new Error("Production migration requires an existing history, never bootstrap");
  const revision = Number(latest.tag_name.slice(9));
  if (!Number.isSafeInteger(revision) || revision < 1 || !bundles.has(latest.tag_name)) throw new Error("Invalid ledger high-water mark");
  const bundle = bundles.get(latest.tag_name);
  const { catalog: active, expiresAt } = catalogFromBundle(bundle);
  if (latest.draft) {
    if (latest.target_commitish !== commit || JSON.stringify(bundle.request) !== JSON.stringify(request) || bundle.recipesSHA256 !== recipesSHA256 || !bundle.inputCatalog) throw new Error("Pending publication blocks progress; rerun its original commit and request");
    if (Date.parse(expiresAt) <= now.getTime()) throw new Error("Pending signatures expired; operator recovery required, never re-sign this revision");
    return { revision, resume: true, catalogBytes: Buffer.from(bundle.inputCatalog, "base64"), request, recipesSHA256 };
  }
  if (!Number.isSafeInteger(revision + 1)) throw new Error("Publication revision exhausted");
  return { revision: revision + 1, resume: false, active, candidate: mergeReviewedRecipes(reviewed, active), request, recipesSHA256 };
}

export async function preparePublication(env = process.env, run = execute, verify = verifyRelease) {
  if (env.GITHUB_REPOSITORY !== "petauron/catalog" || env.GITHUB_REF !== "refs/heads/main" || env.CATALOG_PRODUCTION_ENABLED !== "true") throw new Error("Production catalog is disabled or source is not protected main");
  const migration = JSON.parse(readFileSync("catalog/migration.json"));
  if (migration.completed !== true || migration.source !== "petauron/vastora" || migration.sourceIdentity !== "vastora-official" || migration.channel !== "stable" || migration.oldWriterDisabled !== true || migration.consumerCompatibilityVerified !== true) throw new Error("Publisher cutover is not complete");
  const imported = loadImportedLedger("catalog/legacy-ledger");
  const importedRevision = Math.max(...imported.map(item => Number(item.release.tag_name.slice(9))));
  if (migration.lastLegacyRevision !== importedRevision || migration.baselineSHA256 !== sha256(readFileSync("catalog/legacy-ledger/index.json")) || migration.rootSHA256 !== sha256(readFileSync("catalog/trust/1.root.json"))) throw new Error("Migration acceptance does not match reviewed roots and history");
  const repository = env.GITHUB_REPOSITORY;
  const releases = JSON.parse(run("gh", ["api", "--paginate", "--slurp", `repos/${repository}/releases?per_page=100`])).flat().filter(entry => /^catalog-r[1-9][0-9]*$/.test(entry.tag_name));
  if (releases.some(entry => imported.some(item => item.release.tag_name === entry.tag_name))) throw new Error("New and historical revisions collide");
  const work = env.CATALOG_WORK;
  if (!work || !env.RUNNER_TEMP || path.dirname(work) !== env.RUNNER_TEMP) throw new Error("Publication workspace must be isolated");
  mkdirSync(work, { mode: 0o700 });
  const bundles = new Map(imported.map(item => [item.release.tag_name, JSON.parse(item.bytes)]));
  const latestLive = releases.sort((a, b) => Number(b.tag_name.slice(9)) - Number(a.tag_name.slice(9)))[0];
  if (latestLive) {
    const ledgerAssets = latestLive.assets.filter(item => item.name === "catalog-publication.json");
    if (ledgerAssets.length !== 1 || ledgerAssets[0].state !== "uploaded" || ledgerAssets[0].size > 40 * 1024 * 1024) throw new Error("Incomplete pending ledger requires operator recovery");
    run("gh", ["release", "download", latestLive.tag_name, "--repo", repository, "--pattern", "catalog-publication.json", "--dir", work]);
    const bytes = readFileSync(path.join(work, "catalog-publication.json"));
    verifyLedgerAsset(latestLive, bytes);
    const bundle = JSON.parse(bytes); validatePublication(bundle);
    if (bundle.commit !== latestLive.target_commitish || bundle.revision !== Number(latestLive.tag_name.slice(9))) throw new Error("Release ledger identity mismatch");
    bundles.set(latestLive.tag_name, bundle);
  }
  const registry = JSON.parse(readFileSync("catalog/sources.json"));
  const request = env.CATALOG_REQUEST_KIND === "release" ? { application: env.CATALOG_APPLICATION, runId: env.CATALOG_SOURCE_RUN_ID, sha: env.CATALOG_SOURCE_SHA, tag: env.CATALOG_SOURCE_TAG } : { kind: env.CATALOG_REQUEST_KIND };
  if (request.kind === undefined) validateRequest(request, registry);
  else if (request.kind !== "reviewed") throw new Error("Unsupported publication request");
  const reviewedBytes = readFileSync("catalog/catalog-v3.json");
  const plan = choosePlan({ releases: [...releases, ...imported.map(item => item.release)], bundles, commit: env.GITHUB_SHA, request, reviewed: JSON.parse(reviewedBytes), recipesSHA256: sha256(reviewedBytes) });
  if (!plan.resume) {
    if (!request.kind) {
      const verified = await verify(request, registry, path.join(work, "upstream"));
      plan.candidate = applyRelease(plan.candidate, verified, registry.sources[request.application]);
    }
    const changed = JSON.stringify(plan.candidate.apps) !== JSON.stringify(plan.active.apps);
    if (!changed) return { noop: true };
    plan.candidate.generatedAt = new Date().toISOString();
    plan.catalogBytes = Buffer.from(JSON.stringify(plan.candidate));
  }
  const catalog = path.join(work, "candidate.json");
  writeFileSync(catalog, plan.catalogBytes, { mode: 0o600, flag: "wx" });
  // Validation always runs without signing/storage credentials and independently
  // confirms both platform manifests and native ELF/archive contracts.
  run(path.join(env.CATALOG_BIN, "vastora-v3-catalog-check"), ["--catalog", catalog, "--root-directory", "catalog/trust", "--artifacts"]);
  const result = { revision: plan.revision, commit: env.GITHUB_SHA, repository, catalog, work: path.join(work, "publication"), rootDirectory: "catalog/trust", binDirectory: env.CATALOG_BIN, legacyV3: true, request, recipesSHA256: plan.recipesSHA256, runURL: `https://github.com/${repository}/actions/runs/${env.GITHUB_RUN_ID}` };
  writeFileSync(path.join(work, "plan.json"), JSON.stringify(result), { mode: 0o600, flag: "wx" });
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try { const result = await preparePublication(); if (result.noop) console.log("Catalog request already satisfied; no signing or publication required."); else console.log(`Validated catalog publication r${result.revision}; awaiting signing stage.`); writeFileSync(process.env.GITHUB_OUTPUT, `publish=${!result.noop}\n`, { flag: "a" }); }
  catch { console.error("Catalog preparation blocked. Check migration acceptance, source provenance, and pending ledger; no publication was performed."); process.exitCode = 1; }
}
