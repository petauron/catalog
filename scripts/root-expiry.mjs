import { readdirSync, readFileSync } from "node:fs";
const roots = readdirSync("catalog/trust").filter(name => /^[1-9][0-9]*\.root\.json$/.test(name)).sort((a, b) => Number(a.split(".")[0]) - Number(b.split(".")[0]));
if (!roots.length) throw new Error("Reviewed public root is missing");
const root = JSON.parse(readFileSync(`catalog/trust/${roots.at(-1)}`));
const remaining = Date.parse(root.signed.expires) - Date.now();
if (!Number.isFinite(remaining) || remaining <= 0) throw new Error("Trusted root expired; offline root rotation is required");
if (remaining < 30 * 24 * 3600 * 1000) console.log("::warning::Trusted catalog root expires within 30 days; schedule offline threshold root rotation.");
