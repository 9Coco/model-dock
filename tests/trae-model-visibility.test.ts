import { describe, expect, it, vi } from 'vitest';
import { TraeApi } from '../src/main/trae-api';
import type { TraeClientCredentials } from '../src/main/trae-client-import';
import type { TraeClientModelCatalog } from '../src/main/trae-client-models';
const credentials:TraeClientCredentials={host:'https://api.trae.cn',userId:'SYNTHETIC_ACCOUNT',token:'SYNTHETIC_TOKEN'};
const row=(id:string,extra:Record<string,unknown>={})=>({config_name:id,usage:'chat_completion',config_source:1,model_detail_list:[{model_name:'verified-'+id}],...extra});
const current:TraeClientModelCatalog={client:'trae-cn',models:[{id:'route-current',name:'Current exact client name'},{id:'new-client-model',name:'New client model'}]};
const request={model:'route-history',messages:[{role:'user',content:'Synthetic mock'}]};
const nativeStream=()=>new Response('event: text_delta\ndata: {"text":"Mock response"}\n\nevent: done\ndata: {}\n\n',{headers:{'content-type':'text/event-stream'}});
const fetcher=(rows:unknown[])=>vi.fn(async(url:string|URL|Request)=>String(url).includes('get_detail_param')?Response.json({config_info_list:rows}):nativeStream()) as unknown as typeof fetch;
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
 it('does not claim a current menu without matching local evidence or classify age from version-like names',async()=>{
  const api=new TraeApi({fetch:fetcher([row('old-looking-1',{is_invisible_to_user:false}),row('new-looking-99',{is_invisible_to_user:true}),row('unknown-3')]),clientModels:async()=>undefined});
  const result=await api.models(credentials);expect(result.modeldock_history.currentVerified).toBe(false);
  expect(result.data.map(model=>[model.id,model.modeldock_catalog_visibility])).toEqual([['old-looking-1',undefined],['new-looking-99','historical'],['unknown-3',undefined]]);
 });
 it('never treats disabled, hard-offline or personal BYOK configurations as subscription history',async()=>{
  const rows=[row('disabled',{status:false}),row('hard',{provider_offline_status:'hard'}),row('not-selectable',{selectable:false}),row('private',{config_source:3}),row('soft',{provider_offline_status:'soft'})];
  const result=await new TraeApi({fetch:fetcher(rows),clientModels:async()=>({client:'trae-cn',models:[]})}).models(credentials);
  expect(result.modeldock_history.currentVerified).toBe(true);expect(result.data.map(model=>model.id)).toEqual(['soft']);
 });
 it('keeps a cache read failure local and does not reread source auth or retry the official directory',async()=>{
  const fetch=fetcher([row('known-route')]);const result=await new TraeApi({fetch,clientModels:async()=>{throw new Error('SYNTHETIC_PRIVATE_PATH');}}).models(credentials);
  expect(result.modeldock_history.currentVerified).toBe(false);expect(JSON.stringify(result)).not.toContain('SYNTHETIC_PRIVATE');expect(fetch).toHaveBeenCalledTimes(1);
 });
 it('does not call an entry as a different account after a directory was read',async()=>{
  const fetch=vi.fn(async(_url:string|URL|Request,init?:RequestInit)=>Response.json({config_info_list:[row(new Headers(init?.headers).get('x-uid')===credentials.userId?'route-current':'other-account-route')]})) as unknown as typeof globalThis.fetch;
  const api=new TraeApi({fetch,clientModels:async()=>current});await api.models(credentials);
  await expect(api.chat({...credentials,userId:'OTHER_SYNTHETIC_ACCOUNT'},{...request,model:'route-current'})).rejects.toMatchObject({code:'model'});
  expect(fetch).toHaveBeenCalledTimes(2);
 });
});
