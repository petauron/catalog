import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('Glivela alpha.45 publication builds solely from its reviewed application source', () => {
  const workflow=readFileSync(new URL('../.github/workflows/publish.yml',import.meta.url),'utf8');
  const catalog=JSON.parse(readFileSync(new URL('../catalog/catalog.json',import.meta.url),'utf8'));
  assert.equal(catalog.apps.find(app=>app.id==='meridian').version,'0.1.0-alpha.45');
  assert.doesNotMatch(workflow,/VASTORA_WEB_SOURCE|ui-dependency|repository: petauron\/vastora/);
  assert.match(workflow,/ref: 18b8f09e45885acc26f8e642d29e362bac058c97/);
  assert.ok(workflow.includes('ui-glivela-$version.js'));
  assert.ok(workflow.includes('ui-glivela-$version.css'));
});
