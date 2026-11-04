import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error Standalone native ES module loaded by Pi, not compiled into Electron.
import { centralModels, chatRequest, makeRelay } from '../scripts/central-pi-extension.mjs';

const key = 'a'.repeat(40), nonce = 'sample-run';
const central = 'http://127.0.0.1:19101/wire/' + 'b'.repeat(32) + '/pi/openai/v1';
const model = {id:'model-test',name:'Model',api:'openai-responses',provider:'openai',baseUrl:central, input:['text'],reasoning:true};
const mid = model.provider + '/' + model.id;
const usage = {input:4,output:5,cacheRead:1,cacheWrite:0,totalTokens:10};
const tc = {type:'toolCall',id:'call-a',name:'read_info',arguments:{id:7}};
const events = [
  {type:'start'}, {type:'text_delta',contentIndex:0,delta:'Ready'}, {type:'toolcall_end',contentIndex:1,toolCall:tc},
  {type:'done', message:{stopReason:'toolUse',content:[{type:'text',text:'Ready'},tc],usage}},
];
function registry() {
  return {getAll:()=>[model],getRegisteredProviderConfig:()=>({baseUrl:central}),streamSimple:vi.fn((..._args:unknown[]) => events)};
}
const servers: Server[] = [];
async function listen(s: Server) {
  servers.push(s);
  await new Promise<void>((resolve,reject) => {s.once('error',reject); s.listen(0,'127.0.0.1',resolve);});
  const addr = s.address(); if (!addr || typeof addr === 'string') throw new Error('No port');
  return 'http://127.0.0.1:' + addr.port;
}
function call(url:string, body:unknown, signal?:AbortSignal) {
  return fetch(url + '/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer ' + key},body:JSON.stringify(body),signal});
}
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise<void>(done => {s.close(()=>done());s.closeAllConnections();}))); });
describe('real Pi extension boundary', () => {
  it('requires both registered and resolved model endpoints and rejects external URLs, mismatched route, auth and custom stream overrides', () => {
    for (const baseUrl of [central+'/../x',central+'?a=1',central.replace('127.0.0.1','localhost'),central.replace('openai','anthropic'),central.replace('/pi/','/codex/')]) {
      expect(centralModels({...registry(),getAll:()=>[{...model,baseUrl}],getRegisteredProviderConfig:()=>({baseUrl})}).size).toBe(0);
    }
    for (const config of [undefined,{baseUrl:'https://upstream.example'},{baseUrl:central,oauth:{}},{baseUrl:central,streamSimple:()=>null}]) {
      expect(centralModels({...registry(),getRegisteredProviderConfig:()=>config}).size).toBe(0);
    }
    expect([...centralModels(registry()).keys()]).toEqual([mid]);
  });
  it('preserves message roles, tools and linked results without executing tools', () => {
    const {context,options} = chatRequest({model:mid,messages:[
      {role:'system',content:'s'}, {role:'user',content:'u'}, {role:'assistant',content:null,tool_calls:[{id:'c',type:'function',function:{name:'read_info',arguments:'{"id":7}'}}]},
      {role:'tool',tool_call_id:'c',content:'result'}, {role:'developer',content:'d'}, {role:'user',content:'next'}],
      tools:[{type:'function',function:{name:'read_info',parameters:{type:'object'}}}],max_completion_tokens:60,tool_choice:'auto'}, model);
    expect(context.messages.map((m:{role:string})=>m.role)).toEqual(['system','user','assistant','toolResult','system','user']);
    expect(context.messages[2].content[0]).toMatchObject({name:'read_info',arguments:{id:7}});
    expect(context.messages[3]).toMatchObject({toolName:'read_info',toolCallId:'c',content:[{type:'text',text:'result'}]});
    expect(options).toMatchObject({maxTokens:60,toolChoice:'auto'});
    expect(()=>chatRequest({messages:[{role:'tool',tool_call_id:'missing',content:'x'}]},model)).toThrow();
    expect(()=>chatRequest({messages:[{role:'user',content:'x'}],response_format:{}},model)).toThrow();
  });
  it('maps forced tool choice and top_p to each native protocol', () => {
    const request={messages:[{role:'user',content:'u'}], top_p:0.9,parallel_tool_calls:false,
      tools:[{type:'function',function:{name:'example'}}],tool_choice:{type:'function',function:{name:'example'}}};
    expect(chatRequest(request,model).options.onPayload({})).toEqual({top_p:0.9,parallel_tool_calls:false,tool_choice:{type:'function',name:'example'}});
    expect(chatRequest(request,{...model,api:'anthropic-messages'}).options.onPayload({})).toEqual({top_p:0.9,tool_choice:{type:'tool',name:'example',disable_parallel_tool_use:true}});
  });
  it('separates health proof from inference authorization and returns no URL/key in the model list', async () => {
    const url = await listen(makeRelay(registry(),key,nonce));
    const healthKey = createHmac('sha256',key).update('health:'+nonce).digest('hex');
    const get = (path:string, credential:string) => fetch(url+path,{headers:{authorization:'Bearer '+credential}});
    expect((await get('/health',key)).status).toBe(401);
    expect(await (await get('/health',healthKey)).json()).toEqual({id:'modeldock-central-pi',nonce});
    expect((await get('/v1/models',healthKey)).status).toBe(401);
    const listed = await (await get('/v1/models',key)).text();
    expect(listed).toContain(mid); expect(listed).not.toContain('/wire/'); expect(listed).not.toContain(key);
  });
  it('emits authentic OpenAI tool-call shapes in JSON and streaming, and refuses unknown models', async () => {
    const fixture=registry(), url=await listen(makeRelay(fixture,key,nonce)); const body={model:mid,messages:[{role:'user',content:'u'}]};
    const out = await (await call(url,body)).json();
    expect(out.choices[0]).toMatchObject({finish_reason:'tool_calls',message:{content:'Ready',tool_calls:[{id:'call-a',type:'function',function:{name:'read_info',arguments:'{"id":7}'}}]}});
    expect(out.usage).toMatchObject({prompt_tokens:5,completion_tokens:5,total_tokens:10});
    const sse=await (await call(url,{...body,stream:true,stream_options:{include_usage:true}})).text();
    expect(sse).toContain('"content":"Ready"'); expect(sse).toContain('"tool_calls":[{"index":0');expect(sse).toContain('"choices":[],"usage"');
    expect(sse).toMatch(/data: \[DONE\]\n\n$/);
    expect((await call(url,{...body,model:'x'})).status).toBe(404);expect(fixture.streamSimple).toHaveBeenCalledTimes(2);
  });
  it('sends only to the exact local path and does not follow a redirect or expose personal credentials', async () => {
    const seen:string[]=[];
    const foreign=await listen(createServer((req,res)=>{seen.push('foreign');res.end();}));
    const upstream=await listen(createServer((req,res)=>{seen.push(String(req.headers.authorization));res.writeHead(307,{location:foreign});res.end();}));
    const baseUrl=upstream + '/wire/' + 'f'.repeat(32) + '/pi/openai/v1';
    let guardedFetch:typeof fetch | undefined;
    const fake={...registry(),getAll:()=>[{...model,baseUrl}],getRegisteredProviderConfig:()=>({baseUrl}),
      streamSimple:(_m:unknown,_c:unknown,o:{fetch:typeof fetch})=>{guardedFetch=o.fetch;return events;}};
    const url=await listen(makeRelay(fake,key,nonce));
    await (await call(url,{model:mid,messages:[{role:'user',content:'u'}]})).text();
    await expect(guardedFetch!(foreign,{method:'POST'})).rejects.toThrow();
    await expect(guardedFetch!(baseUrl+'/responses',{method:'POST',body:'{}',headers:{authorization:'Bearer wrong'}})).rejects.toThrow('redirect');
    expect(seen).toEqual(['undefined']);
  });
  it('cancels the model stream on disconnect and never completes a truncated stream', async () => {
    let cancelled:()=>void=()=>{};
    const stopped=new Promise<void>(done=>{cancelled=done;});
    const fake={...registry(),async *streamSimple(_m:unknown,_c:unknown,o:{signal:AbortSignal}) {
      yield {type:'start'}; await new Promise<void>(done=>o.signal.addEventListener('abort',()=>{done();cancelled();},{once:true}));
    }};
    const url=await listen(makeRelay(fake,key,nonce)), abort=new AbortController();
    const response=await call(url,{model:mid,messages:[{role:'user',content:'u'}],stream:true},abort.signal);
    expect(response.status).toBe(200); abort.abort(); await stopped;
    const truncated=await listen(makeRelay({...registry(),streamSimple:()=>events.slice(0,2)},key,nonce));
    const sse=await (await call(truncated,{model:mid,messages:[{role:'user',content:'u'}],stream:true})).text();
    expect(sse).toContain('"error":');expect(sse).not.toContain('[DONE]');
  });
});
