import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse } from 'jsonc-parser';
import { applyConfig, buildConfig } from '../src/main/adapters';
import { openCodeConfigTargets } from '../src/main/opencode-paths';
import { ToolSyncUndoManager, toolSyncUndoKey } from '../src/main/tool-sync-undo';
import { restoreOfficialConfig } from '../src/main/tool-restore';
import { toolCategories, toolCategoryFor } from '../src/shared/tool-categories';
import { Store } from '../src/main/store';
import { Gateway } from '../src/main/gateway';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const action of cleanup.splice(0).reverse()) await action(); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'modeldock-opencode-desktop-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = await Store.create(join(root, 'data')); cleanup.push(() => store.close());
  const provider = store.saveProvider({ name: 'Synthetic API', kind: 'openai-compatible', baseUrl: 'https://fixture.example/v1', enabled: true, apiKey: 'synthetic-opencode-api-key' });
  const model = store.saveModel({ providerId: provider.id, upstreamId: 'fixture-chat', alias: 'fixture-local', displayName: 'Fixture Chat', wireApi: 'chat-completions', contextWindow: 32000, tools: true, vision: true, enabled: true });
  const activate = (id: 'opencode' | 'opencode-desktop', mode: 'direct' | 'aggregate' = 'aggregate') => {
    const before = store.listBindings().find(binding => binding.id === id)!;
    store.saveBinding({ ...before, enabled: true, mode, providerIds: [provider.id], modelIds: [model.id], modelSelection: 'selected', defaultModelId: model.id });
    return before;
  };
  const target = join(root, '.config', 'opencode', 'opencode.jsonc'), backups = join(root, 'backups');
  const original = '// preserve user comments\n{"provider":{"foreign":{"name":"Keep"}},"mcp":{"keep":{"type":"local","command":["fixture"]}},"permission":{"bash":"ask"}}';
  mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, original);
  const apply = (tool: 'opencode' | 'opencode-desktop') => applyConfig(store, tool, 18181, root, backups, root);
  const manager = new ToolSyncUndoManager(store, { appData: root, homeDirectory: root });
  return { root, store, provider, model, target, backups, original, activate, apply, manager };
}

describe('OpenCode Desktop and TUI targets', () => {
  it('registers a disabled independent desktop binding and exhaustively categorizes all tools', async () => {
    const f = await fixture();
    const tui = f.activate('opencode');
    expect(f.store.listBindings().find(b => b.id === 'opencode-desktop')).toMatchObject({ enabled: false, providerIds: [], modelIds: [] });
    expect(f.store.listBindings().find(b => b.id === 'opencode')).not.toEqual(tui);
    expect(readFileSync(f.target, 'utf8')).toBe(f.original);
    const bindings = f.store.listBindings();
    expect(toolCategories.map(c => bindings.filter(b => toolCategoryFor(b.id) === c.id).length)).toEqual([5, 4, 4]);
    expect(bindings.every(b => !!toolCategoryFor(b.id))).toBe(true);
  });
  it('keeps Desktop on global XDG while TUI honors explicit file/directory and rejects ambiguous relative or inline overrides', async () => {
    const f = await fixture(), configHome = join(f.root, '配置 空间'), file = join(f.root, '终端.jsonc'), dir = join(f.root, 'terminal-config');
    expect(openCodeConfigTargets('opencode-desktop', f.root, { configHome, openCodeConfigFile: file, openCodeConfigDir: dir }).target).toBe(join(configHome, 'opencode', 'opencode.json'));
    expect(openCodeConfigTargets('opencode', f.root, { openCodeConfigFile: file }).paths).toEqual([file]);
    expect(openCodeConfigTargets('opencode', f.root, { openCodeConfigFile: file, openCodeConfigDir: dir }).target).toBe(join(dir, 'opencode.json'));
    expect(() => openCodeConfigTargets('opencode', f.root, { openCodeConfigFile: 'relative.json' })).toThrow('绝对路径');
    expect(() => openCodeConfigTargets('opencode', f.root, { openCodeConfigContent: '{}' })).toThrow('内联配置');
    expect(openCodeConfigTargets('opencode-desktop', f.root, { openCodeConfigContent: '{}' }).target).toBe(f.target);
  });
  it('previews a redacted desktop-specific endpoint, then backs up and merges JSONC without touching unrelated configuration', async () => {
    const f = await fixture(); const before = f.activate('opencode-desktop');
    const preview = buildConfig(f.store, 'opencode-desktop', 18181, false, f.root);
    expect(preview.filename).toBe('modeldock-opencode-desktop.json'); expect(preview.instructions).toContain(f.target);
    expect(preview.content).toContain('/tool/opencode-desktop/v1'); expect(preview.content).not.toContain(f.store.gatewayKey());
    await f.manager.run('opencode-desktop', before, () => f.apply('opencode-desktop'));
    expect(readdirSync(f.backups).some(name => readFileSync(join(f.backups, name), 'utf8') === f.original)).toBe(true);
    const updated = readFileSync(f.target, 'utf8'); expect(updated).toContain('// preserve user comments');
    expect(parse(updated)).toMatchObject({ mcp: parse(f.original).mcp, permission: { bash: 'ask' }, provider: { foreign: { name: 'Keep' }, modeldock: { options: { baseURL: 'http://127.0.0.1:18181/tool/opencode-desktop/v1' } } } });
    expect(f.store.listBindings().find(b => b.id === 'opencode')?.enabled).toBe(false);
    await f.manager.undo('opencode-desktop'); expect(readFileSync(f.target, 'utf8')).toBe(f.original);
  });
  it('uses real upstream IDs and API keys for direct mode', async () => {
    const f = await fixture(); f.activate('opencode-desktop', 'direct');
    const preview = buildConfig(f.store, 'opencode-desktop', 18181, false, f.root);
    expect(preview.content).not.toContain('synthetic-opencode-api-key');
    const config = parse(buildConfig(f.store, 'opencode-desktop', 18181, true, f.root).content);
    expect(config.model).toBe(`modeldock-${f.provider.id}/fixture-chat`);
    expect(config.provider[`modeldock-${f.provider.id}`].options).toEqual({ baseURL: 'https://fixture.example/v1', apiKey: 'synthetic-opencode-api-key' });
  });
  it.each(['opencode', 'opencode-desktop'] as const)('%s keeps mixed native providers, independent credentials and exact model selections when adding or removing a source', async tool => {
    const f = await fixture(); f.activate(tool, 'direct');
    const other = f.store.saveProvider({ name: 'Second API', kind: 'openai-compatible', baseUrl: 'https://second.example/v1', enabled: true, apiKey: 'synthetic-second-key' });
    const subscription = f.store.saveProvider({ name: 'Subscription', kind: 'codex', presetId: 'codex-subscription', baseUrl: 'https://chatgpt.com/backend-api/codex', enabled: true });
    f.store.setSecret(subscription.id, { accessToken: 'synthetic-never-export-oauth', refreshToken: 'synthetic-never-export-refresh' });
    const secondModel = f.store.saveModel({ ...f.model, id: undefined, providerId: other.id, alias: 'second-local' });
    const subModel = f.store.saveModel({ ...f.model, id: undefined, providerId: subscription.id, upstreamId: 'native-subscription', alias: 'subscription-local', wireApi: 'responses' });
    f.store.saveModel({ ...f.model, id: undefined, alias: 'unselected-local', upstreamId: 'unselected-upstream' });
    const before = f.store.listBindings().find(binding => binding.id === tool)!;
    const selection = { ...before, providerIds: [f.provider.id, other.id, subscription.id], modelIds: [f.model.id, secondModel.id, subModel.id], defaultModelId: secondModel.id };
    f.store.saveBinding(selection);
    const ids = selection.providerIds.map(id => `modeldock-${id}`);
    const config = parse(buildConfig(f.store, tool, 18181, true, f.root).content);
    expect(config.enabled_providers).toEqual(ids);
    expect(config.model).toBe(`${ids[1]}/${secondModel.upstreamId}`);
    expect(config.provider[ids[0]].options).toEqual({ baseURL: f.provider.baseUrl, apiKey: 'synthetic-opencode-api-key' });
    expect(config.provider[ids[1]].options).toEqual({ baseURL: other.baseUrl, apiKey: 'synthetic-second-key' });
    expect(config.provider[ids[2]].options).toEqual({ baseURL: `http://127.0.0.1:18181/tool/${tool}/v1`, apiKey: f.store.gatewayKey() });
    expect(config.provider[ids[2]].models[subModel.alias].provider.npm).toBe('@ai-sdk/openai');
    expect(JSON.stringify(config)).not.toMatch(/never-export|unselected-upstream/);
    expect(buildConfig(f.store, tool, 18181, false, f.root).content).not.toMatch(/synthetic-opencode-api-key|synthetic-second-key|never-export/);
    await f.manager.run(tool, before, () => f.apply(tool));
    const written = readFileSync(f.target, 'utf8');
    expect(written).toContain('// preserve user comments');
    expect(parse(written)).toMatchObject({ model: config.model, provider: { ...config.provider, foreign: { name: 'Keep' } }, mcp: parse(f.original).mcp, permission: { bash: 'ask' } });
    f.store.saveBinding({ ...selection, providerIds: [f.provider.id, subscription.id], modelIds: [f.model.id, subModel.id], defaultModelId: f.model.id });
    f.apply(tool);
    const removed = parse(readFileSync(f.target, 'utf8'));
    expect(removed.enabled_providers).toEqual([ids[0], ids[2]]);
    expect(removed.provider[ids[1]]).toBeUndefined();
    expect(removed.provider[ids[0]]).toEqual(config.provider[ids[0]]);
    expect(removed.provider[ids[2]]).toEqual(config.provider[ids[2]]);
    expect(removed.provider.foreign).toEqual({ name: 'Keep' });
    f.store.saveBinding(selection);
    f.store.deleteProvider(other.id);
    expect(f.store.listBindings().find(binding => binding.id === tool)).toMatchObject({ enabled: true, mode: 'direct', providerIds: [f.provider.id, subscription.id], modelIds: [f.model.id, subModel.id] });
    expect(parse(buildConfig(f.store, tool, 18181, true, f.root).content).enabled_providers).toEqual([ids[0], ids[2]]);
  });
  it('rejects stale shared-file undo after the other product synchronizes, and restores exactly after its own undo', async () => {
    const f = await fixture();
    await f.manager.run('opencode', f.activate('opencode'), () => f.apply('opencode'));
    const tuiContent = readFileSync(f.target, 'utf8');
    await f.manager.run('opencode-desktop', f.activate('opencode-desktop'), () => f.apply('opencode-desktop'));
    expect(f.manager.status('opencode').available).toBe(false);
    await expect(f.manager.undo('opencode')).rejects.toThrow('修改');
    await f.manager.undo('opencode-desktop'); expect(readFileSync(f.target, 'utf8')).toBe(tuiContent);
    expect(f.manager.status('opencode').available).toBe(true);
  });
  it('uses the same custom TUI path for apply, undo and restore, leaving Desktop untouched', async () => {
    const f = await fixture(), file = join(f.root, '自定义 终端.jsonc'), options = { openCodeConfigFile: file };
    const manager = new ToolSyncUndoManager(f.store, { appData: f.root, homeDirectory: f.root, ...options });
    await manager.run('opencode', f.activate('opencode'), () => applyConfig(f.store, 'opencode', 18181, f.root, f.backups, f.root, options));
    expect(existsSync(file)).toBe(true); expect(readFileSync(f.target, 'utf8')).toBe(f.original);
    await manager.undo('opencode'); expect(existsSync(file)).toBe(false);
    f.activate('opencode'); applyConfig(f.store, 'opencode', 18181, f.root, f.backups, f.root, options);
    expect(await restoreOfficialConfig(f.store, 'opencode', f.root, f.backups, f.root, options)).toBe(file);
    expect(readFileSync(f.target, 'utf8')).toBe(f.original);
  });
  it('rolls back the file when saving the encrypted checkpoint fails', async () => {
    const f = await fixture(), before = f.activate('opencode-desktop');
    const write = f.store.setManagedState.bind(f.store); let failed = false;
    vi.spyOn(f.store, 'setManagedState').mockImplementation((key, value) => {
      if (key === toolSyncUndoKey('opencode-desktop') && value && !failed) { failed = true; throw new Error('synthetic disk failure'); }
      write(key, value);
    });
    await expect(f.manager.run('opencode-desktop', before, () => f.apply('opencode-desktop'))).rejects.toThrow('恢复');
    expect(readFileSync(f.target, 'utf8')).toBe(f.original);
  });
  it.each(['{"provider":[]}', '{broken', '{"providers":{"modeldock":{"settings":{}}}}'])('refuses malformed or shadowing native configuration without mutation: %s', async raw => {
    const f = await fixture(); f.activate('opencode-desktop'); writeFileSync(f.target, raw);
    expect(() => f.apply('opencode-desktop')).toThrow(); expect(readFileSync(f.target, 'utf8')).toBe(raw); expect(existsSync(f.backups)).toBe(false);
  });
  it('desktop cleanup preserves foreign models, MCP and permissions', async () => {
    const f = await fixture(); f.activate('opencode-desktop'); f.apply('opencode-desktop');
    await restoreOfficialConfig(f.store, 'opencode-desktop', f.root, f.backups, f.root);
    expect(parse(readFileSync(f.target, 'utf8'))).toEqual(parse(f.original));
  });
  it('forwards mock inference through the existing desktop tool-scoped gateway and rejects unselected models', async () => {
    const f = await fixture(); f.activate('opencode-desktop');
    const upstream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body)).model).toBe(f.model.upstreamId);
      return new Response(JSON.stringify({ id: 'fixture', choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } });
    });
    const gateway = new Gateway(f.store, { fetch: upstream }); await gateway.start(0); cleanup.push(async () => { await gateway.stop(); });
    const origin = new URL(gateway.status().baseUrl).origin, headers = { authorization: `Bearer ${f.store.gatewayKey()}`, 'content-type': 'application/json' };
    const request = (model: string, auth = headers) => fetch(`${origin}/tool/opencode-desktop/v1/chat/completions`, { method: 'POST', headers: auth, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'fixture' }] }) });
    const reply = await request(f.model.alias); expect(reply.status).toBe(200); expect((await reply.json()).choices[0].message.content).toBe('OK');
    const denied = await request('not-selected'); expect(denied.status).toBeGreaterThanOrEqual(400); await denied.text();
    const unauthorized = await request(f.model.alias, { ...headers, authorization: 'Bearer invalid' }); expect(unauthorized.status).toBe(401); await unauthorized.text();
    expect(upstream).toHaveBeenCalledTimes(1);
  });
  it.each(['opencode', 'opencode-desktop'] as const)('%s routes both selected direct-mode sources with exact authentication and rejects removed models', async tool => {
    const f = await fixture(); f.activate(tool, 'direct');
    const other = f.store.saveProvider({ name: 'Second route', kind: 'openai-compatible', baseUrl: 'https://second-route.example/v1', enabled: true, apiKey: 'synthetic-route-key' });
    const model = f.store.saveModel({ ...f.model, id: undefined, providerId: other.id, alias: 'second-route-local' });
    const binding = f.store.listBindings().find(value => value.id === tool)!;
    f.store.saveBinding({ ...binding, providerIds: [f.provider.id, other.id], modelIds: [f.model.id, model.id] });
    const upstream = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const second = String(url).startsWith(other.baseUrl);
      expect(String(url)).toBe(`${second ? other.baseUrl : f.provider.baseUrl}/chat/completions`);
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${second ? 'synthetic-route-key' : 'synthetic-opencode-api-key'}`);
      expect(JSON.parse(String(init?.body)).model).toBe(f.model.upstreamId);
      return new Response(JSON.stringify({ id: 'fixture', choices: [{ message: { role: 'assistant', content: second ? 'B' : 'A' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } });
    });
    const gateway = new Gateway(f.store, { fetch: upstream }); await gateway.start(0); cleanup.push(async () => { await gateway.stop(); });
    const origin = new URL(gateway.status().baseUrl).origin;
    const request = (alias: string) => fetch(`${origin}/tool/${tool}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${f.store.gatewayKey()}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: alias, messages: [{ role: 'user', content: 'synthetic' }] }) });
    for (const [alias, text] of [[f.model.alias, 'A'], [model.alias, 'B']]) {
      const result = await request(alias); expect(result.status).toBe(200); expect((await result.json()).choices[0].message.content).toBe(text);
    }
    f.store.saveBinding(binding);
    const removed = await request(model.alias); expect(removed.status).toBe(403); await removed.text();
    expect(upstream).toHaveBeenCalledTimes(2);
  });
});
