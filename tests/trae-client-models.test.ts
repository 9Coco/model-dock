import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { canUseTraeClientModel, parseTraeClientModelCatalog, readTraeClientModelCatalog } from '../src/main/trae-client-models';
import { requireSymlinkCapability } from './helpers/windows-review-filesystem';
const account='synthetic-account', directories:string[]=[];
afterEach(async()=>{await Promise.all(directories.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
const row=(name='current-model',extra:Record<string,unknown>={})=>({name,display_name:'Current model',config_source:1,status:true,selectable:true,...extra});
async function fixture(entries:Record<string,string>,product='Trae CN',base?:string){
 const root=base??await mkdtemp(join(tmpdir(),'modeldock-trae-models-'));if(!base)directories.push(root);
 const file=join(root,product,'User','globalStorage','state.vscdb');await mkdir(join(file,'..'),{recursive:true});const db=new DatabaseSync(file);db.exec('CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value TEXT)');for(const [key,value]of Object.entries(entries))db.prepare('INSERT INTO ItemTable VALUES(?,?)').run(key,value);db.close();return{root,file,options:{platform:'linux' as const,homeDir:root,env:{XDG_CONFIG_HOME:root}}};
}
describe('TRAE native current model cache, read-only account boundary',()=>{
 it('keeps gated and ordinary built-ins visible, preserves native route names and uses the calling account identity', () => {
  const models = parseTraeClientModelCatalog(JSON.stringify({ chat_v3: [
   row('regular', { features: { access: { data: { identity_list: [0, 1] } } } }),
   row('paid', { config_name: 'paid-route', features: { access: { enable: true, data: { identity_list: [5, 1, 2, 100] } } } }),
   row('free-allowed', { features: { access: { enable: true, data: { identity_list: [0, 5] } } } }),
  ] }))!;
  expect(models.map(model => model.id)).toEqual(['regular', 'paid', 'free-allowed']);
  expect(models[1]).toMatchObject({ id: 'paid', configName: 'paid-route', allowedIdentities: [1, 2, 5, 100] });
  expect(models.map(model => canUseTraeClientModel(model, 0))).toEqual([true, false, true]);
  expect(models.map(model => canUseTraeClientModel(model, 5))).toEqual([true, true, true]);
  expect(models.map(model => canUseTraeClientModel(model, undefined))).toEqual([true, false, false]);
 });
 it('uses the enabled native feature route for early access, download, and identity restrictions independently', () => {
  const features = [
   { early_access: { enable: true, data: { enable_early_access: false } } },
   { early_access: { data: { enable_early_access: false } } },
   { early_access: { enable: true, data: { enable_early_access: true } } },
   { access: { enable: true, subKey: 'download_work' } },
   { access: { enable: true, data: { identity_list: [] } } },
   { access: { enable: true, data: { identity_list: ['5'] } } },
  ];
  const models = parseTraeClientModelCatalog(JSON.stringify({ chat_v3: features.map((features, i) => row('m' + i, { features })) }))!;
  expect(models.map(model => canUseTraeClientModel(model, 5))).toEqual([false, true, true, false, true, false]);
 });
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
 it('keeps explicitly excluded subscription IDs and routes separate from BYOK and the visible picker', async () => {
  const rows = [
   row('visible'), row('disabled-picker', { status: false, config_name: 'disabled-route' }),
   row('unselectable-picker', { selectable: false, config_name: 'disabled-route' }),
   row('offline', { provider_offline_status: 'hard' }),
   row('private-byok', { config_source: 3, status: false, config_name: 'visible' }),
  ];
  const key = account + '_AI.agent.model.model_list_map';
  const f = await fixture({ [key]: JSON.stringify({ chat_v3: rows }) });
  expect(await readTraeClientModelCatalog(account, f.options)).toEqual({
   client: 'trae-cn', models: [{ id: 'visible', name: 'Current model' }],
   excludedConfigIds: ['disabled-picker', 'disabled-route', 'offline', 'unselectable-picker'],
  });
  await fixture({ [key]: JSON.stringify({ chat_v3: [row('visible')] }) }, 'TRAE SOLO CN', f.root);
  expect(await readTraeClientModelCatalog(account, f.options)).toBeUndefined();
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
 it('keeps source boundaries when products share names but disagree on model access', async () => {
  const key = account + '_AI.agent.model.model_list_map';
  const cn = await fixture({ [key]: JSON.stringify({ chat_v3: [row()] }) });
  const access = { enable: true, data: { identity_list: [5] } };
  await fixture({ [key]: JSON.stringify({ chat_v3: [row('current-model', { features: { access } })] }) }, 'TRAE SOLO CN', cn.root);
  expect(await readTraeClientModelCatalog(account, cn.options)).toBeUndefined();
  const solo = await readTraeClientModelCatalog(account, { ...cn.options, client: 'trae-solo-cn' });
  expect(canUseTraeClientModel(solo!.models[0], 0)).toBe(false);
 });
 it('never falls back to another product when the exact imported client has no cache',async()=>{
  const f=await fixture({[account+'_AI.agent.model.model_list_map']:JSON.stringify({chat_v3:[row('cn-only-model')]})});
  expect(await readTraeClientModelCatalog(account,{...f.options,client:'trae-solo-cn'})).toBeUndefined();
 });
 it.each(['Trae CN', 'TRAE SOLO CN'])('reads the selected Windows %s cache from APPDATA, including Unicode and spaces',async product=>{
  const home=await mkdtemp(join(tmpdir(),'modeldock-trae-windows-'));directories.push(home);
  const base=join(home,'用户 漫游配置');
  const f=await fixture({[account+'_AI.agent.model.model_list_map']:JSON.stringify({chat_v3:[row('windows-model')]})},product,base);
  const other=await fixture({[account+'_AI.agent.model.model_list_map']:JSON.stringify({chat_v3:[row('linux-decoy')]})},product,join(home,'.config'));
  const client=product==='Trae CN'?'trae-cn' as const:'trae-solo-cn' as const;
  const before=await readFile(f.file);
  expect(await readTraeClientModelCatalog(account,{platform:'win32',homeDir:home,env:{APPDATA:base,XDG_CONFIG_HOME:other.root},client})).toEqual({client,models:[{id:'windows-model',name:'Current model'}]});
  expect(await readFile(f.file)).toEqual(before);
  expect(await readTraeClientModelCatalog(account,{platform:'win32',homeDir:home,env:{APPDATA:base},client:client==='trae-cn'?'trae-solo-cn':'trae-cn'})).toBeUndefined();
 });
 it('uses the Windows roaming fallback only when APPDATA is absent, without falling back from an invalid override',async()=>{
  const home=await mkdtemp(join(tmpdir(),'modeldock-trae-windows-'));directories.push(home);
  await fixture({[account+':AI.agent.model.model_list_map']:JSON.stringify({chat_v3:[row('roaming-model')]})},'Trae CN',join(home,'AppData','Roaming'));
  const options={platform:'win32' as const,homeDir:home,client:'trae-cn' as const};
  expect((await readTraeClientModelCatalog(account,{...options,env:{}}))?.models[0].id).toBe('roaming-model');
  expect(await readTraeClientModelCatalog(account,{...options,env:{APPDATA:'relative'}})).toBeUndefined();
  expect(await readTraeClientModelCatalog(account,{...options,env:{APPDATA:join(home,'missing')}})).toBeUndefined();
 });
 it('rejects nonabsolute configuration roots independently of symlink privileges',async()=>{
  const f=await fixture({[account+'_AI.agent.model.model_list_map']:JSON.stringify({chat_v3:[row()]})});
  expect(await readTraeClientModelCatalog(account,{...f.options,env:{XDG_CONFIG_HOME:'relative'}})).toBeUndefined();
 });
 it('rejects symbolic-link model databases',async context=>{
  requireSymlinkCapability(context,'file');
  const f=await fixture({[account+'_AI.agent.model.model_list_map']:JSON.stringify({chat_v3:[row()]})});const target=f.file+'.saved';await import('node:fs/promises').then(fs=>fs.rename(f.file,target));await symlink(target,f.file);
  expect(await readTraeClientModelCatalog(account,f.options)).toBeUndefined();
 });
});
