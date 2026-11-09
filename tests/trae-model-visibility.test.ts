import { describe, expect, it, vi } from 'vitest';
import { TraeApi } from '../src/main/trae-api';
import type { TraeClientCredentials } from '../src/main/trae-client-import';
import { parseTraeClientModelCatalog, type TraeClientModelCatalog } from '../src/main/trae-client-models';
const credentials:TraeClientCredentials={host:'https://api.trae.cn',userId:'SYNTHETIC_ACCOUNT',token:'SYNTHETIC_TOKEN'};
const row=(id:string,extra:Record<string,unknown>={})=>({config_name:id,usage:'chat_completion',config_source:1,model_detail_list:[{model_name:'verified-'+id}],...extra});
const current:TraeClientModelCatalog={client:'trae-cn',models:[{id:'route-current',name:'Current exact client name'},{id:'new-client-model',name:'New client model'}]};
const request={model:'route-history',messages:[{role:'user',content:'Synthetic mock'}]};
const nativeStream=()=>new Response('event: text_delta\ndata: {"text":"Mock response"}\n\nevent: done\ndata: {}\n\n',{headers:{'content-type':'text/event-stream'}});
const batch=(rows:unknown[])=>({function_configs:[{function:'chat_v3',config_info_list:rows}]});
const fetcher=(rows:unknown[])=>vi.fn(async(url:string|URL|Request)=>String(url).includes('batch_get_detail_param')?Response.json(batch(rows)):nativeStream()) as unknown as typeof fetch;
describe('TRAE client picker visibility and independent verified routes',()=>{
 it('shows the complete account-scoped client snapshot without inventing routes for newly visible models',async()=>{
  const clientModels=vi.fn(async()=>current),fetch=fetcher([row('route-history'),row('route-current',{is_invisible_to_user:true}),row('private-byok',{config_source:3})]);
  const api=new TraeApi({fetch,clientModels}),result=await api.models(credentials);
  expect(clientModels).toHaveBeenCalledWith(credentials.userId, undefined);
  expect(result.modeldock_history).toMatchObject({source:'trae-client',currentVerified:true});expect(result.modeldock_history.message).toContain('1 项尚无');
  expect(result.data).toEqual([
   {id:'route-current',object:'model',owned_by:'trae',name:'Current exact client name',modeldock_catalog_visibility:'current'},
   {id:'new-client-model',object:'model',owned_by:'trae',name:'New client model',modeldock_catalog_visibility:'current',modeldock_catalog_importable:false},
   {id:'route-history',object:'model',owned_by:'trae',modeldock_catalog_visibility:'historical'},
  ]);
  await expect(api.chat(credentials,{...request,model:'new-client-model'})).rejects.toMatchObject({code:'model'});
  expect(fetch).toHaveBeenCalledTimes(1);
  expect((await(await api.chat(credentials,request)).json()).choices[0].message.content).toBe('Mock response');
  expect(JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body))).toMatchObject({config_name:'route-history',model_name:'verified-route-history'});
 });
 it('imports all eighteen current entries when the batch directory supplies their real native routes, rather than the three old overlaps',async()=>{
  const modelIds=['Doubao-Seed-Code','DeepSeek-V4-Pro-Official','kimi-k3','glm-5.3-flashx','deepseek-v4.1-flash','Kimi-K3.1-Pro',...Array.from({length:12},(_,i)=>'synthetic-current-'+i)];
  const client:TraeClientModelCatalog={client:'trae-cn',models:modelIds.map((id,i)=>({id,name:'Client display '+i}))};
  const rows=modelIds.map((id,i)=>row(id,{model_detail_list:[{model_name:'Native-'+i+'__max'},{model_name:'Native-'+i+'__dev'}]}));
  const fetch=fetcher(rows),api=new TraeApi({fetch,clientModels:async()=>client});
  const result=await api.models(credentials,undefined,'trae-cn');
  expect(result.data).toHaveLength(18);
  expect(result.data.every(model=>model.modeldock_catalog_visibility==='current'&&model.modeldock_catalog_importable!==false)).toBe(true);
  expect(result.data.map(model=>model.id)).toEqual(modelIds);
  expect(result.modeldock_history.currentVerified).toBe(true);
  for(const index of [3,4,5]){
   const response=await api.chat(credentials,{...request,model:modelIds[index]});
   expect((await response.json()).choices[0].message.content).toBe('Mock response');
   const [url,init]=vi.mocked(fetch).mock.calls.at(-1)!;
   expect(String(url)).toBe('https://trae-api-cn.mchost.guru/api/ide/v2/llm_raw_chat');
   expect(JSON.parse(String(init?.body))).toMatchObject({config_name:modelIds[index],model_name:'Native-'+index+'__dev',config_source:1,raw_chat_function:'chat_v3'});
  }
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(String(vi.mocked(fetch).mock.calls[0][0])).toBe('https://api5-normal.mchost.guru/api/ide/v1/batch_get_detail_param');
 });
 it('keeps seventeen explicitly selectable client entries current without inventing model-specific permission rules',async()=>{
  const ids=Array.from({length:18},(_,i)=>'selection-fixture-'+i);
  const models=parseTraeClientModelCatalog(JSON.stringify({chat_v3:ids.map((name,i)=>({name,config_source:1,status:true,selectable:i!==17}))}));
  expect(models).toHaveLength(17);
  const result=await new TraeApi({fetch:fetcher(ids.map(id=>row(id))),clientModels:async()=>({client:'trae-cn',models:models!})}).models(credentials);
  expect(result.data.filter(model=>model.modeldock_catalog_visibility==='current').map(model=>model.id)).toEqual(ids.slice(0,17));
  expect(result.data.find(model=>model.id===ids[17])?.modeldock_catalog_visibility).toBe('historical');
 });
 it('preserves upstream authorization denial for a listed route rather than treating directory presence as account permission',async()=>{
  const fetch=vi.fn(async(url:string|URL|Request)=>String(url).includes('batch_get_detail_param')?Response.json(batch([row('route-current')])):new Response('SYNTHETIC_PRIVATE_ACCESS_DENIED',{status:403})) as unknown as typeof globalThis.fetch;
  const api=new TraeApi({fetch,clientModels:async()=>({client:'trae-cn',models:[{id:'route-current'}]})});
  const result=await api.models(credentials);
  expect(result.data[0].modeldock_catalog_importable).not.toBe(false);
  const error=await api.chat(credentials,{...request,model:'route-current'}).catch(error=>error);
  expect(error).toMatchObject({code:'authorization',status:403});
  expect(String(error)).not.toContain('SYNTHETIC_PRIVATE');
  expect(fetch).toHaveBeenCalledTimes(2);
 });
 it('does not claim a current menu without matching local evidence or classify age from version-like names',async()=>{
  const api=new TraeApi({fetch:fetcher([row('old-looking-1',{is_invisible_to_user:false}),row('new-looking-99',{is_invisible_to_user:true}),row('unknown-3')]),clientModels:async()=>undefined});
  const result=await api.models(credentials);expect(result.modeldock_history.currentVerified).toBe(false);
  expect(result.data.map(model=>[model.id,model.modeldock_catalog_visibility])).toEqual([['old-looking-1',undefined],['new-looking-99','historical'],['unknown-3',undefined]]);
 });
 it('never treats disabled, hard-offline or personal BYOK configurations as subscription history',async()=>{
  const rows=[row('disabled',{status:false}),row('hard',{provider_offline_status:'hard'}),row('not-selectable',{selectable:false}),row('switched-off',{config_switch:false}),row('private',{config_source:3}),row('private-display',{display_config:{is_custom_model:true}}),row('summary'),row('fast_apply'),row('title_generation'),row('input_optimization'),row('soft',{provider_offline_status:'soft'})];
  const result=await new TraeApi({fetch:fetcher(rows),clientModels:async()=>({client:'trae-cn',models:[]})}).models(credentials);
  expect(result.modeldock_history.currentVerified).toBe(true);expect(result.data.map(model=>model.id)).toEqual(['soft']);
 });
 it('keeps a cache read failure local and does not reread source auth or retry the official directory',async()=>{
  const fetch=fetcher([row('known-route')]);const result=await new TraeApi({fetch,clientModels:async()=>{throw new Error('SYNTHETIC_PRIVATE_PATH');}}).models(credentials);
  expect(result.modeldock_history.currentVerified).toBe(false);expect(JSON.stringify(result)).not.toContain('SYNTHETIC_PRIVATE');expect(fetch).toHaveBeenCalledTimes(1);
 });
 it('does not call an entry as a different account after a directory was read',async()=>{
  const fetch=vi.fn(async(_url:string|URL|Request,init?:RequestInit)=>Response.json(batch([row(new Headers(init?.headers).get('x-uid')===credentials.userId?'route-current':'other-account-route')]))) as unknown as typeof globalThis.fetch;
  const api=new TraeApi({fetch,clientModels:async()=>current});await api.models(credentials);
  await expect(api.chat({...credentials,userId:'OTHER_SYNTHETIC_ACCOUNT'},{...request,model:'route-current'})).rejects.toMatchObject({code:'model'});
  expect(fetch).toHaveBeenCalledTimes(2);
 });
});
