#!/usr/bin/env node
// Local source preparation only. The operator first verifies the published
// Daylight release, its successful exact-source workflow and R2 readback.
// This helper does not download, execute, sign, publish or deploy anything.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { compareVersions } from "./release-source.mjs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
try {
  const [version, metadataPath, directory, ...extra] = process.argv.slice(2);
  if (extra.length || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-alpha\.[0-9]+)?$/.test(version ?? "") || !metadataPath || !directory) throw new Error("Usage: node scripts/prepare-daylight-shared.mjs VERSION VERIFIED_RELEASE_JSON VERIFIED_ARCHIVE_DIRECTORY");
  const branch = execFileSync("git", ["branch", "--show-current"]).toString().trim();
  if (!branch || branch === "main" || execFileSync("git", ["status", "--porcelain", "--", "catalog/catalog.json"]).length) throw new Error("Use a feature worktree with an unchanged catalog recipe");
  if (statSync(metadataPath).size > 65536) throw new Error("Release inventory is oversized");
  const release = JSON.parse(readFileSync(metadataPath));
  if (release.version !== version || typeof release.archives !== "object") throw new Error("Release identity differs from the requested version");
  const members = ["CADDY-README.md", "LICENSE", "README.md", "caddy", "daylight", "examples/site.json", "site/index.html"].sort();
  const digests = {};
  let page;
  for (const arch of ["amd64", "arm64"]) {
    const name = `daylight-v${version}-linux-${arch}.tar.gz`;
    const file = path.resolve(directory, name);
    if (statSync(file).size > 64 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(release.archives[name] ?? "")) throw new Error("Archive is unavailable or oversized");
    const digest = sha256(readFileSync(file));
    if (digest !== release.archives[name]) throw new Error("Archive differs from the verified inventory");
    const entries = execFileSync("tar", ["-tzf", file], { maxBuffer: 65536, timeout: 30000 }).toString().trim().split("\n").sort();
    if (JSON.stringify(entries) !== JSON.stringify(members)) throw new Error("Shared website requires the exact reviewed archive members");
    const content = execFileSync("tar", ["-xOzf", file, "site/index.html"], { maxBuffer: 512 * 1024, timeout: 30000 });
    if (!content.length || content.toString().includes("\uFFFD") || (page && !page.equals(content))) throw new Error("Both architectures must deliver the same nonempty UTF-8 page");
    page = content;
    digests[arch] = digest;
  }
  const file = "catalog/catalog.json";
  const catalog = JSON.parse(readFileSync(file));
  for (const id of ["daylight", "daylight-https"]) {
    const app = catalog.apps.find(app => app.id === id);
    if (!app || compareVersions(version, app.version) <= 0 || app.runtime.kind !== "systemd" || app.runtime.version !== 2 || app.runtime.nativeServices.services.length !== 1) throw new Error("Expected an earlier reviewed Daylight recipe");
    if (app.artifacts.length !== 2 || new Set(app.artifacts.map(artifact => artifact.architecture)).size !== 2) throw new Error("Both reviewed Linux architectures are required");
    app.version = version;
    app.packageRevision = 1;
    app.runtime.requiredCapabilities = ["native-services", "shared-caddy"];
    const service = app.runtime.nativeServices.services[0];
    if (service.name !== "web" || service.process.executable !== "daylight" || service.process.artifact !== "caddy") throw new Error("Website service identity changed");
    service.start = "manual";
    service.process.arguments = [{ literal: "version" }];
    delete service.process.health;
    delete service.process.bindService;
    if (!service.process.files.some(file => file.path === "site/index.html")) service.process.files.push({ path: "site/index.html" });
    for (const artifact of app.artifacts) {
      if (artifact.name !== "caddy" || artifact.operatingSystem !== "linux" || !digests[artifact.architecture]) throw new Error("Unexpected website artifact identity");
      artifact.url = `https://downloads.petauron.com/daylight/v${version}/daylight-v${version}-linux-${artifact.architecture}.tar.gz`;
      artifact.sha256 = digests[artifact.architecture];
    }
    app.description = {
      en: "Independently released website content served by the host's shared managed Caddy. Certificates are managed by Center.",
      "zh-CN": "独立发布的网站内容，由主机共用的受管 Caddy 提供服务，证书由主控统一管理。",
    };
  }
  writeFileSync(file, JSON.stringify(catalog, null, 2) + "\n");
  process.stdout.write("Prepared Daylight content recipes only; review versions, CI and rollout prerequisites before publication.\n");
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
