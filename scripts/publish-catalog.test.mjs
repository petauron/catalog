import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { packagePublication, publishCatalog, selectPublication, unpackPublication, validatePublication, verifyLedgerAsset } from "./publish-catalog.mjs";

const commit = "a".repeat(40);
const checksum = value => createHash("sha256").update(value).digest("hex");
function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "catalog-publisher-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const catalog = path.join(directory, "catalog.json");
  writeFileSync(catalog, '{"apps":[{"id":"known"}]}');
  const rootDirectory = path.join(directory, "roots");
  mkdirSync(rootDirectory);
  writeFileSync(path.join(rootDirectory, "1.root.json"), '{"fixture":"independent root"}');
  const options = { revision: 1, commit, repository: "petauron/vastora", work: path.join(directory, "run1"), rootDirectory, catalog, binDirectory: "/test/bin", bucket: "download", endpoint: "https://example.r2.cloudflarestorage.com", bootstrap: true, runURL: "https://github.com/petauron/vastora/actions/runs/1", keyFiles: { targets: "/protected/targets.pem", snapshot: "/protected/snapshot.pem", timestamp: "/protected/timestamp.pem" } };
  const calls = [];
  const releases = [];
  const ledgers = new Map();
  let active;
  const stage = (output, revision) => {
    mkdirSync(output);
    mkdirSync(path.join(output, "targets"));
    const target = Buffer.from(JSON.stringify({ revision, fixture: "signed target" }));
    const sha256 = checksum(target);
    for (const [name, raw] of Object.entries({ "1.root.json": '{"fixture":"independent root"}', [`${revision}.targets.json`]: `{"version":${revision}}`, [`${revision}.snapshot.json`]: `{"version":${revision}}`, "timestamp.json": `{"version":${revision}}`, [`targets/${sha256}.stable.json`]: target, "publication-state.json": JSON.stringify({ channel: "stable", revision, sha256 }), "manifest-history.json": JSON.stringify({ known: { "1.0.0": "b".repeat(64) } }) })) writeFileSync(path.join(output, name), raw);
  };
  const run = (command, args) => {
    calls.push({ command, args });
    const flag = name => args[args.indexOf(name) + 1];
    if (command.endsWith("/catalog-publish")) {
      const output = flag("--output");
      stage(output, Number(flag("--revision")));
      for (const key of ["--ui-bundle", "--ui-style"]) {
        if (!args.includes(key)) continue;
        const source = flag(key);
        const raw = readFileSync(source);
        writeFileSync(path.join(output, "targets", `${checksum(raw)}.${path.basename(source)}`), raw);
      }
      return Buffer.from("");
    }
    if (command.endsWith("catalog-verify")) return Buffer.from("{}");
    if (command === "aws") {
      if (!active) { const error = new Error("absent"); error.stderr = "An error occurred (NoSuchKey)"; throw error; }
      writeFileSync(args[args.indexOf("--key") + 2], active);
      return Buffer.from(JSON.stringify({ ETag: '"previous-etag"' }));
    }
    assert.equal(command, "gh");
    if (args[0] === "api") return Buffer.from(JSON.stringify(args.at(-1).includes("/releases/tags/") ? releases.find(release => release.tag_name === args.at(-1).split("/").at(-1)) : [releases]));
    assert.equal(args[0], "release");
    const tag = args[2];
    if (args[1] === "create") {
      assert.ok(args.includes("--draft"));
      assert.ok(args.includes("--latest=false"));
      const raw = readFileSync(args[3]);
      releases.push({ tag_name: tag, target_commitish: flag("--target"), draft: true, assets: [{ name: "catalog-publication.json", state: "uploaded", size: raw.length, digest: `sha256:${checksum(raw)}` }] });
      ledgers.set(tag, raw);
    } else if (args[1] === "download") {
      if (!ledgers.has(tag)) throw new Error("ledger unavailable");
      writeFileSync(path.join(flag("--dir"), "catalog-publication.json"), ledgers.get(tag));
    } else if (args[1] === "edit") {
      assert.ok(args.includes("--latest=false"));
      releases.find(release => release.tag_name === tag).draft = false;
    } else assert.fail("Unexpected gh operation");
    return Buffer.from("{}");
  };
  const upload = options => { calls.push({ command: "upload", options }); active = readFileSync(path.join(options.directory, "timestamp.json")); };
  return { directory, options, calls, releases, ledgers, stage, run, upload, setActive: bytes => { active = bytes; } };
}

test("requires explicit bootstrap, monotonic revision, exact retry commit, and no pending predecessor", () => {
  const release = { tag_name: "catalog-r3", target_commitish: commit, draft: true };
  assert.throws(() => selectPublication([], 1, commit, false), /Bootstrap/);
  assert.throws(() => selectPublication([release], 2, commit, false), /lower/);
  assert.throws(() => selectPublication([release], 4, commit, false), /pending/);
  assert.throws(() => selectPublication([release], 3, "b".repeat(40), false), /original/);
  assert.equal(selectPublication([release], 3, commit, false).resume.tag_name, "catalog-r3");
});

test("verified signatures enter a durable draft before R2 and public verification precedes completion", t => {
  const f = fixture(t);
  publishCatalog(f.options, f.run, f.upload);
  const index = name => f.calls.findIndex(call => call.command === name);
  assert.ok(index("/test/bin/catalog-verify") < index("upload"));
  const create = f.calls.findIndex(call => call.command === "gh" && call.args[1] === "create");
  const confirm = f.calls.findIndex(call => call.command === "gh" && call.args[1] === "download");
  assert.ok(create < confirm && confirm < index("upload"));
  assert.equal(f.calls.at(-2).args[0], "--origin");
  assert.equal(f.calls.at(-1).args[1], "edit");
  assert.equal(f.releases[0].draft, false);
  const signer = f.calls.find(call => call.command.endsWith("/catalog-publish"));
  assert.ok(!signer.args.includes("--valid-for"));
  assert.ok(!f.ledgers.get("catalog-r1").includes(Buffer.from("PRIVATE KEY")));
});

test("schema 3 publication uses the deployed consumer verifier and legacy signer mode", t => {
  const f = fixture(t);
  publishCatalog({ ...f.options, legacyV3: true }, f.run, f.upload);
  const signer = f.calls.find(call => call.command.endsWith("/catalog-publish"));
  assert.ok(signer.args.includes("--legacy-v3"));
  const verifiers = f.calls.filter(call => call.command.endsWith("/vastora-v3-catalog-verify"));
  assert.equal(verifiers.length, 2);
});

test("lost activation response resumes exact saved signatures without re-signing or overwriting", t => {
  const f = fixture(t);
  assert.throws(() => publishCatalog(f.options, f.run, options => { f.upload(options); throw new Error("response lost"); }), /lost/);
  assert.equal(f.releases[0].draft, true);
  publishCatalog({ ...f.options, work: path.join(f.directory, "retry") }, f.run, f.upload);
  assert.equal(f.calls.filter(call => call.command.endsWith("/catalog-publish")).length, 1);
  assert.equal(f.calls.filter(call => call.command === "upload").length, 1);
  assert.equal(f.releases[0].draft, false);
});

test("failed durable write confirmation never uploads; retry reads the saved asset", t => {
  const f = fixture(t);
  let failed = false;
  const interrupted = (command, args) => {
    if (command === "gh" && args[1] === "download" && !failed) { failed = true; throw new Error("readback failed"); }
    return f.run(command, args);
  };
  assert.throws(() => publishCatalog(f.options, interrupted, f.upload), /readback/);
  assert.ok(!f.calls.some(call => call.command === "upload"));
  publishCatalog({ ...f.options, work: path.join(f.directory, "retry") }, f.run, f.upload);
  assert.equal(f.calls.filter(call => call.command.endsWith("/catalog-publish")).length, 1);
  assert.equal(f.releases[0].draft, false);
});

test("new revision carries full prior history and uses a matching storage ETag", t => {
  const f = fixture(t);
  publishCatalog(f.options, f.run, f.upload);
  publishCatalog({ ...f.options, work: path.join(f.directory, "next"), revision: 2, bootstrap: false }, f.run, f.upload);
  const signed = f.calls.filter(call => call.command.endsWith("/catalog-publish")).at(-1);
  assert.ok(signed.args.includes("--history"));
  assert.ok(signed.args.includes("--previous"));
  const uploaded = f.calls.filter(call => call.command === "upload").at(-1);
  assert.equal(uploaded.options.previousETag, '"previous-etag"');
  assert.equal(uploaded.options.bootstrap, false);
});

test("signed Meridian UI assets are version-bound, immutable, and exact on retry", t => {
  const f = fixture(t);
  writeFileSync(f.options.catalog, '{"apps":[{"id":"meridian","version":"1.2.3"}]}');
  const script = path.join(f.directory, "ui-meridian-1.2.3.js");
  const style = path.join(f.directory, "ui-meridian-1.2.3.css");
  writeFileSync(script, "export const app = 'meridian';");
  writeFileSync(style, "body { color: green; }");
  const options = { ...f.options, uiBundle: script, uiStyle: style };
  assert.throws(() => publishCatalog({ ...options, uiStyle: undefined, work: path.join(f.directory, "missing-pair") }, f.run, f.upload), /together/);
  publishCatalog(options, f.run, f.upload);
  const signed = f.calls.find(call => call.command.endsWith("/catalog-publish"));
  assert.ok(signed.args.includes("--ui-bundle") && signed.args.includes("--ui-style"));
  const bundle = JSON.parse(f.ledgers.get("catalog-r1"));
  const signedScript = Object.keys(bundle.files).find(name => name.endsWith(".ui-meridian-1.2.3.js"));
  assert.equal(Buffer.from(bundle.files[signedScript], "base64").toString(), readFileSync(script, "utf8"));
  assert.throws(() => validatePublication({ ...bundle, files: { ...bundle.files, [signedScript]: Buffer.from("changed").toString("base64") } }), /digest/);
  writeFileSync(script, "export const app = 'changed';");
  assert.throws(() => publishCatalog({ ...options, work: path.join(f.directory, "retry") }, f.run, f.upload), /Retry UI differs/);
  assert.throws(() => publishCatalog({ ...options, revision: 2, bootstrap: false, work: path.join(f.directory, "new-revision") }, f.run, f.upload), /changed without an application version/);
  assert.throws(() => publishCatalog({ ...f.options, revision: 2, bootstrap: false, work: path.join(f.directory, "omitted") }, f.run, f.upload), /cannot be omitted/);
});

test("unexpected storage bytes block a newer activation", t => {
  const f = fixture(t);
  publishCatalog(f.options, f.run, f.upload);
  f.setActive(Buffer.from("another writer"));
  assert.throws(() => publishCatalog({ ...f.options, work: path.join(f.directory, "next"), revision: 2, bootstrap: false }, f.run, f.upload), /differs/);
  assert.equal(f.calls.filter(call => call.command === "upload").length, 1);
  assert.equal(f.releases[1].draft, true);
});

test("local or public signature rejection never marks the release complete", t => {
  for (const phase of ["--directory", "--origin"]) {
    const f = fixture(t);
    const run = (command, args) => {
      if (command.endsWith("/catalog-verify") && args[0] === phase) throw new Error("signature rejected");
      return f.run(command, args);
    };
    assert.throws(() => publishCatalog(f.options, run, f.upload), /signature/);
    assert.ok(!f.calls.some(call => call.command === "gh" && call.args[1] === "edit"));
    if (phase === "--directory") assert.equal(f.releases.length, 0);
    else assert.equal(f.releases[0].draft, true);
  }
});

test("completed retry only verifies; malformed ledger names and target substitution are rejected", t => {
  const f = fixture(t);
  publishCatalog(f.options, f.run, f.upload);
  const before = f.calls.filter(call => call.command === "upload").length;
  publishCatalog({ ...f.options, work: path.join(f.directory, "retry") }, f.run, f.upload);
  assert.equal(f.calls.filter(call => call.command === "upload").length, before);
  const bundle = JSON.parse(f.ledgers.get("catalog-r1"));
  assert.throws(() => validatePublication({ ...bundle, files: { ...bundle.files, "../signer.pem": "YQ==" } }), /Unexpected/);
  const target = Object.keys(bundle.files).find(key => key.startsWith("targets/"));
  assert.throws(() => validatePublication({ ...bundle, files: { ...bundle.files, [target]: "YQ==" } }), /Incomplete/);
});

test("archive extraction is allowlisted and never follows a symlink", t => {
  const f = fixture(t);
  const staged = path.join(f.directory, "staged");
  f.stage(staged, 1);
  const bundle = packagePublication(staged, { ...f.options, catalogSHA256: checksum(readFileSync(f.options.catalog)) });
  unpackPublication(bundle, path.join(f.directory, "unpacked"));
  assert.throws(() => unpackPublication(bundle, path.join(f.directory, "unpacked")), /EEXIST/);
  symlinkSync(f.options.catalog, path.join(staged, "2.root.json"));
  assert.throws(() => packagePublication(staged, { ...f.options, catalogSHA256: checksum(readFileSync(f.options.catalog)) }), /Invalid staged/);
});

test("supersession is explicit, strictly higher, and only applies to a pending revision", () => {
  const pending = { tag_name: "catalog-r3", target_commitish: commit, draft: true };
  assert.throws(() => selectPublication([pending], 3, commit, false, true), /higher/);
  assert.throws(() => selectPublication([{ ...pending, draft: false }], 4, commit, false, true), /pending/);
  assert.throws(() => selectPublication([pending], 4, commit, true, true), /Bootstrap/);
  assert.equal(selectPublication([pending], 4, commit, false, true).superseded[0].revision, 3);
});

test("an expired bootstrap draft can be superseded without deleting history or reusing its revision", t => {
  const f = fixture(t);
  assert.throws(() => publishCatalog(f.options, f.run, () => { throw new Error("upload unavailable"); }), /unavailable/);
  const oldBytes = Buffer.from(f.ledgers.get("catalog-r1"));
  publishCatalog({ ...f.options, revision: 2, bootstrap: false, supersede: true, work: path.join(f.directory, "replacement") }, f.run, f.upload);
  assert.ok(f.ledgers.get("catalog-r1").equals(oldBytes));
  assert.equal(f.releases[0].draft, true);
  assert.equal(f.releases[1].draft, false);
  const bundle = JSON.parse(f.ledgers.get("catalog-r2"));
  assert.equal(bundle.supersedesRevision, 1);
  const signer = f.calls.filter(call => call.command.endsWith("/catalog-publish")).at(-1);
  assert.ok(signer.args.includes("--history"));
  assert.ok(!signer.args.includes("--bootstrap"));
  assert.equal(f.calls.filter(call => call.command === "upload").at(-1).options.bootstrap, true);
});

test("supersession matches the preceding active ledger, and an interrupted supersession retries exact bytes", t => {
  const f = fixture(t);
  publishCatalog(f.options, f.run, f.upload);
  assert.throws(() => publishCatalog({ ...f.options, revision: 2, bootstrap: false, work: path.join(f.directory, "failed") }, f.run, () => { throw new Error("upload unavailable"); }), /unavailable/);
  // r2 reserved immutable bytes but r1 remains active. The approved r3 attempt
  // retains r2's complete history and may atomically replace only known bytes.
  const superseding = { ...f.options, revision: 3, bootstrap: false, supersede: true, work: path.join(f.directory, "replacement") };
  assert.throws(() => publishCatalog(superseding, f.run, () => { throw new Error("interrupted"); }), /interrupted/);
  const oldBytes = Buffer.from(f.ledgers.get("catalog-r3"));
  publishCatalog({ ...superseding, supersede: false, work: path.join(f.directory, "retry") }, f.run, f.upload);
  assert.ok(f.ledgers.get("catalog-r3").equals(oldBytes));
  assert.equal(f.calls.filter(call => call.command.endsWith("/catalog-publish")).length, 3);
  assert.equal(f.releases[2].draft, false);
  assert.equal(f.calls.filter(call => call.command === "upload").at(-1).options.previousETag, '"previous-etag"');
});

test("supersession cannot bypass an unknown or missing active published timestamp", t => {
  for (const active of [undefined, Buffer.from("unaccounted writer")]) {
    const f = fixture(t);
    publishCatalog(f.options, f.run, f.upload);
    assert.throws(() => publishCatalog({ ...f.options, revision: 2, bootstrap: false, work: path.join(f.directory, "failed") }, f.run, () => { throw new Error("interrupted"); }), /interrupted/);
    f.setActive(active);
    assert.throws(() => publishCatalog({ ...f.options, revision: 3, bootstrap: false, supersede: true, work: path.join(f.directory, "replacement") }, f.run, f.upload), /absent|differs/);
    assert.equal(f.calls.filter(call => call.command === "upload").length, 1);
    assert.equal(f.releases[2].draft, true);
  }
});

test("failed GitHub asset upload reserves its revision but can be explicitly superseded", t => {
  const f = fixture(t);
  const failedAssetUpload = (command, args) => {
    const result = f.run(command, args);
    if (command === "gh" && args[1] === "create") {
      f.releases.at(-1).assets = [];
      f.ledgers.delete(args[2]);
      throw new Error("asset upload interrupted");
    }
    return result;
  };
  assert.throws(() => publishCatalog(f.options, failedAssetUpload, f.upload), /interrupted/);
  assert.ok(!f.calls.some(call => call.command === "upload"));
  publishCatalog({ ...f.options, revision: 2, bootstrap: false, supersede: true, work: path.join(f.directory, "replacement") }, f.run, f.upload);
  assert.equal(f.releases[0].tag_name, "catalog-r1");
  assert.equal(f.releases[0].draft, true);
  assert.equal(f.releases[1].draft, false);
  const signer = f.calls.filter(call => call.command.endsWith("/catalog-publish")).at(-1);
  assert.ok(signer.args.includes("--bootstrap"));
  assert.equal(signer.args[signer.args.indexOf("--revision") + 1], "2");
});

test("supersession cannot treat an unavailable or corrupt uploaded ledger as an empty draft", t => {
  for (const failure of ["unavailable", "corrupt"]) {
    const f = fixture(t);
    assert.throws(() => publishCatalog(f.options, f.run, () => { throw new Error("interrupted"); }), /interrupted/);
    if (failure === "unavailable") f.ledgers.delete("catalog-r1");
    else f.ledgers.set("catalog-r1", Buffer.from("corrupt"));
    assert.throws(() => publishCatalog({ ...f.options, revision: 2, bootstrap: false, supersede: true, work: path.join(f.directory, "replacement") }, f.run, f.upload));
    assert.equal(f.calls.filter(call => call.command.endsWith("/catalog-publish")).length, 1);
    assert.ok(!f.calls.some(call => call.command === "upload"));
  }
});

test("every live ledger read requires exact authenticated asset size and SHA256", () => {
  const bytes = Buffer.from("ledger");
  const release = { draft: true, assets: [{ name: "catalog-publication.json", state: "uploaded", size: bytes.length, digest: `sha256:${checksum(bytes)}` }] };
  verifyLedgerAsset(release, bytes);
  assert.throws(() => verifyLedgerAsset(release, Buffer.from("Ledger")), /digest/);
  assert.throws(() => verifyLedgerAsset(release, Buffer.from("ledger extra")), /digest/);
  const noDigest = { ...release, assets: [{ ...release.assets[0], digest: undefined }] };
  assert.throws(() => verifyLedgerAsset(noDigest, bytes), /digest/);
  // Old imported assets may predate GitHub digests, but their exact bytes are
  // separately pinned in the reviewed migration index before reaching here.
  verifyLedgerAsset(noDigest, bytes, { legacy: true });
  assert.throws(() => verifyLedgerAsset({ ...release, assets: [...release.assets, ...release.assets] }, bytes), /Ambiguous/);
});

test("an asset changed after planning cannot seed history or activate a retry", t => {
  for (const draft of [true, false]) {
    const f = fixture(t);
    publishCatalog(f.options, f.run, f.upload);
    f.releases[0].draft = draft;
    // Structurally valid substituted metadata must still fail inventory hash.
    const bundle = JSON.parse(f.ledgers.get("catalog-r1"));
    bundle.runURL = "https://github.com/petauron/catalog/actions/runs/9";
    f.ledgers.set("catalog-r1", Buffer.from(JSON.stringify(bundle)));
    const before = f.calls.length;
    assert.throws(() => publishCatalog({ ...f.options, revision: draft ? 1 : 2, bootstrap: false, work: path.join(f.directory, "changed") }, f.run, f.upload), /digest/);
    assert.ok(!f.calls.slice(before).some(call => call.command.endsWith("/catalog-publish") || call.command === "upload"));
  }
});

test("a changed draft identity on upload confirmation never reaches storage", t => {
  const f = fixture(t);
  const run = (command, args) => {
    const value = f.run(command, args);
    if (command === "gh" && args[0] === "api" && args.at(-1).includes("/releases/tags/")) return Buffer.from(JSON.stringify({ ...JSON.parse(value), target_commitish: "b".repeat(40) }));
    return value;
  };
  assert.throws(() => publishCatalog(f.options, run, f.upload), /identity changed/);
  assert.equal(f.releases[0].draft, true);
  assert.ok(!f.calls.some(call => call.command === "upload"));
});
