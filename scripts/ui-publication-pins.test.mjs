import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('Glivela 0.1.1 publication builds solely from its reviewed application source', () => {
  const workflow=readFileSync(new URL('../.github/workflows/publish.yml',import.meta.url),'utf8');
  const catalog=JSON.parse(readFileSync(new URL('../catalog/catalog.json',import.meta.url),'utf8'));
  assert.equal(catalog.apps.find(app=>app.id==='meridian').version,'0.1.1');
  const controller=catalog.apps.find(app=>app.id==='meridian');
  assert.equal(controller.packageRevision,5);
  assert.deepEqual(controller.services.find(service=>service.name==='controller'),{name:'controller',protocol:'https',containerPort:9443,defaultHostPort:19443,management:true});
  assert.doesNotMatch(workflow,/VASTORA_WEB_SOURCE|ui-dependency|repository: petauron\/vastora/);
  assert.ok(workflow.includes('repository: petauron/glivela\n          ref: ${{ steps.prepare.outputs.glivela_ui_ref }}'));
  assert.ok(workflow.includes('test "$(git -C meridian-ui rev-parse HEAD)" = "$GLIVELA_UI_REF"'));
  assert.ok(workflow.includes('GLIVELA_UI_JS_SHA256'));
  assert.ok(workflow.includes('GLIVELA_UI_CSS_SHA256'));
  assert.ok(workflow.includes('ui-glivela-$version.js'));
  assert.ok(workflow.includes('ui-glivela-$version.css'));
});
