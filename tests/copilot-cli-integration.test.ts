import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/main/store';
import { Gateway } from '../src/main/gateway';
import { applyConfig, buildConfig } from '../src/main/adapters';
import { copilotCliConfigTargets } from '../src/main/copilot-cli-config';
import { ToolSyncUndoManager } from '../src/main/tool-sync-undo';
import { restoreOfficialConfig } from '../src/main/tool-restore';
import { switchSingleEntryMode } from '../src/shared/single-entry';
import type { WireApi } from '../src/shared/types';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
async function fixture(wireApi: WireApi = 'responses') {
  const home = mkdtempSync(join(tmpdir(), 'modeldock-copilot-cli-integration-'));
  const store = await Store.create(join(home, 'data'), { encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString() });
  cleanup.push(() => { store.close(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }); });
  const source = store.saveProvider({ name: 'CLI fixture', kind: 'openai-compatible', baseUrl: 'https://cli-fixture.invalid/v1', enabled: true, apiKey: 'synthetic-cli-upstream-key' });
  const model = store.saveModel({ providerId: source.id, upstreamId: 'native-model', alias: 'cli-local-model', displayName: 'CLI fixture', wireApi, contextWindow: 64000, tools: true, vision: false, enabled: true });
  const other = store.saveModel({ ...model, id: undefined, upstreamId: 'native-other', alias: 'cli-other-model' });
  const before = store.listBindings().find(binding => binding.id === 'copilot-cli')!;
  store.saveBinding({ ...before, enabled: true, mode: 'aggregate', providerIds: [source.id], modelIds: [model.id], modelSelection: 'selected', defaultModelId: model.id });
  const appData = join(home, 'appdata'), backups = join(home, 'backups');
  const apply = (port = 18181) => applyConfig(store, 'copilot-cli', port, appData, backups, home);
  return { home, store, source, model, other, before, apply, appData, backups };
}

describe('Copilot CLI independent configuration and gateway integration', () => {
  it.each(['responses', 'chat-completions'] as const)('uses the generated %s registry with exact tool-scoped routing', async wire => {
    const f = await fixture(wire), calls: { url: string; body: unknown; key: string | null }[] = [];
    const gateway = new Gateway(f.store, { fetch: async (url, init) => {
      const body = JSON.parse(String(init?.body));
      calls.push({ url: String(url), body, key: new Headers(init?.headers).get('authorization') });
      return Response.json(wire === 'responses'
        ? { id: 'fixture', object: 'response', model: body.model, status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }] }
        : { id: 'fixture', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] });
    } });
    await gateway.start(0); cleanup.push(async () => { await gateway.stop(); });
    const preview = JSON.parse(buildConfig(f.store, 'copilot-cli', gateway.status().port, false, f.home).content);
    expect(preview.providers[0].apiKey).toBe('__MODELDOCK_LOCAL_KEY__');
    expect(JSON.stringify(preview)).not.toContain('synthetic-cli-upstream-key');
    f.apply(gateway.status().port);
    const targets = copilotCliConfigTargets(f.home);
    const registry = JSON.parse(readFileSync(targets.providersPath, 'utf8'));
    const provider = registry.providers[0], model = registry.models[0];
    expect(provider).toMatchObject({ name: wire === 'responses' ? 'modeldock-responses' : 'modeldock-chat', type: 'openai', baseUrl: `${new URL(gateway.status().baseUrl).origin}/tool/copilot-cli/v1`, wireApi: wire === 'responses' ? 'responses' : 'completions', apiKey: f.store.gatewayKey() });
    expect(model).toMatchObject({ id: f.model.alias, wireModel: f.model.alias, modelId: f.model.upstreamId });
    expect(JSON.parse(readFileSync(targets.settingsPath, 'utf8')).model).toBe(`${provider.name}/${model.id}`);
    const endpoint = `${provider.baseUrl}/${wire === 'responses' ? 'responses' : 'chat/completions'}`;
    const headers = { authorization: `Bearer ${provider.apiKey}`, 'content-type': 'application/json' };
    const history = [{ type: 'function_call', call_id: 'prior', name: 'lookup', arguments: '{}' }, { type: 'function_call_output', call_id: 'prior', output: 'Synthetic memory result' }];
    const messages = [{ role: 'assistant', tool_calls: [{ id: 'prior', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'prior', content: 'Synthetic memory result' }];
    const body = { model: model.wireModel, ...(wire === 'responses' ? { input: history } : { messages }), stream: false };
    const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
    expect(response.status).toBe(200); expect((await response.json()).model).toBe(f.model.alias);
    expect(calls).toEqual([{ url: `${f.source.baseUrl}/${wire === 'responses' ? 'responses' : 'chat/completions'}`, body: { ...body, model: f.model.upstreamId }, key: 'Bearer synthetic-cli-upstream-key' }]);
    for (const [key, id, status] of [[provider.apiKey, f.other.alias, 403], ['invalid-key', model.id, 401]] as const) {
      const denied = await fetch(endpoint, { method: 'POST', headers: { ...headers, authorization: `Bearer ${key}` }, body: JSON.stringify({ ...body, model: id }) });
      expect(denied.status).toBe(status); await denied.text();
    }
    expect(calls).toHaveLength(1);
    const binding = f.store.listBindings().find(binding => binding.id === 'copilot-cli')!;
    f.store.saveBinding({ ...switchSingleEntryMode(binding, 'direct', f.store.listModels(), f.store.listProviders()), enabled: true, providerIds: [f.source.id], modelIds: [], modelSelection: 'all', defaultModelId: f.model.id });
    const direct = JSON.parse(buildConfig(f.store, 'copilot-cli', 18181, true, f.home).content);
    expect(direct.providers[0]).toMatchObject({ baseUrl: f.source.baseUrl, apiKey: 'synthetic-cli-upstream-key' });
    expect(direct.models[0]).toMatchObject({ id: f.model.upstreamId, wireModel: f.model.upstreamId });
    const disabled = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
    expect(disabled.status).toBe(403); await disabled.text(); expect(calls).toHaveLength(1);
  });

  it('undoes both files and selection together, refusing external edits and leaving desktop/VS Code independent', async () => {
    const f = await fixture(), targets = copilotCliConfigTargets(f.home);
    const originalRegistry = '{"providers":[{"name":"other","baseUrl":"http://127.0.0.1:19191/v1"}],"models":[{"provider":"other","id":"keep"}]}\n';
    const originalSettings = '{\n  // Retain user preference\n  "model": "other/keep",\n  "theme": "dark"\n}\n';
    for (const [path, content] of [[targets.providersPath, originalRegistry], [targets.settingsPath, originalSettings]]) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }
    const unrelated = f.store.listBindings().filter(binding => binding.id === 'copilot' || binding.id === 'vscode');
    const manager = new ToolSyncUndoManager(f.store, { homeDirectory: f.home, appData: f.appData });
    await manager.run('copilot-cli', f.before, () => f.apply());
    expect(manager.status('copilot-cli').available).toBe(true);
    const applied = readFileSync(targets.providersPath, 'utf8'); writeFileSync(targets.providersPath, applied + ' ');
    expect(manager.status('copilot-cli').available).toBe(false);
    await expect(manager.undo('copilot-cli')).rejects.toThrow('修改');
    writeFileSync(targets.providersPath, applied);
    expect(await manager.undo('copilot-cli')).toBe(targets.providersPath);
    expect(readFileSync(targets.providersPath, 'utf8')).toBe(originalRegistry);
    expect(readFileSync(targets.settingsPath, 'utf8')).toBe(originalSettings);
    expect(f.store.listBindings().find(binding => binding.id === 'copilot-cli')).toMatchObject({ enabled: false, providerIds: [], defaultModelId: '' });
    expect(f.store.listBindings().filter(binding => binding.id === 'copilot' || binding.id === 'vscode')).toEqual(unrelated);
  });

  it('routes restore through the CLI adapter without touching account or permission state', async () => {
    const f = await fixture(), targets = copilotCliConfigTargets(f.home);
    f.apply();
    const accountState = join(dirname(targets.providersPath), 'config.json'), permissions = join(dirname(targets.providersPath), 'permissions-config.json');
    writeFileSync(accountState, '{"syntheticAccountState":"keep"}'); writeFileSync(permissions, '{"syntheticPermissions":"keep"}');
    expect(await restoreOfficialConfig(f.store, 'copilot-cli', f.appData, f.backups, f.home)).toBe(targets.providersPath);
    expect(existsSync(targets.providersPath)).toBe(false); expect(existsSync(targets.settingsPath)).toBe(false);
    expect(readFileSync(accountState, 'utf8')).toBe('{"syntheticAccountState":"keep"}');
    expect(readFileSync(permissions, 'utf8')).toBe('{"syntheticPermissions":"keep"}');
  });

  it.skipIf(process.platform !== 'win32')('keeps the key registry private after synchronizing twice and undoing', async () => {
    const f = await fixture(), target = copilotCliConfigTargets(f.home), manager = new ToolSyncUndoManager(f.store, { homeDirectory: f.home, appData: f.appData });
    await manager.run('copilot-cli', f.before, () => f.apply());
    const before = f.store.listBindings().find(binding => binding.id === 'copilot-cli')!;
    f.store.saveBinding({ ...before, modelIds: [f.other.id], defaultModelId: f.other.id });
    await manager.run('copilot-cli', before, () => f.apply()); await manager.undo('copilot-cli');
    expect(JSON.parse(readFileSync(target.providersPath, 'utf8')).models[0].id).toBe(f.model.alias);
    const script = '$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $acl=[IO.File]::GetAccessControl($env:MODELDOCK_TEST_PROFILE); $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])); if(!$acl.AreAccessRulesProtected -or $rules.Count -ne 2 -or @($rules | Where-Object {$_.IdentityReference.Value -notin @($sid,"S-1-5-18") -or $_.AccessControlType -ne "Allow" -or $_.FileSystemRights -ne "FullControl"}).Count){throw "Unexpected CLI profile ACL"}; "private"';
    const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8', env: { ...process.env, MODELDOCK_TEST_PROFILE: target.providersPath } });
    expect(result.trim()).toBe('private');
  });
});
