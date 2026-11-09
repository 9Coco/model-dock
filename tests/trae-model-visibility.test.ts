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

const restrictedModel = 'kimi-k3.1-pro';
const currentModelIds = [
  'Doubao-Seed-2.1-Turbo', 'Doubao-Seed-2.1-Pro', 'Doubao-Seed-Evolving', 'Doubao-Seed-Code',
  'glm-5.3-flash', 'glm-5.3-flashx', 'glm-5.3', 'deepseek-v4.1-flash', 'DeepSeek-V4-Pro-Official',
  restrictedModel, 'kimi-k3', 'mimo-v2.6-flash', 'mimo-v2.6-pro', 'minimax-m3.1-flash',
  'minimax-m3', 'step-5-preview', 'qwen3.8-flash', 'qwen3.8-max',
];
const legacyModelIds = ['Doubao-Seed-Code', 'DeepSeek-V4-Pro-Official', 'minimax-m3'];

function nativeRow(id: string) {
  const restricted = id === restrictedModel;
  return row(id, {
    display_contact_config: JSON.stringify({
      access: { ...(restricted ? { enable: true } : {}), data: { identity_list: restricted ? [5, 1, 2, 3, 100] : [0, 5, 1, 2, 3, 100] } },
    }),
    model_detail_list: [
      { model_name: id + '__max', encrypted_model_params: 'SYNTHETIC_PRIVATE_ROUTE' },
      { model_name: id + '__dev', encrypted_model_params: 'SYNTHETIC_PRIVATE_ROUTE' },
    ],
  });
}

function nativeEndpoints(
  payStatus: () => Response,
  additionalRows: ReturnType<typeof row>[] = [],
) {
  const inference = vi.fn<(_: RequestInit) => Response>(nativeStream);
  const pay = vi.fn((_product: string) => payStatus());
  const directory = vi.fn((headers: Headers) => {
    // The old revision returned routes for only three of the present-day picker entries.
    const latest = Number(headers.get('x-ide-version-code')) >= 20261029
      && headers.get('x-ide-version-code') === headers.get('x-app-version-code');
    const ids = latest ? currentModelIds : legacyModelIds;
    return Response.json({ config_info_list: [...ids.map(nativeRow), ...additionalRows] });
  });
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    switch (url.origin + url.pathname) {
      case 'https://trae-api-cn.mchost.guru/api/ide/v1/get_detail_param':
        expect(url.searchParams.get('function')).toBe('chat_v3');
        return directory(new Headers(init.headers));
      case 'https://api.trae.cn/trae/api/v2/pay/ide_user_pay_status':
        return pay(JSON.parse(String(init.body)).trae_client);
      case 'https://trae-api-cn.mchost.guru/api/ide/v2/llm_raw_chat':
        return inference(init);
      default:
        throw new Error('Unexpected upstream URL');
    }
  };
  return { fetch, inference, pay, directory };
}

const clientSnapshot: TraeClientModelCatalog = { client: 'trae-cn', models: currentModelIds.map(id => ({ id })) };

describe('TRAE directory revision and account access', () => {
  it('imports the 17 unlocked entries and dispatches a previously missing model using its verified route', async () => {
    const server = nativeEndpoints(() => Response.json({ user_pay_identity: 0 }));
    const api = new TraeApi({ fetch: server.fetch, clientModels: async () => clientSnapshot });
    const result = await api.models(credentials, undefined, 'trae-cn');
    expect(result.data.map(model => model.id)).toEqual(currentModelIds);
    expect(result.data.filter(model => model.modeldock_catalog_importable !== false)).toHaveLength(17);
    expect(result.data.find(model => model.id === restrictedModel)).toMatchObject({
      modeldock_catalog_visibility: 'current', modeldock_catalog_importable: false, modeldock_catalog_blocked_reason: 'account-access',
    });
    const model = 'qwen3.8-max';
    const response = await api.chat(credentials, { ...request, model }, undefined, 'trae-cn');
    expect((await response.json()).choices[0].message.content).toBe('Mock response');
    const init = server.inference.mock.calls[0][0];
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ config_source: 1, config_name: model, model_name: model + '__dev' });
    expect(new Headers(init.headers).get('x-ide-version-code')).toBe(server.directory.mock.calls[0][0].get('x-ide-version-code'));
    expect(JSON.stringify([result, body])).not.toMatch(/SYNTHETIC_TOKEN|SYNTHETIC_PRIVATE_ROUTE|identity_list|display_contact_config/);
    expect(body).not.toHaveProperty('modeldock_catalog_visibility');
    expect(server.pay.mock.calls).toEqual([['IDE']]);
  });

  it.each([
    { status: 'the Free identity', pay: () => Response.json({ user_pay_identity: 0 }), reason: 'account-access' },
    { status: 'a missing identity', pay: () => Response.json({}), reason: 'access-unknown' },
    { status: 'a failed status lookup', pay: () => new Response(null, { status: 503 }), reason: 'access-unknown' },
  ])('checks a manually entered or saved model on a cold cache with $status and no client snapshot', async ({ pay, reason }) => {
    const server = nativeEndpoints(pay, [row('malformed-access', { display_contact_config: '{incomplete' })]);
    const api = new TraeApi({ fetch: server.fetch, clientModels: async () => undefined });
    await expect(api.chat(credentials, { ...request, model: restrictedModel })).rejects.toMatchObject({ code: reason });
    await expect(api.chat(credentials, { ...request, model: 'malformed-access' })).rejects.toMatchObject({ code: 'access-unknown' });
    expect(server.inference).not.toHaveBeenCalled();
    expect(server.directory).toHaveBeenCalledOnce();
    expect(server.pay).toHaveBeenCalledOnce();
    const result = await api.models(credentials);
    expect(result.data.find(model => model.id === restrictedModel)).toMatchObject({
      modeldock_catalog_importable: false, modeldock_catalog_blocked_reason: reason,
    });
    const response = await api.chat(credentials, { ...request, model: 'kimi-k3' });
    expect((await response.json()).choices[0].message.content).toBe('Mock response');
  });

  it('allows a qualifying identity and revalidates access when the directory expires', async () => {
    let identity = 1, now = 0;
    const server = nativeEndpoints(() => Response.json({ user_pay_identity: identity }));
    const api = new TraeApi({ fetch: server.fetch, now: () => now, clientModels: async () => undefined });
    const body = { ...request, model: restrictedModel };
    const response = await api.chat(credentials, body, undefined, 'trae-cn');
    expect((await response.json()).choices[0].message.content).toBe('Mock response');
    identity = 0; now += 300_001;
    await expect(api.chat(credentials, body, undefined, 'trae-cn')).rejects.toMatchObject({ code: 'account-access' });
    expect(server.pay).toHaveBeenCalledTimes(2);
    expect(server.inference).toHaveBeenCalledOnce();
  });

  it('separates product-specific cached selections and applies the stricter lock to both the alias and the upstream config', async () => {
    const server = nativeEndpoints(() => Response.json({ user_pay_identity: 1 }));
    const alias = 'custom-picker-name', configName = 'qwen3.8-flash';
    const clientModels = vi.fn(async (_id: string, client?: TraeClientModelCatalog['client']) => client
      ? { client, models: [{ id: alias, configName, ...(client === 'trae-solo-cn' ? { locked: true as const } : {}) }] } : undefined);
    const api = new TraeApi({ fetch: server.fetch, clientModels });
    await api.models(credentials, undefined, 'trae-cn');
    for (const model of [alias, configName]) {
      await expect(api.chat(credentials, { ...request, model }, undefined, 'trae-solo-cn')).rejects.toMatchObject({ code: 'account-access' });
    }
    expect(server.inference).not.toHaveBeenCalled();
    await api.chat(credentials, { ...request, model: alias }, undefined, 'trae-cn');
    expect(JSON.parse(String(server.inference.mock.calls[0][0].body))).toMatchObject({ config_name: configName, model_name: configName + '__dev' });
    expect(clientModels.mock.calls).toEqual([[credentials.userId, 'trae-cn'], [credentials.userId, 'trae-solo-cn']]);
    expect(server.pay.mock.calls).toEqual([['IDE'], ['Lite']]);
  });

  it('keeps an explicit client exclusion out of history and refuses its picker ID and upstream config even when the cloud advertises both', async () => {
    const ids = ['disabled-picker', 'disabled-route'];
    const server = nativeEndpoints(() => Response.json({ user_pay_identity: 1 }), ids.map(id => row(id)));
    const clientModels = async () => ({ ...clientSnapshot, excludedConfigIds: ids });
    const api = new TraeApi({ fetch: server.fetch, clientModels });
    const result = await api.models(credentials, undefined, 'trae-cn');
    for (const model of ids) {
      expect(result.data.some(entry => entry.id === model)).toBe(false);
      await expect(api.chat(credentials, { ...request, model }, undefined, 'trae-cn')).rejects.toMatchObject({ code: 'model' });
    }
    expect(server.inference).not.toHaveBeenCalled();
  });

  it('cannot dispatch disabled, offline, nonselectable or private configs through manual IDs', async () => {
    const excluded = [
      row('not-enabled', { status: false }), row('offline', { provider_offline_status: 'hard' }),
      row('unselectable', { selectable: false }), row('byok', { config_source: 3 }),
    ];
    const server = nativeEndpoints(() => Response.json({ user_pay_identity: 1 }), excluded);
    const api = new TraeApi({ fetch: server.fetch, clientModels: async () => undefined });
    for (const { config_name: model } of excluded) {
      await expect(api.chat(credentials, { ...request, model })).rejects.toMatchObject({ code: 'model' });
    }
    expect(server.inference).not.toHaveBeenCalled();
  });
});
