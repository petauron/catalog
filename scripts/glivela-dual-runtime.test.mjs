import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("single-role profiles reserve an isolated dormant companion without changing the bootstrap", () => {
  const c = JSON.parse(readFileSync(new URL("../catalog/catalog.json", import.meta.url)));
  for (const id of ["glivela-entry", "glivela-node"]) {
    const app = c.apps.find(a => a.id === id);
    assert.deepEqual(app.runtime, JSON.parse(readFileSync(new URL(`../catalog/recipes/${id}.runtime.json`, import.meta.url))));
    const { users, services } = app.runtime.nativeServices;
    assert.deepEqual(users, ["xray", "companion-xray"]);
    assert.deepEqual(services.map(s => [s.name, s.start]), [["node", "automatic"], ["xray", "manual"], ["companion-xray", "manual"]]);
    const [manager, original, companion] = services;
    const values = manager.process.configFiles[0].values;
    assert.equal(values.mode.literal, "node");
    assert.equal(values.xray.object.service.literal, "xray");
    assert.equal(values.xray.object.role.literal, id === "glivela-entry" ? "entry" : "landing");
    assert.equal(values.directory.runtime.name, "node-state");
    assert.equal(values.certificate.runtime.name, "certificate");
    assert.equal(values.key.runtime.name, "key");
    assert.equal(original.managedUser, "xray");
    assert.equal(original.stateCredentials["configuration.json"].storage, "node-state");
    assert.equal(companion.stateCredentials["configuration.json"].storage, "companion-state");
    assert.equal(companion.managedUser, "companion-xray");
    assert.equal(companion.process.bindService, id === "glivela-node" ? true : undefined);
    assert.deepEqual(manager.process.stateDirectories, ["node-state", "pair-manager-state", "companion-state"]);
    assert.deepEqual((app.services ?? []).map(service => service.name), id === "glivela-entry" ? ["proxy"] : []);
  }
});

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
  assert.match(helper, /\["meridian", "glivela-entry", "glivela-node", "glivela-dual"\]/);
});
