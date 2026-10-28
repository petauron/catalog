import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('Glivela alpha.78 publication builds solely from its reviewed application source', () => {
  const workflow=readFileSync(new URL('../.github/workflows/publish.yml',import.meta.url),'utf8');
  const catalog=JSON.parse(readFileSync(new URL('../catalog/catalog.json',import.meta.url),'utf8'));
  assert.equal(catalog.apps.find(app=>app.id==='meridian').version,'0.1.0-alpha.78');
  const controller=catalog.apps.find(app=>app.id==='meridian');
  assert.equal(controller.packageRevision,5);
  assert.deepEqual(controller.services.find(service=>service.name==='controller'),{name:'controller',protocol:'https',containerPort:9443,defaultHostPort:19443,management:true});
  assert.doesNotMatch(workflow,/VASTORA_WEB_SOURCE|ui-dependency|repository: petauron\/vastora/);
  assert.match(workflow,/ref: 658bc55d657802181ad07a418db0157cae9de4c9/);
  assert.ok(workflow.includes('ui-glivela-$version.js'));
  assert.ok(workflow.includes('ui-glivela-$version.css'));
});
