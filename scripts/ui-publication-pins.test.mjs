import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('Glivela alpha.39 publication builds solely from its reviewed application source', () => {
  const workflow=readFileSync(new URL('../.github/workflows/publish.yml',import.meta.url),'utf8');
  const catalog=JSON.parse(readFileSync(new URL('../catalog/catalog.json',import.meta.url),'utf8'));
  assert.equal(catalog.apps.find(app=>app.id==='meridian').version,'0.1.0-alpha.39');
  assert.doesNotMatch(workflow,/VASTORA_WEB_SOURCE|ui-dependency|repository: petauron\/vastora/);
  assert.match(workflow,/ref: 47d999198d4decbfb4e96fc7806d6119b111f2e9/);
  assert.ok(workflow.includes('ui-glivela-$version.js'));
  assert.ok(workflow.includes('ui-glivela-$version.css'));
});
