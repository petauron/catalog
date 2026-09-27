import { readFileSync } from "node:fs";
import path from "node:path";
import { loadImportedLedger } from "./catalog-plan.mjs";
import { publishCatalog } from "./publish-catalog.mjs";

try {
  const env = process.env;
  if (env.CATALOG_PRODUCTION_ENABLED !== "true" || env.GITHUB_REPOSITORY !== "petauron/catalog" || env.GITHUB_REF !== "refs/heads/main" || path.dirname(env.CATALOG_WORK ?? "") !== env.RUNNER_TEMP) throw new Error("Publication not enabled");
  const plan = JSON.parse(readFileSync(path.join(env.CATALOG_WORK, "plan.json")));
  if (plan.commit !== env.GITHUB_SHA || plan.repository !== env.GITHUB_REPOSITORY) throw new Error("Reviewed plan identity mismatch");
  publishCatalog({ ...plan, importedLedger: loadImportedLedger("catalog/legacy-ledger"), bucket: env.R2_BUCKET_NAME, endpoint: env.R2_ENDPOINT, uiBundle: env.CATALOG_UI_BUNDLE, uiStyle: env.CATALOG_UI_STYLE, keyFiles: Object.fromEntries(["targets", "snapshot", "timestamp"].map(role => [role, env[`CATALOG_${role.toUpperCase()}_KEY_FILE`]])) });
} catch {
  console.error("Catalog publication was not confirmed. Keep the pending ledger and rerun the original request; do not supersede or overwrite automatically.");
  process.exitCode = 1;
}
