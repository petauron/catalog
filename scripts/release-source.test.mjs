import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyRelease, compareVersions, fetchBounded, parseChecksums, sha256, validateRequest, verifyRelease, verifyReleaseIdentity } from "./release-source.mjs";

const registry = JSON.parse(readFileSync(new URL("../catalog/sources.json", import.meta.url)));
const rule = registry.sources.pulse;
const request = { application: "pulse", runId: "123", sha: "a".repeat(40), tag: "v0.1.0-alpha.5" };
function identity() {
  return { release: { tag_name: request.tag, draft: false, published_at: "2026-09-26T00:00:00Z", prerelease: true, assets: [] }, run: { id: 123, head_sha: request.sha, path: rule.workflow, event: "push", head_repository: { full_name: rule.repository }, repository: { full_name: rule.repository }, status: "in_progress", conclusion: null }, jobs: [{ name: rule.publishJob, status: "completed", conclusion: "success" }], tag: request.sha, comparison: { status: "ahead" }, branch: { protected: true } };
}

test("source input contains no URL/digest authority and must map to a reviewed source", () => {
  assert.equal(validateRequest(request, registry), rule);
  for (const override of [{ application: "other" }, { sha: "main" }, { runId: "1/../../x" }, { tag: "v01.0.0" }, { url: "https://evil.invalid" }]) assert.throws(() => validateRequest({ ...request, ...override }, registry));
  assert.throws(() => validateRequest(request, { schemaVersion: 1, sources: { pulse: { ...rule, allowPrerelease: false } } }));
});

test("canonical versions correctly order prereleases, release and large numeric segments", () => {
  const values = ["0.1.0-alpha.4", "0.1.0-alpha.5", "0.1.0-alpha.10", "0.1.0-beta.1", "0.1.0-rc.1", "0.1.0", "0.2.0", "10.0.0"];
  values.forEach((value, index) => { assert.equal(compareVersions(value, value), 0); if (index) assert.equal(compareVersions(value, values[index - 1]), 1); });
  assert.equal(compareVersions("1.0.0-dev.12", "1.0.0-dev.2"), 1);
  assert.equal(compareVersions("1.0.0+build.1", "1.0.0"), 0);
  assert.throws(() => compareVersions("v1.0.0", "1.0.0"));
});

test("source SHA, trusted tag, protected main and successful publishing job are all required", () => {
  verifyReleaseIdentity(request, rule, identity());
  for (const mutate of [x => { x.tag = "b".repeat(40); }, x => { x.branch.protected = false; }, x => { x.comparison.status = "diverged"; }, x => { x.release.draft = true; }, x => { x.release.assets = undefined; }, x => { x.run.event = "pull_request"; }, x => { x.run.head_sha = "b".repeat(40); }, x => { x.run.repository.full_name = "untrusted/pulse"; }, x => { x.jobs[0].conclusion = "failure"; }, x => { x.jobs = []; }]) {
    const value = identity(); mutate(value); assert.throws(() => verifyReleaseIdentity(request, rule, value));
  }
  // A previous notify-only failure must remain independently retryable.
  const value = identity(); value.run.conclusion = "failure"; verifyReleaseIdentity(request, rule, value);
});

test("checksum parser rejects duplicate, unsafe, and malformed names", () => {
  const line = `${"b".repeat(64)}  a.tar.gz`;
  assert.equal(parseChecksums(line).get("a.tar.gz"), "b".repeat(64));
  for (const value of [`${line}\n${line}`, `${"b".repeat(64)}  ../a`, "malformed", `${"b".repeat(64)}  sub/path`]) assert.throws(() => parseChecksums(value));
});

test("download origins, redirect credentials and streaming bounds fail closed", async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return new Response("four"); };
  assert.equal((await fetchBounded("https://github.com/o/r", 4, {}, fetcher)).toString(), "four");
  await assert.rejects(fetchBounded("http://github.com/x", 4, {}, fetcher));
  await assert.rejects(fetchBounded("https://127.0.0.1/x", 4, {}, fetcher));
  await assert.rejects(fetchBounded("https://user:secret@github.com/x", 4, {}, fetcher));
  assert.equal(calls, 1);
  await assert.rejects(fetchBounded("https://github.com/x", 3, {}, fetcher), /byte limit/);
  await assert.rejects(fetchBounded("https://ghcr.io/v2/x", 4, { Authorization: "Bearer fixture" }, async () => new Response(null, { status: 302, headers: { location: "https://github.com/x" } })), /credential redirect/);
});

test("release verification independently attests both archives and exact multiarch index", async t => {
  const directory = mkdtempSync(path.join(tmpdir(), "catalog-release-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const raw = new Map([...["x86_64", "aarch64"].map(arch => [`pulse-${request.tag}-linux-${arch}.tar.gz`, Buffer.from(`fixture-${arch}`)])]);
  raw.set("SHA256SUMS", Buffer.from([...raw].map(([name, bytes]) => `${sha256(bytes)}  ${name}`).join("\n")));
  const info = identity();
  info.release.assets = [...raw].map(([name, bytes]) => ({ name, size: bytes.length, state: "uploaded", digest: `sha256:${sha256(bytes)}`, browser_download_url: `https://github.com/petauron/pulse/releases/download/${request.tag}/${name}` }));
  const calls = [];
  const run = (command, args) => {
    assert.equal(command, "gh"); calls.push(args);
    if (args[0] === "attestation") return Buffer.from("");
    const endpoint = args.at(-1);
    const data = endpoint.includes("/releases/") ? info.release : endpoint.includes("/jobs?") ? [{ jobs: info.jobs }] : endpoint.includes("/actions/runs/") ? info.run : endpoint.includes("/git/ref/") ? { object: { type: "commit", sha: request.sha } } : endpoint.includes("/compare/") ? info.comparison : info.branch;
    return Buffer.from(JSON.stringify(data));
  };
  const index = Buffer.from(JSON.stringify({ manifests: ["amd64", "arm64"].map(architecture => ({ platform: { os: "linux", architecture }, digest: `sha256:${"c".repeat(64)}` })) }));
  const download = async url => url.includes("/token?") ? Buffer.from('{"token":"fixture"}') : url.includes("/manifests/") ? index : raw.get(url.split("/").at(-1));
  const verified = await verifyRelease(request, registry, path.join(directory, "assets"), run, download);
  assert.equal(verified.artifacts.length, 2); assert.equal(verified.image, `ghcr.io/petauron/pulse@sha256:${sha256(index)}`);
  const attestations = calls.filter(args => args[0] === "attestation");
  assert.equal(attestations.length, 3);
  for (const args of attestations) { assert.ok(args.includes("--source-digest")); assert.ok(args.includes(request.sha)); assert.ok(args.includes("--signer-digest")); assert.ok(args.includes(`refs/tags/${request.tag}`)); assert.ok(args.includes("--deny-self-hosted-runners")); }
});

test("updates only declared artifact coordinates, preserves recipe revisions and rejects rollback/mutation", () => {
  const input = { schemaVersion: 4, apps: [{ id: "pulse", version: "0.1.0-alpha.4", packageRevision: 3, images: [{ name: "pulse", reference: "old" }] }, { id: "pulse-agent", version: "0.1.0-alpha.4", packageRevision: 2, artifacts: [{ name: "pulse-agent", operatingSystem: "linux", architecture: "amd64", format: "tar.gz", stripComponents: 1, url: "old", sha256: "old" }] }] };
  const verified = { version: "0.1.0-alpha.5", image: "new", artifacts: [{ name: "pulse-agent", operatingSystem: "linux", architecture: "amd64", url: "new", sha256: "new" }] };
  const next = applyRelease(input, verified, rule);
  assert.equal(next.apps[0].packageRevision, 3); assert.equal(next.apps[1].artifacts[0].stripComponents, 1); assert.equal(input.apps[0].version, "0.1.0-alpha.4");
  assert.deepEqual(applyRelease(next, verified, rule), next);
  assert.throws(() => applyRelease(next, { ...verified, version: "0.1.0-alpha.4" }, rule), /rollback/);
  assert.throws(() => applyRelease(next, { ...verified, image: "changed" }, rule), /immutable/);
});
