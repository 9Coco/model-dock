import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import initSqlJs from 'sql.js';
import { Store } from '../src/main/store';
import { bindingConnectionPolicy, resolveBindingModels } from '../src/shared/bindings';
import type { ToolBinding, ToolId } from '../src/shared/types';

const stores: Store[] = [], folders: string[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'modeldock-claude-binding-')); folders.push(dir);
  const store = await Store.create(dir); stores.push(store);
  const provider = store.saveProvider({ name: 'Messages mock', kind: 'openai-compatible', baseUrl: 'https://messages.example.test/anthropic', enabled: true, apiKey: 'synthetic-only' });
  const input = { providerId: provider.id, upstreamId: 'upstream-message', alias: 'local-message', displayName: 'Messages model', wireApi: 'messages' as const, contextWindow: 0, tools: true, vision: false, enabled: true };
  const model = store.saveModel(input);
  const chat = store.saveModel({ ...input, upstreamId: 'upstream-chat', alias: 'local-chat', wireApi: 'chat-completions' });
  const binding: ToolBinding = { id: 'claude-code', name: 'Claude Code', enabled: true, mode: 'direct', providerIds: [provider.id], modelIds: [], defaultModelId: model.id, note: '' };
  return { store, dir, provider, model, chat, binding };
}

describe('Claude Code binding boundaries', () => {
  it('persists the privacy choice without creating or applying client files', async () => {
    const f = await fixture();
    const sentinel = join(f.dir, 'settings.json'); writeFileSync(sentinel, '{"hooks":{"sentinel":true}}');
    expect(f.store.listBindings().find(b => b.id === 'claude-code')).toMatchObject({ enabled: false, mode: 'direct', claudeDisableTelemetry: true });
    f.store.saveBinding(f.binding);
    expect(resolveBindingModels(f.store.listBindings().find(b => b.id === 'claude-code')!, f.store.listModels(), f.store.listProviders())).toEqual([f.model]);
    f.store.saveBinding({ ...f.binding, claudeDisableTelemetry: false });
    f.store.close();
    const reopened = await Store.create(f.dir); stores.push(reopened);
    expect(reopened.listBindings().find(b => b.id === 'claude-code')).toMatchObject({ claudeDisableTelemetry: false });
    expect(readFileSync(sentinel, 'utf8')).toBe('{"hooks":{"sentinel":true}}');
    expect(existsSync(join(f.dir, '.claude', 'settings.json'))).toBe(false);
  });
  it('persists Messages auth independently and rejects unknown modes without changing credentials', async () => {
    const f = await fixture();
    expect(f.provider.messagesAuth).toBe('bearer');
    const updated = f.store.saveProvider({ ...f.provider, messagesAuth: 'api-key' });
    expect(updated.messagesAuth).toBe('api-key');
    expect(f.store.getSecret(f.provider.id)?.apiKey).toBe('synthetic-only');
    expect(() => f.store.saveProvider({ ...updated, messagesAuth: 'unknown' as 'api-key' })).toThrow('鉴权');
    expect(f.store.getProvider(f.provider.id)?.messagesAuth).toBe('api-key');
    f.store.close(); const reopened = await Store.create(f.dir); stores.push(reopened);
    expect(reopened.getProvider(f.provider.id)?.messagesAuth).toBe('api-key');
  });
  it('migrates older internal metadata without changing prior bindings or client settings', async () => {
    const f = await fixture(); f.store.saveBinding({ ...f.binding, id: 'opencode', defaultModelId: f.chat.id });
    const before = f.store.listBindings().filter(b => b.id !== 'claude-code'); f.store.close();
    const SQL = await initSqlJs(); const db = new SQL.Database(readFileSync(join(f.dir, 'modeldock.sqlite')));
    db.run("DELETE FROM bindings WHERE id='claude-code'"); db.run('ALTER TABLE bindings DROP COLUMN claude_disable_telemetry');
    writeFileSync(join(f.dir, 'modeldock.sqlite'), db.export()); db.close();
    const migrated = await Store.create(f.dir); stores.push(migrated);
    expect(migrated.listBindings().filter(b => b.id !== 'claude-code')).toEqual(before);
    expect(migrated.listBindings().find(b => b.id === 'claude-code')).toMatchObject({ enabled: false, claudeDisableTelemetry: true });
  });
  it('rejects multiple direct providers, unavailable sources and incompatible direct defaults', async () => {
    const f = await fixture();
    const another = f.store.saveProvider({ name: 'Other API', kind: 'openai-compatible', baseUrl: 'https://other.example.test', enabled: true, apiKey: 'synthetic-only' });
    const subscription = f.store.saveProvider({ name: 'Subscription', kind: 'codex', baseUrl: 'https://chatgpt.com/backend-api/codex', enabled: true });
    for (const binding of [{ ...f.binding, providerIds: [f.provider.id, another.id] }, { ...f.binding, providerIds: [subscription.id] }, { ...f.binding, defaultModelId: f.chat.id }, { ...f.binding, modelIds: [f.chat.id] }]) expect(() => f.store.saveBinding(binding)).toThrow();
    expect(() => f.store.saveBinding({ ...f.binding, id: 'opencode', defaultModelId: f.chat.id, claudeDisableTelemetry: true })).toThrow('隐私选项');
    expect(() => f.store.saveModel({ ...f.model, id: undefined, providerId: subscription.id, alias: 'subscription-messages' })).toThrow('API');
  });
  it('keeps Messages out of every existing OpenAI tool adapter and never routes Claude through the gateway', async () => {
    const f = await fixture();
    for (const tool of ['codex', 'opencode', 'dsh', 'vscode', 'copilot'] as ToolId[]) {
      expect(resolveBindingModels({ ...f.binding, id: tool, mode: 'auto' }, f.store.listModels(), f.store.listProviders())).toEqual([f.chat]);
    }
    expect(bindingConnectionPolicy(f.binding, f.store.listModels(), f.store.listProviders())).toEqual({ kind: 'direct', groups: [{ connection: 'direct-api', providerIds: [f.provider.id], modelIds: [f.model.id] }] });
    expect(bindingConnectionPolicy({ ...f.binding, mode: 'aggregate' }, f.store.listModels(), f.store.listProviders()).groups[0]).toMatchObject({ connection: 'local-managed', modelIds: [f.model.id, f.chat.id] });
  });
});
