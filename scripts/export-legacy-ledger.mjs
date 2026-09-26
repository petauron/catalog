// Read-only upstream export. Run again during the maintenance freeze, then
// review/import its immutable output. This never creates/edits old releases.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execute, sha256 } from "./release-source.mjs";
import { validatePublication } from "./publish-catalog.mjs";

export function exportLegacyLedger(directory, run = execute) {
  if (!directory) throw new Error("An isolated empty export directory is required");
  mkdirSync(directory, { mode: 0o700 });
  const repository = "petauron/vastora";
  const releases = JSON.parse(run("gh", ["api", "--paginate", "--slurp", `repos/${repository}/releases?per_page=100`])).flat().filter(release => /^catalog-r[1-9][0-9]*$/.test(release.tag_name)).sort((a, b) => Number(a.tag_name.slice(9)) - Number(b.tag_name.slice(9)));
  if (!releases.length) throw new Error("The established ledger cannot be empty");
  const entries = [];
  for (const summary of releases) {
    const metadata = run("gh", ["api", `repos/${repository}/releases/${summary.id}`]);
    const release = JSON.parse(metadata);
    if (release.id !== summary.id || release.tag_name !== summary.tag_name || release.target_commitish !== summary.target_commitish || release.draft !== summary.draft) throw new Error("Legacy source changed during capture; restart from a new directory after freezing publication");
    const metadataFile = `${release.tag_name}.release.base64`;
    writeFileSync(path.join(directory, metadataFile), Buffer.from(metadata).toString("base64") + "\n", { mode: 0o600, flag: "wx" });
    const assets = release.assets.filter(asset => asset.name === "catalog-publication.json");
    if (assets.length > 1) throw new Error("Ambiguous legacy ledger asset");
    const entry = { release, metadataFile, metadataSHA256: sha256(metadata) };
    if (assets.length === 0 || assets[0].state !== "uploaded") {
      if (!release.draft) throw new Error("Published legacy release has no ledger");
      entries.push({ ...entry, incomplete: true });
      continue; // preserve reserved revision; production acceptance will block
    }
    if (assets[0].size > 40 * 1024 * 1024 || assets[0].size <= 0) throw new Error("Invalid legacy asset size");
    const bytes = run("gh", ["api", `repos/${repository}/releases/assets/${assets[0].id}`, "-H", "Accept: application/octet-stream"]);
    const digest = sha256(bytes);
    if (bytes.length !== assets[0].size || (assets[0].digest && assets[0].digest !== `sha256:${digest}`)) throw new Error("Legacy asset bytes differ from release inventory");
    const bundle = JSON.parse(bytes); validatePublication(bundle);
    if (bundle.commit !== release.target_commitish || bundle.revision !== Number(release.tag_name.slice(9))) throw new Error("Legacy release and ledger disagree");
    const file = `${release.tag_name}.base64`;
    writeFileSync(path.join(directory, file), Buffer.from(bytes).toString("base64") + "\n", { mode: 0o600, flag: "wx" });
    entries.push({ ...entry, file, sha256: digest });
  }
  const finalInventory = JSON.parse(run("gh", ["api", "--paginate", "--slurp", `repos/${repository}/releases?per_page=100`])).flat().filter(release => /^catalog-r[1-9][0-9]*$/.test(release.tag_name)).sort((a, b) => Number(a.tag_name.slice(9)) - Number(b.tag_name.slice(9)));
  const inventoryIdentity = items => items.map(item => ({ tag: item.tag_name, commit: item.target_commitish, draft: item.draft, assets: item.assets.map(asset => ({ id: asset.id, name: asset.name, state: asset.state, size: asset.size, digest: asset.digest })) }));
  if (JSON.stringify(inventoryIdentity(finalInventory)) !== JSON.stringify(inventoryIdentity(releases))) throw new Error("Legacy publication inventory changed during capture");
  // The index pins exact bytes and metadata, including draft status/commit.
  const index = { schemaVersion: 1, source: repository, capturedAt: new Date().toISOString(), entries };
  writeFileSync(path.join(directory, "index.json"), JSON.stringify(index, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return index;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try { const result = exportLegacyLedger(process.argv[2]); console.log(`Captured ${result.entries.length} legacy records without modifying upstream. Re-capture during the final publication freeze before cutover.`); }
  catch { console.error("Legacy capture did not complete. Preserve the output for investigation and use a new directory after resolving upstream changes."); process.exitCode = 1; }
}
