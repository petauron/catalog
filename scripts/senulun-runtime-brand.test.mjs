import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyRelease } from "./release-source.mjs";

test("verified new release converts runtime names without changing installation identities", () => {
  const baseline = JSON.parse(readFileSync(new URL("../catalog/catalog.json", import.meta.url)));
  const before = JSON.stringify(baseline);
  const rule = JSON.parse(readFileSync(new URL("../catalog/sources.json", import.meta.url))).sources.pulse;
  const collector = baseline.apps.find(app => app.id === rule.artifactApp);
  const verified = { version: "1.0.0", image: "ghcr.io/example/monitor@sha256:" + "a".repeat(64), artifacts: collector.artifacts.map(item => ({ ...item, url: "https://example.invalid/senulun.tar.gz", sha256: "b".repeat(64) })) };
  const result = applyRelease(baseline, verified, rule);
  assert.equal(JSON.stringify(baseline), before, "historical recipe was modified");
  const service = result.apps.find(app => app.id === rule.imageApp);
  const agent = result.apps.find(app => app.id === rule.artifactApp);
  assert.equal(service.id, "pulse", "immutable app identity changed");
  assert.equal(agent.id, "pulse-agent");
  const container = service.runtime.docker.containers[0];
  assert.ok(container.environment.SENULUN_PUBLIC_URL);
  assert.ok(!container.environment.PULSE_PUBLIC_URL);
  assert.equal(container.mounts[0].storage, "data");
  assert.equal(container.mounts[0].target, "/var/lib/senulun");
  assert.deepEqual(container.arguments, [{ literal: "migrate-and-serve" }]);
  assert.equal(agent.runtime.systemd.executable, "senulun-agent");
  assert.equal(agent.runtime.systemd.user, "vastora-senulun");
  assert.ok(agent.runtime.systemd.environment.SENULUN_CREDENTIALS_PATH);
  assert.deepEqual(agent.runtime.systemd.stateDirectories, collector.runtime.systemd.stateDirectories);
  assert.deepEqual(applyRelease(result, verified, rule), result, "replay changed runtime metadata");
});
