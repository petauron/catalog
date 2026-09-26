// Discover hints only; verifyRelease remains the authority for all artifacts.
import { compareVersions, execute, validateRequest } from "./release-source.mjs";

export function discoverRelease(application, registry, catalog, run = execute) {
  const rule = registry.sources?.[application];
  validateRequest({ application, tag: "v0.0.0", sha: "0".repeat(40), runId: "1" }, registry);
  const apps = [rule.imageApp, rule.artifactApp].map(id => catalog.apps.find(app => app.id === id));
  if (apps.some(app => !app)) throw new Error("Missing source recipe");
  const api = endpoint => JSON.parse(run("gh", ["api", `repos/${rule.repository}/${endpoint}`]));
  // Bounded discovery. A missing older release can be submitted manually.
  const releases = api("releases?per_page=100");
  const candidates = releases.filter(release => {
    if (release.draft !== false || !release.published_at || typeof release.tag_name !== "string") return false;
    try {
      validateRequest({ application, tag: release.tag_name, sha: "0".repeat(40), runId: "1" }, registry);
      return apps.some(app => compareVersions(release.tag_name.slice(1), app.version) > 0)
        && apps.every(app => compareVersions(release.tag_name.slice(1), app.version) >= 0);
    } catch { return false; }
  }).sort((a, b) => compareVersions(b.tag_name.slice(1), a.tag_name.slice(1)));
  if (!candidates.length) return null;
  const tag = candidates[0].tag_name;
  let ref = api(`git/ref/tags/${tag}`).object;
  for (let i = 0; ref?.type === "tag" && i < 4; i++) ref = api(`git/tags/${ref.sha}`).object;
  if (ref?.type !== "commit" || !/^[a-f0-9]{40}$/.test(ref.sha)) throw new Error("Unresolved release tag");
  const workflow = encodeURIComponent(rule.workflow.split("/").at(-1));
  const runs = api(`actions/workflows/${workflow}/runs?event=push&head_sha=${ref.sha}&per_page=100`).workflow_runs;
  for (const run of runs) {
    if (run.head_sha !== ref.sha || run.event !== "push" || run.path !== rule.workflow || !Number.isSafeInteger(run.id) || run.id < 1) continue;
    const jobs = api(`actions/runs/${run.id}/jobs?filter=latest&per_page=100`).jobs.filter(job => job.name === rule.publishJob);
    if (jobs.length === 1 && jobs[0].status === "completed" && jobs[0].conclusion === "success") {
      const request = { application, tag, sha: ref.sha, runId: String(run.id) };
      validateRequest(request, registry);
      return request;
    }
  }
  throw new Error("Latest release has no successful publishing job; retry next poll");
}
