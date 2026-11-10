import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("dual-role package keeps separate authenticated worker identities and verified release coordinates", () => {
  const c = JSON.parse(readFileSync(new URL("../catalog/catalog.json", import.meta.url)));
  const dual = c.apps.find(a => a.id === "glivela-dual");
  const entry = c.apps.find(a => a.id === "glivela-entry");
  assert.equal(dual.version, entry.version);
  assert.deepEqual(dual.artifacts, entry.artifacts);
  assert.deepEqual(dual.services, []);
  assert.deepEqual(dual.runtime, JSON.parse(readFileSync(new URL("../catalog/recipes/glivela-dual.runtime.json", import.meta.url))));
  assert.deepEqual(dual.runtime.requiredCapabilities, ["native-services", "root"]);
  const { users, services } = dual.runtime.nativeServices;
  assert.deepEqual(users, ["entry-xray", "landing-xray"]);
  assert.deepEqual(services.map(s => [s.name, s.start]), [["node", "automatic"], ["entry-xray", "manual"], ["landing-xray", "manual"]]);
  const [manager, first, second] = services;
  const v = manager.process.configFiles[0].values;
  assert.equal(v.mode.literal, "node-pair");
  assert.equal(v.entryNode.object.xray.object.role.literal, "entry");
  assert.equal(v.landingNode.object.xray.object.role.literal, "landing");
  assert.notDeepEqual(v.entryNode.object.certificate, v.landingNode.object.certificate);
  assert.notDeepEqual(v.entryNode.object.key, v.landingNode.object.key);
  assert.deepEqual(manager.process.stateDirectories, ["manager-state", "entry-state", "landing-state"]);
  assert.equal(first.managedUser, "entry-xray");
  assert.equal(second.managedUser, "landing-xray");
  assert.equal(first.process.bindService, true);
  assert.equal(second.process.bindService, undefined);
  assert.equal(first.stateCredentials["configuration.json"].storage, "entry-state");
  assert.equal(second.stateCredentials["configuration.json"].storage, "landing-state");
  for (const field of dual.config.filter(f => /pem$/.test(f.key))) assert.equal(field.secret, true);
  const helper = readFileSync(new URL("./prepare-glivela-release.mjs", import.meta.url), "utf8");
  assert.match(helper, /\["meridian", "glivela-entry", "glivela-node", "glivela-dual", "glivela-client-landing"\]/);
});


test("additional client landing owns a separate namespace with the existing verified runtime", () => {
  const c = JSON.parse(readFileSync(new URL("../catalog/catalog.json", import.meta.url)));
  const base = c.apps.find(a => a.id === "glivela-node");
  const extra = c.apps.find(a => a.id === "glivela-client-landing");
  assert.equal(extra.version, base.version);
  assert.deepEqual(extra.artifacts, base.artifacts);
  assert.deepEqual(extra.config, base.config);
  assert.notEqual(extra.runtime.nativeServices.namespace, base.runtime.nativeServices.namespace);
  const expected = structuredClone(base.runtime);
  expected.nativeServices.namespace = "glivela-client";
  assert.deepEqual(extra.runtime, expected);
  assert.deepEqual(extra.runtime, JSON.parse(readFileSync(new URL("../catalog/recipes/glivela-client-landing.runtime.json", import.meta.url))));
  const [manager, worker] = extra.runtime.nativeServices.services;
  assert.equal(manager.start, "automatic");
  assert.equal(worker.start, "manual");
  assert.equal(worker.managedUser, "xray");
  assert.deepEqual(extra.services ?? [], []);
});
