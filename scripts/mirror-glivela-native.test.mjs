import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {sha256} from './release-source.mjs';
import {nativeMirrorURL,senlunNativeMirrorURL,verifyNativeMirror,verifySenlunNativeMirror,uploadNativeMirror} from './mirror-glivela-native.mjs';

test('Glivela native mirror fixes the official origin and authenticates exact bytes',async()=>{
 assert.equal(nativeMirrorURL('0.1.0-alpha.136','amd64'),'https://downloads.petauron.com/vastora/catalog/artifacts/glivela/v0.1.0-alpha.136/glivela-0.1.0-alpha.136-linux-amd64.tar.gz');
 assert.throws(()=>nativeMirrorURL('../escape','amd64'));assert.throws(()=>nativeMirrorURL('0.1.0-alpha.136','../arm64'));
 const bytes=Buffer.from('source-verified');
 const fake=async(url,options)=>{assert.equal(new URL(url).hostname,'downloads.petauron.com');assert.equal(options.redirect,'error');return new Response(bytes);};
 await verifyNativeMirror('0.1.0-alpha.136','amd64',sha256(bytes),bytes.length,fake);
 await assert.rejects(verifyNativeMirror('0.1.0-alpha.136','amd64','0'.repeat(64),bytes.length,fake));
 await assert.rejects(verifyNativeMirror('0.1.0-alpha.136','amd64',sha256(bytes),bytes.length-1,fake));
});
test('Senlun native mirror fixes the official origin, architecture mapping and exact bytes',async()=>{
 assert.equal(senlunNativeMirrorURL('0.2.1','amd64'),'https://downloads.petauron.com/vastora/catalog/artifacts/senlun/v0.2.1/senlun-v0.2.1-linux-x86_64.tar.gz');
 assert.equal(senlunNativeMirrorURL('0.2.1','arm64'),'https://downloads.petauron.com/vastora/catalog/artifacts/senlun/v0.2.1/senlun-v0.2.1-linux-aarch64.tar.gz');
 assert.throws(()=>senlunNativeMirrorURL('../escape','amd64'));assert.throws(()=>senlunNativeMirrorURL('0.2.1','x86_64'));
 assert.throws(()=>senlunNativeMirrorURL('0.2.1','toString'));assert.throws(()=>senlunNativeMirrorURL('0.2.1','__proto__'));
 const bytes=Buffer.from('senlun-verified');
 const fake=async(url,options)=>{assert.equal(new URL(url).hostname,'downloads.petauron.com');assert.equal(options.redirect,'error');return new Response(bytes);};
 await verifySenlunNativeMirror('0.2.1','arm64',sha256(bytes),bytes.length,fake);
 await assert.rejects(verifySenlunNativeMirror('0.2.1','arm64','0'.repeat(64),bytes.length,fake));
 await assert.rejects(verifySenlunNativeMirror('0.2.1','arm64',sha256(bytes),bytes.length-1,fake));
});
test('native mirror never overwrites a published object and rejects changed staging',()=>{
 const directory=mkdtempSync(path.join(tmpdir(),'glivela-mirror-test-'));const objects=new Map();let writes=0;
 try{
  const version='0.1.0-alpha.136',artifacts=['amd64','arm64'].map(architecture=>{
   const name=`glivela-${version}-linux-${architecture}.tar.gz`,raw=Buffer.from('verified-'+architecture);writeFileSync(path.join(directory,name),raw);return {architecture,name,size:raw.length,sha256:sha256(raw)};
  });
  writeFileSync(path.join(directory,'mirror.json'),JSON.stringify({version,commit:'a'.repeat(40),runId:'123',artifacts}));
  const fake=(command,args)=>{
   assert.equal(command,'aws');const key=args[args.indexOf('--key')+1];assert.ok(key.startsWith('vastora/catalog/artifacts/glivela/v0.1.0-alpha.136/'));
   if(args.includes('put-object')){assert.equal(args[args.indexOf('--if-none-match')+1],'*');writes++;if(objects.has(key))throw Error('condition failed');objects.set(key,Buffer.from('verified-'+(key.includes('amd64')?'amd64':'arm64')));}
   else if(args.includes('get-object')){const index=args.indexOf('--key');writeFileSync(args[index+2],objects.get(key));}
   else throw Error('Unexpected command');return Buffer.from('{}');
  };
  const options={directory,bucket:'existing-bucket',endpoint:'https://abc.r2.cloudflarestorage.com'};
  uploadNativeMirror(options,fake);assert.equal(objects.size,2);uploadNativeMirror(options,fake);assert.equal(objects.size,2);
  const key=[...objects.keys()][0];objects.set(key,Buffer.from('foreign'));assert.throws(()=>uploadNativeMirror(options,fake),/conflict/);
  writeFileSync(path.join(directory,artifacts[0].name),'changed');const before=writes;assert.throws(()=>uploadNativeMirror(options,fake),/changed/);assert.equal(writes,before);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
test('Senlun native mirror uploads immutable objects under senlun prefix and enforces expected product',()=>{
 const directory=mkdtempSync(path.join(tmpdir(),'senlun-mirror-test-'));const objects=new Map();
 try{
  const version='0.2.1',archNames={amd64:'x86_64',arm64:'aarch64'};
  const artifacts=['amd64','arm64'].map(architecture=>{
   const name=`senlun-v${version}-linux-${archNames[architecture]}.tar.gz`,raw=Buffer.from('verified-senlun-'+architecture);
   writeFileSync(path.join(directory,name),raw);return {architecture,name,size:raw.length,sha256:sha256(raw)};
  });
  writeFileSync(path.join(directory,'mirror.json'),JSON.stringify({product:'senlun',version,commit:'b'.repeat(40),runId:'456',artifacts}));
  const fake=(command,args)=>{
   assert.equal(command,'aws');const key=args[args.indexOf('--key')+1];assert.ok(key.startsWith('vastora/catalog/artifacts/senlun/v0.2.1/'));
   if(args.includes('put-object')){assert.equal(args[args.indexOf('--if-none-match')+1],'*');if(objects.has(key))throw Error('condition failed');objects.set(key,Buffer.from('verified-senlun-'+(key.includes('x86_64')?'amd64':'arm64')));}
   else if(args.includes('get-object')){const index=args.indexOf('--key');writeFileSync(args[index+2],objects.get(key));}
   else throw Error('Unexpected command');return Buffer.from('{}');
  };
  const options={directory,bucket:'existing-bucket',endpoint:'https://abc.r2.cloudflarestorage.com',expectedProduct:'senlun'};
  assert.equal(uploadNativeMirror(options,fake).product,'senlun');assert.equal(objects.size,2);
  assert.throws(()=>uploadNativeMirror({...options,expectedProduct:'glivela'},fake),/product/);
  uploadNativeMirror(options,fake);assert.equal(objects.size,2);
  const key=[...objects.keys()][0];objects.set(key,Buffer.from('foreign'));assert.throws(()=>uploadNativeMirror(options,fake),/conflict/);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
