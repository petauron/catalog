#!/usr/bin/env node
// Copy only already verified Glivela or Senlun native distributions. Never sign
// a catalog, create a release/tag, execute a distribution or contact an installed node.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,lstatSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const versionPattern=/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:alpha|beta|rc)\.(0|[1-9][0-9]*))?$/;
const senlunArchMap={amd64:'x86_64',arm64:'aarch64'};
const stagingProducts={'glivela-native-mirror':'glivela','senlun-native-mirror':'senlun'};

export function nativeMirrorURL(version, architecture) {
 if (!versionPattern.test(version) || !['amd64','arm64'].includes(architecture)) throw Error('Invalid Glivela distribution identity');
 return `https://downloads.petauron.com/vastora/catalog/artifacts/glivela/v${version}/glivela-${version}-linux-${architecture}.tar.gz`;
}
export function senlunNativeMirrorURL(version, architecture) {
 const archiveArch=senlunArchMap[architecture];
 if (!versionPattern.test(version) || !archiveArch) throw Error('Invalid Senlun distribution identity');
 return `https://downloads.petauron.com/vastora/catalog/artifacts/senlun/v${version}/senlun-v${version}-linux-${archiveArch}.tar.gz`;
}
async function verifyMirrorURL(url, digest, size, fetcher=fetch, label='Official native mirror') {
 if(!/^[a-f0-9]{64}$/.test(digest??'')||!Number.isSafeInteger(size)||size<=0||size>128*1024*1024)throw Error('Invalid native mirror inventory');
 const response=await fetcher(url,{redirect:'error',signal:AbortSignal.timeout(120000)});
 if (!response.ok || !response.body || Number(response.headers.get('content-length')??0)>128*1024*1024) throw Error(`${label} is not available`);
 const chunks=[];let count=0;
 for await(const chunk of response.body){count+=chunk.length;if(count>size)throw Error(`${label} size differs`);chunks.push(chunk);}
 if(count!==size||sha256(Buffer.concat(chunks))!==digest)throw Error(`${label} digest differs`);
}
export async function verifyNativeMirror(version, architecture, digest, size, fetcher=fetch) {
 return verifyMirrorURL(nativeMirrorURL(version,architecture),digest,size,fetcher,'Official Glivela mirror');
}
export async function verifySenlunNativeMirror(version, architecture, digest, size, fetcher=fetch) {
 return verifyMirrorURL(senlunNativeMirrorURL(version,architecture),digest,size,fetcher,'Official Senlun mirror');
}
export function uploadNativeMirror({directory,bucket,endpoint,expectedProduct},run=execFileSync){
 if(!directory||!lstatSync(directory).isDirectory()||lstatSync(directory).isSymbolicLink()||!/^[a-z0-9][a-z0-9.-]+$/.test(bucket??'')||!/^https:\/\/[a-z0-9]+\.r2\.cloudflarestorage\.com$/.test(endpoint??''))throw Error('Invalid native mirror destination');
 const planFile=path.join(directory,'mirror.json');if(lstatSync(planFile).isSymbolicLink()||lstatSync(planFile).size>8192)throw Error('Invalid mirror plan');
 const plan=JSON.parse(readFileSync(planFile));
 const product=plan.product??'glivela';
 if(!['glivela','senlun'].includes(product)||(expectedProduct&&product!==expectedProduct))throw Error('Invalid native mirror product');
 if(!/^[a-f0-9]{40}$/.test(plan.commit??'')||!/^[1-9][0-9]*$/.test(plan.runId??'')||!Array.isArray(plan.artifacts)||plan.artifacts.length!==2||plan.artifacts.map(x=>x.architecture).sort().join(',')!=='amd64,arm64')throw Error('Invalid verified mirror inventory');
 const urlFor=product==='senlun'?senlunNativeMirrorURL:nativeMirrorURL;
 const files=plan.artifacts.map(item=>{
  const url=urlFor(plan.version,item.architecture),name=url.split('/').at(-1),local=path.join(directory,name),stat=lstatSync(local);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size<=0||stat.size>128*1024*1024)throw Error('Invalid native staging file');
  const raw=readFileSync(local);
  if(raw.length<=0||raw.length>128*1024*1024||item.name!==name||item.size!==raw.length||!/^[a-f0-9]{64}$/.test(item.sha256??'')||sha256(raw)!==item.sha256)throw Error('Verified native staging changed');
  return {...item,url,local,key:`vastora/catalog/artifacts/${product}/v${plan.version}/${name}`,raw};
 });
 const temporary=mkdtempSync(path.join(tmpdir(),`${product}-native-mirror-`));
 const aws=(...args)=>run('aws',['--cli-connect-timeout','10','--cli-read-timeout','60','s3api',...args,'--bucket',bucket,'--endpoint-url',endpoint,'--no-cli-pager'],{stdio:['ignore','pipe','pipe']});
 try{
  for(const item of files){
   try{aws('put-object','--key',item.key,'--body',item.local,'--if-none-match','*','--content-type','application/gzip','--cache-control','public,max-age=31536000,immutable');}
   catch{const existing=path.join(temporary,'existing');aws('get-object','--key',item.key,existing);if(!readFileSync(existing).equals(item.raw))throw Error('Immutable native object conflicts');}
   const verified=path.join(temporary,'verified');aws('get-object','--key',item.key,verified);if(!readFileSync(verified).equals(item.raw))throw Error('Native upload readback differs');
  }
 }finally{rmSync(temporary,{recursive:true,force:true});}
 return {...plan,product};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
 try{
  const [directory,...extra]=process.argv.slice(2);
  const expectedProduct=stagingProducts[path.basename(directory??'')];
  if(extra.length||path.dirname(directory??'')!==process.env.RUNNER_TEMP||!expectedProduct)throw Error('Invalid mirror staging');
  const plan=uploadNativeMirror({directory,bucket:process.env.R2_BUCKET_NAME,endpoint:process.env.R2_ENDPOINT,expectedProduct});
  const verify=plan.product==='senlun'?verifySenlunNativeMirror:verifyNativeMirror;
  for(const item of plan.artifacts)await verify(plan.version,item.architecture,item.sha256,item.size);
  console.log(`Verified official ${plan.product} ${plan.version} native delivery from ${plan.commit}; both immutable objects match source inventory.`);
 }catch{console.error('Native mirror not confirmed; keep original source/version and retry, never overwrite.');process.exitCode=1;}
}
