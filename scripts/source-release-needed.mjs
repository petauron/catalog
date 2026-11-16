import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

// These are reviewed catalog inputs or their existing pin assertions, not the
// protocol or publisher implementation. Any unrecognized path is releasable.
const catalogInputs = new Set([
  "catalog/catalog.json",
  "catalog/catalog-v3.json",
  "scripts/glivela-dual-runtime.test.mjs",
  "scripts/product-brand.test.mjs",
  "scripts/senulun-runtime-brand.test.mjs",
  "scripts/ui-publication-pins.test.mjs",
]);
const recipe = /^catalog\/recipes\/[a-z0-9][a-z0-9-]*\.runtime\.json$/;
const publicationWorkflow = ".github/workflows/publish.yml";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function withoutGlivelaPin(text) {
  // Normalize only the single reviewed Glivela checkout ref. A changed
  // workflow, an unexpected checkout or a missing pin is not catalog-only.
  const pin = /(^[ \t]*repository:[ \t]*petauron\/glivela[ \t]*\r?\n[ \t]*ref:[ \t]*)[a-f0-9]{40}([ \t]*(?:#.*)?$)/gm;
  if ([...text.matchAll(pin)].length !== 1) return null;
  return text.replace(pin, "$1<reviewed-glivela-pin>$2");
}

function isPinOnlyChange(base, head) {
  const before = withoutGlivelaPin(git("show", `${base}:${publicationWorkflow}`));
  const after = withoutGlivelaPin(git("show", `${head}:${publicationWorkflow}`));
  return before !== null && after !== null && before === after;
}

function sourceReleaseNeeded() {
  const head = git("rev-parse", "--verify", "HEAD^{commit}").trim();
  if (!/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? "") || head !== process.env.GITHUB_SHA) {
    throw new Error("Checkout does not match the workflow commit");
  }
  const version = JSON.parse(readFileSync(".release-please-manifest.json", "utf8"))["."];
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("Invalid last source release version");
  }
  const base = git("rev-parse", "--verify", `refs/tags/v${version}^{commit}`).trim();
  git("merge-base", "--is-ancestor", base, head);
  const changed = git("diff", "--name-only", "--no-renames", "-z", base, head, "--")
    .split("\0").filter(Boolean);
  return changed.some(file => {
    if (catalogInputs.has(file) || recipe.test(file)) return false;
    if (file === publicationWorkflow) return !isPinOnlyChange(base, head);
    return true;
  });
}

if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
let needed = true;
try {
  needed = sourceReleaseNeeded();
} catch {
  // Never suppress a genuine source release if the baseline or diff is unclear.
  console.warn("Could not classify source changes; keeping the normal release flow.");
}
appendFileSync(process.env.GITHUB_OUTPUT, `needed=${needed}\n`);
console.log(needed ? "Source release processing is needed." : "Only catalog inputs changed; skipping the source version PR.");
