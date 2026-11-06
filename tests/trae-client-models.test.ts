import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { parseTraeClientModelCatalog, readTraeClientModelCatalog } from '../src/main/trae-client-models';
const account='synthetic-account', directories:string[]=[];
afterEach(async()=>{await Promise.all(directories.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
const row=(name='current-model',extra:Record<string,unknown>={})=>({name,display_name:'Current model',config_source:1,status:true,selectable:true,...extra});
async function fixture(entries:Record<string,string>,product='Trae CN',base?:string){
 const root=base??await mkdtemp(join(tmpdir(),'modeldock-trae-models-'));if(!base)directories.push(root);
 const file=join(root,product,'User','globalStorage','state.vscdb');await mkdir(join(file,'..'),{recursive:true});const db=new DatabaseSync(file);db.exec('CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value TEXT)');for(const [key,value]of Object.entries(entries))db.prepare('INSERT INTO ItemTable VALUES(?,?)').run(key,value);db.close();return{root,file,options:{platform:'linux' as const,homeDir:root,env:{XDG_CONFIG_HOME:root}}};
}
describe('TRAE native current model cache, read-only account boundary',()=>{
 it('uses exact native visibility and selection rules without deciding age from model names',()=>{
  const values=[row('old-looking-1'),row('new-looking-99',{status:false}),row('hard-offline',{provider_offline_status:'hard'}),row('not-selectable',{selectable:false}),row('soft-route',{provider_offline_status:'soft'}),row('private-byok',{config_source:3,ak:'PRIVATE_KEY',sk:'PRIVATE_SECRET',base_url:'https://private.invalid'})];
  expect(parseTraeClientModelCatalog(JSON.stringify({chat_v3:values}))).toEqual([{id:'old-looking-1',name:'Current model'},{id:'soft-route',name:'Current model'}]);
 });
 it.each([{}, {chat_v3:[row(),row()]},{chat_v3:[row('fixture',{status:'false'})]},{chat_v3:[row('fixture',{selectable:0})]},{chat_v3:[row('fixture',{provider_offline_status:'unknown-state'})]}])('does not assert a current catalog for unrecognized native data',data=>{expect(parseTraeClientModelCatalog(JSON.stringify(data))).toBeUndefined();});
 it('reads only the imported account and exact chat_v3 snapshot, without returning raw settings or changing the database',async()=>{
  const f=await fixture({[account+'_AI.agent.model.model_list_map']:JSON.stringify({chat_v3:[row()],solo_agent:[row('other-function')]}),'foreign-account_AI.agent.model.model_list_map':JSON.stringify({chat_v3:[row('foreign-model')]})});
  const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex'),before=digest(await readFile(f.file));
  expect(await readTraeClientModelCatalog(account,f.options)).toEqual({client:'trae-cn',models:[{id:'current-model',name:'Current model'}]});expect(digest(await readFile(f.file))).toBe(before);expect(await readTraeClientModelCatalog('missing-account',f.options)).toBeUndefined();
 });
 it('accepts the two official account key separators but never substitutes another function or account',async()=>{
  const f=await fixture({[account+':AI.agent.model.model_list_map']:JSON.stringify({solo_agent:[row('solo-only')]}),[account+'_AI.agent.model.model_list_map']:JSON.stringify({chat_v3:[row('native-chat')]})});
  expect((await readTraeClientModelCatalog(account,f.options))?.models[0].id).toBe('native-chat');
 });
 it('refuses ambiguous CN and SOLO account catalogs',async()=>{
  const f=await fixture({[account+'_AI.agent.model.model_list_map']:JSON.stringify({chat_v3:[row('cn-model')]})});await fixture({[account+'_AI.agent.model.model_list_map']:JSON.stringify({chat_v3:[row('different-solo-model')]})},'TRAE SOLO CN',f.root);
  expect(await readTraeClientModelCatalog(account,f.options)).toBeUndefined();
  expect((await readTraeClientModelCatalog(account,{...f.options,client:'trae-cn'}))?.models[0].id).toBe('cn-model');
  expect((await readTraeClientModelCatalog(account,{...f.options,client:'trae-solo-cn'}))?.models[0].id).toBe('different-solo-model');
 });
 it('never falls back to another product when the exact imported client has no cache',async()=>{
  const f=await fixture({[account+'_AI.agent.model.model_list_map']:JSON.stringify({chat_v3:[row('cn-only-model')]})});
  expect(await readTraeClientModelCatalog(account,{...f.options,client:'trae-solo-cn'})).toBeUndefined();
 });
 it('rejects symbolic-link model databases and nonabsolute configuration roots',async()=>{
  const f=await fixture({[account+'_AI.agent.model.model_list_map']:JSON.stringify({chat_v3:[row()]})});const target=f.file+'.saved';await import('node:fs/promises').then(fs=>fs.rename(f.file,target));await symlink(target,f.file);
  expect(await readTraeClientModelCatalog(account,f.options)).toBeUndefined();expect(await readTraeClientModelCatalog(account,{...f.options,env:{XDG_CONFIG_HOME:'relative'}})).toBeUndefined();
 });
});
