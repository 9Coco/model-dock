import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/main/store';
import { Gateway } from '../src/main/gateway';
import { buildConfig } from '../src/main/adapters';
import { applyJunieConfig, buildJunieConfig, junieConfigTargets } from '../src/main/junie-config';
import { ToolSyncUndoManager } from '../src/main/tool-sync-undo';
import { switchSingleEntryMode } from '../src/shared/single-entry';
import type { WireApi } from '../src/shared/types';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const task of cleanup.splice(0).reverse()) await task(); });
async function fixture(wireApi: WireApi = 'responses') {
  const home = mkdtempSync(join(tmpdir(), 'modeldock-junie-integration-'));
  const store = await Store.create(join(home, 'data'), { encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString() });
  cleanup.push(() => { store.close(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }); });
  const source = store.saveProvider({ name: 'Junie API fixture', kind: 'openai-compatible', baseUrl: 'https://junie-fixture.invalid/v1', enabled: true, apiKey: 'synthetic-junie-upstream-key' });
  const model = store.saveModel({ providerId: source.id, upstreamId: 'native-model', alias: 'junie-local-model', displayName: 'Junie fixture', wireApi, tools: true, vision: false, contextWindow: 64000, enabled: true });
  const other = store.saveModel({ ...model, id: undefined, upstreamId: 'native-other', alias: 'junie-other-model' });
  const before = store.listBindings().find(binding => binding.id === 'junie')!;
  store.saveBinding({ ...before, enabled: true, mode: 'aggregate', providerIds: [source.id], modelIds: [model.id], modelSelection: 'selected', defaultModelId: model.id });
  const options = { junieCommand: { command: process.execPath, args: [] } };
  return { home, store, source, model, other, before, options };
}

describe('Junie tool integration', () => {
  it.each(['responses', 'chat-completions'] as const)('uses the generated %s endpoint with exact scoped model permissions', async wire => {
    const f = await fixture(wire), calls: {url: string; body: any; key: string | null}[] = [];
    const gateway = new Gateway(f.store, { fetch: async (url, init) => {
      const body = JSON.parse(String(init?.body));
      calls.push({ url: String(url), body, key: new Headers(init?.headers).get('authorization') });
      return Response.json(wire === 'responses'
        ? { id:'fixture', object:'response', model:body.model, status:'completed', output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'OK'}]}] }
        : { id:'fixture', object:'chat.completion', model:body.model, choices:[{index:0,message:{role:'assistant',content:'OK'},finish_reason:'stop'}] });
    } });
    await gateway.start(0); cleanup.push(async () => { await gateway.stop(); });
    const preview = JSON.parse(buildConfig(f.store, 'junie', gateway.status().port, false, f.home).content);
    expect(preview.profile.apiKey).toBe('__MODELDOCK_LOCAL_KEY__');
    expect(JSON.stringify(preview)).not.toContain('synthetic-junie-upstream-key');
    const { profile } = JSON.parse(buildJunieConfig(f.store, true, gateway.status().port, f.home, f.options).content);
    const headers = { authorization: `Bearer ${profile.apiKey}`, 'content-type': 'application/json' };
    const input = [{type:'function_call',call_id:'prior',name:'lookup',arguments:'{}'}, {type:'function_call_output',call_id:'prior',output:'合成结果'}];
    const messages = [{role:'user',content:'Synthetic test.'}];
    const body = { model: profile.id, ...(wire === 'responses' ? { input } : { messages }), stream:false };
    const response = await fetch(profile.baseUrl, {method:'POST',headers,body:JSON.stringify(body)});
    expect(response.status).toBe(200); expect((await response.json()).model).toBe(f.model.alias);
    expect(calls).toEqual([{url:`${f.source.baseUrl}/${wire === 'responses' ? 'responses' : 'chat/completions'}`, body:{...body,model:f.model.upstreamId}, key:'Bearer synthetic-junie-upstream-key'}]);
    for (const [key, model, status] of [[profile.apiKey,f.other.alias,403],['invalid-local-key',profile.id,401]] as const) {
      const denied = await fetch(profile.baseUrl, {method:'POST',headers:{...headers,authorization:`Bearer ${key}`},body:JSON.stringify({...body,model})});
      expect(denied.status).toBe(status); await denied.text();
    }
    expect(calls).toHaveLength(1);
    const binding = f.store.listBindings().find(binding => binding.id === 'junie')!;
    f.store.saveBinding({ ...switchSingleEntryMode(binding,'direct',f.store.listModels(),f.store.listProviders()), enabled:true,
      providerIds:[f.source.id],modelIds:[],modelSelection:'all',defaultModelId:f.model.id });
    const direct = JSON.parse(buildJunieConfig(f.store,true,18181,f.home,f.options).content);
    expect(direct.profile).toMatchObject({id:f.model.upstreamId,baseUrl:`${f.source.baseUrl}/${wire === 'responses' ? 'responses' : 'chat/completions'}`,apiKey:'synthetic-junie-upstream-key'});
    const disabledRoute = await fetch(profile.baseUrl,{method:'POST',headers,body:JSON.stringify(body)});
    expect(disabledRoute.status).toBe(403); await disabledRoute.text(); expect(calls).toHaveLength(1);
  });

  it('undoes CLI selection, model profile, IDE ACP entry and binding together, refusing external edits', async () => {
    const f = await fixture();
    const targets = junieConfigTargets(f.home);
    const originalConfig = '{"model":"original-model","brave":false}\n';
    const originalAcp = '{"default_mcp_settings":{"use_idea_mcp":false},"agent_servers":{"Other":{"command":"keep"}}}\n';
    for (const [path, contents] of [[targets.configPath,originalConfig],[targets.acpPath,originalAcp]]) { mkdirSync(dirname(path),{recursive:true}); writeFileSync(path,contents); }
    const manager = new ToolSyncUndoManager(f.store,{appData:join(f.home,'appdata'),homeDirectory:f.home});
    await manager.run('junie',f.before,()=>applyJunieConfig(f.store,join(f.home,'backups'),f.home,f.options));
    expect(manager.status('junie').available).toBe(true);
    expect(JSON.parse(readFileSync(targets.acpPath,'utf8')).agent_servers['Junie · ModelDock']).toMatchObject({args:['--acp','true','--model','custom:modeldock']});
    const applied = readFileSync(targets.profilePath,'utf8'); writeFileSync(targets.profilePath,applied+' ');
    expect(manager.status('junie').available).toBe(false);
    await expect(manager.undo('junie')).rejects.toThrow('修改');
    writeFileSync(targets.profilePath,applied);
    expect(await manager.undo('junie')).toBe(targets.configPath);
    expect(readFileSync(targets.configPath,'utf8')).toBe(originalConfig);
    expect(readFileSync(targets.acpPath,'utf8')).toBe(originalAcp);
    expect(existsSync(targets.profilePath)).toBe(false);
    expect(f.store.listBindings().find(binding => binding.id==='junie')).toMatchObject({enabled:false,providerIds:[],defaultModelId:''});
  });

  it.skipIf(process.platform !== 'win32')('keeps a restored Junie credential profile private after a second synchronization', async () => {
    const f = await fixture(), target = junieConfigTargets(f.home);
    const manager = new ToolSyncUndoManager(f.store,{appData:join(f.home,'appdata'),homeDirectory:f.home});
    await manager.run('junie',f.before,()=>applyJunieConfig(f.store,join(f.home,'backups'),f.home,f.options));
    const before = f.store.listBindings().find(binding=>binding.id==='junie')!;
    f.store.saveBinding({...before,modelIds:[f.other.id],defaultModelId:f.other.id});
    await manager.run('junie',before,()=>applyJunieConfig(f.store,join(f.home,'backups'),f.home,f.options));
    await manager.undo('junie');
    expect(JSON.parse(readFileSync(target.profilePath,'utf8'))).toMatchObject({id:f.model.alias,apiKey:f.store.gatewayKey()});
    const script = '$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $acl=[IO.File]::GetAccessControl($env:MODELDOCK_TEST_PROFILE); $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])); if(!$acl.AreAccessRulesProtected -or $rules.Count -ne 2 -or @($rules | Where-Object {$_.IdentityReference.Value -notin @($sid,"S-1-5-18") -or $_.AccessControlType -ne "Allow" -or $_.FileSystemRights -ne "FullControl"}).Count){throw "Unexpected Junie profile ACL"}; "private"';
    const result = execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,encoding:'utf8',env:{...process.env,MODELDOCK_TEST_PROFILE:target.profilePath}});
    expect(result.trim()).toBe('private');
  });
});
