#!/usr/bin/env node
// Copy only already verified Glivela distributions. Never sign a catalog,
// create a release/tag, execute a distribution or contact an installed node.
import {execFileSync} from 'node:child_process';
import {readFileSync,lstatSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {sha256} from './release-source.mjs';

export function nativeMirrorURL(version, architecture) {
 if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:alpha|beta|rc)\.(0|[1-9][0-9]*))?$/.test(version) || !['amd64','arm64'].includes(architecture)) throw Error('Invalid Glivela distribution identity');
 return `https://downloads.petauron.com/vastora/catalog/artifacts/glivela/v${version}/glivela-${version}-linux-${architecture}.tar.gz`;
}
export async function verifyNativeMirror(version, architecture, digest, size, fetcher=fetch) {
 if(!/^[a-f0-9]{64}$/.test(digest??'')||!Number.isSafeInteger(size)||size<=0||size>128*1024*1024)throw Error('Invalid native mirror inventory');
 const response=await fetcher(nativeMirrorURL(version,architecture),{redirect:'error',signal:AbortSignal.timeout(120000)});
 if (!response.ok || !response.body || Number(response.headers.get('content-length')??0)>128*1024*1024) throw Error('Official Glivela mirror is not available');
 const chunks=[];let count=0;
 for await(const chunk of response.body){count+=chunk.length;if(count>size)throw Error('Official Glivela mirror size differs');chunks.push(chunk);}
 if(count!==size||sha256(Buffer.concat(chunks))!==digest)throw Error('Official Glivela mirror digest differs');
}
export function uploadNativeMirror({directory,bucket,endpoint},run=execFileSync){
 if(!directory||!lstatSync(directory).isDirectory()||lstatSync(directory).isSymbolicLink()||!/^[a-z0-9][a-z0-9.-]+$/.test(bucket??'')||!/^https:\/\/[a-z0-9]+\.r2\.cloudflarestorage\.com$/.test(endpoint??''))throw Error('Invalid native mirror destination');
 const planFile=path.join(directory,'mirror.json');if(lstatSync(planFile).isSymbolicLink()||lstatSync(planFile).size>8192)throw Error('Invalid mirror plan');
 const plan=JSON.parse(readFileSync(planFile));
 if(!/^[a-f0-9]{40}$/.test(plan.commit??'')||!/^[1-9][0-9]*$/.test(plan.runId??'')||!Array.isArray(plan.artifacts)||plan.artifacts.length!==2||plan.artifacts.map(x=>x.architecture).sort().join(',')!=='amd64,arm64')throw Error('Invalid verified mirror inventory');
 const files=plan.artifacts.map(item=>{
  const url=nativeMirrorURL(plan.version,item.architecture),name=url.split('/').at(-1),local=path.join(directory,name),stat=lstatSync(local);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size<=0||stat.size>128*1024*1024)throw Error('Invalid native staging file');
  const raw=readFileSync(local);
  if(raw.length<=0||raw.length>128*1024*1024||item.name!==name||item.size!==raw.length||!/^[a-f0-9]{64}$/.test(item.sha256??'')||sha256(raw)!==item.sha256)throw Error('Verified native staging changed');
  return {...item,url,local,key:`vastora/catalog/artifacts/glivela/v${plan.version}/${name}`,raw};
 });
 const temporary=mkdtempSync(path.join(tmpdir(),'glivela-native-mirror-'));
 const aws=(...args)=>run('aws',['--cli-connect-timeout','10','--cli-read-timeout','60','s3api',...args,'--bucket',bucket,'--endpoint-url',endpoint,'--no-cli-pager'],{stdio:['ignore','pipe','pipe']});
 try{
  for(const item of files){
   try{aws('put-object','--key',item.key,'--body',item.local,'--if-none-match','*','--content-type','application/gzip','--cache-control','public,max-age=31536000,immutable');}
   catch{const existing=path.join(temporary,'existing');aws('get-object','--key',item.key,existing);if(!readFileSync(existing).equals(item.raw))throw Error('Immutable native object conflicts');}
   const verified=path.join(temporary,'verified');aws('get-object','--key',item.key,verified);if(!readFileSync(verified).equals(item.raw))throw Error('Native upload readback differs');
  }
 }finally{rmSync(temporary,{recursive:true,force:true});}
 return plan;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
 try{
  const [directory,...extra]=process.argv.slice(2);if(extra.length||path.dirname(directory??'')!==process.env.RUNNER_TEMP||path.basename(directory)!=='glivela-native-mirror')throw Error('Invalid mirror staging');
  const plan=uploadNativeMirror({directory,bucket:process.env.R2_BUCKET_NAME,endpoint:process.env.R2_ENDPOINT});
  for(const item of plan.artifacts)await verifyNativeMirror(plan.version,item.architecture,item.sha256,item.size);
  console.log(`Verified official Glivela ${plan.version} native delivery from ${plan.commit}; both immutable objects match source inventory.`);
 }catch{console.error('Glivela native mirror not confirmed; keep original source/version and retry, never overwrite.');process.exitCode=1;}
}
