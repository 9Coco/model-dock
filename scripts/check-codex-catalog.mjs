import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
mkdirSync('work',{recursive:true});
const adapterModule=resolve('work/native-adapters-check.mjs');
await build({entryPoints:['src/main/adapters.ts'],bundle:true,packages:'external',platform:'node',format:'esm',target:'node24',outfile:adapterModule});
const { applyConfig }=await import(pathToFileURL(adapterModule).href);
const executable = process.argv[2];
if (!executable) throw new Error('Pass the path to an installed codex executable.');
const root = mkdtempSync(join(tmpdir(),'modeldock-codex-'));
const model = {id:'test-model',providerId:'test-provider',alias:'dock-native-test',upstreamId:'upstream-test',displayName:'ModelDock Native Test',wireApi:'responses',contextWindow:64000,tools:true,vision:false,enabled:true};
const store = {listModels:()=>[model],listBindings:()=>[{id:'codex',name:'Codex',enabled:true,modelIds:[model.id],defaultModelId:model.id,note:''}],gatewayKey:()=> 'synthetic-only'};
applyConfig(store,'codex',18181,root,join(root,'backups'),root);
const child = spawn(executable,['app-server'],{env:{...process.env,CODEX_HOME:join(root,'.codex')},windowsHide:true,stdio:'pipe'});
let stdout='',stderr='',pending=''; const messages=[];
const finish = (ok, message) => {
  clearTimeout(deadline); child.kill();
  mkdirSync('work',{recursive:true});
  const modelReply=messages.find(value=>value.id===2);
  const rows=modelReply?.result?.data ?? modelReply?.result?.models ?? [];
  writeFileSync('work/codex-catalog-validation.json',JSON.stringify({ok,message,fixtureDir:root,models:rows.map(m=>({id:m.id,model:m.model,name:m.displayName}))},null,2));
  console.log(JSON.stringify({ok,message,fixtureDir:root})); process.exitCode=ok?0:1;
};
const deadline=setTimeout(()=>finish(false,'Codex model/list timed out'),20000);
child.stdout.on('data',chunk=>{
  stdout+=chunk; pending+=chunk;
  for (;;) {
    const end=pending.indexOf('\n'); if(end<0)break;
    const line=pending.slice(0,end);pending=pending.slice(end+1);
    try {
      const value=JSON.parse(line);messages.push(value);
      if(value.id===1){
        if(value.error){finish(false,'initialize failed');return;}
        child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
        child.stdin.write(JSON.stringify({id:2,method:'model/list',params:{}})+'\n');
      }
      if(value.id===2){
        const rows=value.result?.data ?? value.result?.models ?? [];
        finish(!value.error && rows.some(m=>m.model==='dock-native-test'||m.id==='dock-native-test'),value.error?'Catalog rejected':'Native Codex parsed ModelDock catalog');return;
      }
    }catch{}
  }
});
child.stderr.on('data',chunk=>{stderr+=chunk;});
child.on('error',error=>finish(false,String(error)));
child.stdin.write(JSON.stringify({id:1,method:'initialize',params:{clientInfo:{name:'modeldock-local-test',version:'0.1.0'}}})+'\n');
