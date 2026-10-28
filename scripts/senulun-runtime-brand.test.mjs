import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyRelease } from "./release-source.mjs";

test("verified new release converts runtime names without changing installation identities", () => {
  const baseline = JSON.parse(readFileSync(new URL("../catalog/catalog.json", import.meta.url)));
  const before = JSON.stringify(baseline);
  const rule = JSON.parse(readFileSync(new URL("../catalog/sources.json", import.meta.url))).sources.pulse;
  const collector = baseline.apps.find(app => app.id === rule.artifactApp);
  const verified = { version: "1.0.0", image: "ghcr.io/example/monitor@sha256:" + "a".repeat(64), artifacts: collector.artifacts.map(item => ({ ...item, url: "https://example.invalid/senlun.tar.gz", sha256: "b".repeat(64) })) };
  const result = applyRelease(baseline, verified, rule);
  assert.equal(JSON.stringify(baseline), before, "historical recipe was modified");
  const service = result.apps.find(app => app.id === rule.imageApp);
  const agent = result.apps.find(app => app.id === rule.artifactApp);
  assert.equal(service.id, "pulse", "immutable app identity changed");
  assert.equal(agent.id, "pulse-agent");
  const container = service.runtime.docker.containers[0];
  assert.ok(container.environment.SENLUN_PUBLIC_URL);
  assert.ok(!container.environment.PULSE_PUBLIC_URL);
  assert.ok(!container.environment.SENLUN_SETUP_TOKEN_FILE);
  assert.ok(!service.config.some(field => field.key === "setup_token"));
  assert.deepEqual(container.credentials ?? [], []);
  for (const key of ["service_url", "node_name", "node_group", "enrollment_token"]) {
    assert.ok(agent.config.some(field => field.key === key), `missing explicit Agent input: ${key}`);
  }
  assert.equal(container.mounts[0].storage, "data");
  assert.equal(container.mounts[0].target, "/var/lib/senlun");
  assert.deepEqual(container.arguments, [{ literal: "migrate-and-serve" }]);
  assert.equal(agent.runtime.systemd.executable, "senlun-agent");
  assert.equal(agent.runtime.systemd.user, "vastora-senlun");
  assert.ok(agent.runtime.systemd.environment.SENLUN_CREDENTIALS_PATH);
  assert.deepEqual(agent.runtime.systemd.stateDirectories, collector.runtime.systemd.stateDirectories);
  assert.deepEqual(applyRelease(result, verified, rule), result, "replay changed runtime metadata");
});

test("reviewed UI-only publication retains the accepted Senlun runtime contract", async () => {
  const { mergeReviewedRecipes } = await import("./catalog-plan.mjs");
  const baseline = JSON.parse(readFileSync(new URL("../catalog/catalog.json", import.meta.url)));
  const rule = JSON.parse(readFileSync(new URL("../catalog/sources.json", import.meta.url))).sources.pulse;
  const collector = baseline.apps.find(app => app.id === rule.artifactApp);
  const active = applyRelease(baseline, {
    version: "1.0.0", image: "ghcr.io/example/monitor@sha256:" + "a".repeat(64),
    artifacts: collector.artifacts.map(item => ({ ...item, url: "https://example.invalid/senlun.tar.gz", sha256: "b".repeat(64) })),
  }, rule);
  const merged = mergeReviewedRecipes(baseline, active);
  for (const id of [rule.imageApp, rule.artifactApp]) {
    const accepted = active.apps.find(app => app.id === id);
    const next = merged.apps.find(app => app.id === id);
    assert.equal(next.version, accepted.version);
    assert.deepEqual(next.runtime, accepted.runtime);
    assert.deepEqual(next.artifacts, accepted.artifacts);
    assert.deepEqual(next.images, accepted.images);
  }
});
