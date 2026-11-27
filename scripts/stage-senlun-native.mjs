#!/usr/bin/env node
// Verify an attested Senlun release without storage or signing credentials and
// stage its two immutable native archives for scripts/mirror-glivela-native.mjs.
import { constants, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execute, fetchBounded, verifyRelease } from "./release-source.mjs";

export async function stageSenlunNative({ env = process.env, staging, run = execute, download = fetchBounded } = {}) {
  if (
    env.CATALOG_PRODUCTION_ENABLED !== "true" ||
    env.GITHUB_REPOSITORY !== "petauron/catalog" ||
    env.GITHUB_REF !== "refs/heads/main" ||
    !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "") ||
    !env.RUNNER_TEMP ||
    path.dirname(staging ?? "") !== env.RUNNER_TEMP ||
    path.basename(staging) !== "senlun-native-mirror"
  ) {
    throw new Error("Native staging requires the protected official publication job");
  }
  const registry = JSON.parse(readFileSync("catalog/sources.json", "utf8"));
  const request = {
    application: "senlun",
    tag: env.CATALOG_SOURCE_TAG,
    sha: env.CATALOG_SOURCE_SHA,
    runId: env.CATALOG_SOURCE_RUN_ID,
  };
  const work = mkdtempSync(path.join(env.RUNNER_TEMP, "senlun-stage-"));
  try {
    const verified = await verifyRelease(request, registry, path.join(work, "upstream"), run, download, { verifyMirror: false });
    mkdirSync(staging, { mode: 0o700 });
    const artifacts = [];
    for (const item of verified.stagedFiles) {
      copyFileSync(item.location, path.join(staging, item.name), constants.COPYFILE_EXCL);
      artifacts.push({ architecture: item.architecture, name: item.name, size: item.size, sha256: item.sha256 });
    }
    writeFileSync(
      path.join(staging, "mirror.json"),
      JSON.stringify({ product: "senlun", version: verified.version, commit: request.sha, runId: request.runId, artifacts }),
      { mode: 0o600, flag: "wx" },
    );
    return { product: "senlun", version: verified.version, commit: request.sha, runId: request.runId, artifacts };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const [staging, ...extra] = process.argv.slice(2);
    if (extra.length) throw new Error("Usage: node scripts/stage-senlun-native.mjs STAGING_DIR");
    const result = await stageSenlunNative({ staging });
    console.log(`Staged attested Senlun ${result.version} native bundles from ${result.commit}; awaiting R2 mirror.`);
  } catch {
    console.error("Attested Senlun native staging failed; no mirror upload or publication was attempted.");
    process.exitCode = 1;
  }
}
