import { describe, expect, it } from 'vitest';
import type { Model, Provider, ToolBinding, ToolId } from '../src/shared/types';
import { bindingConnectionPolicy, resolveBindingModels } from '../src/shared/bindings';

function provider(id: string, kind: Provider['kind'] = 'openai-compatible', enabled = true): Provider {
  return { id, name: id, kind, baseUrl: kind === 'openai-compatible' ? `https://${id}.example.test/v1` : kind === 'codex' ? 'https://chatgpt.com/backend-api/codex' : 'https://cli-chat-proxy.grok.com/v1', enabled, hasSecret: true, authStatus: 'ready', note: '' };
}
function model(id: string, providerId: string, enabled = true): Model {
  return { id, providerId, upstreamId: `upstream-${id}`, alias: `alias-${id}`, displayName: id, wireApi: 'responses', contextWindow: 0, tools: false, vision: false, enabled };
}
function binding(id: ToolId = 'codex', patch: Partial<ToolBinding> = {}): ToolBinding {
  return { id, name: id, enabled: true, mode: 'auto', providerIds: ['api-a', 'api-b', 'codex', 'grok'], modelIds: [], defaultModelId: '', note: '', ...patch };
}
const providers = [provider('api-a'), provider('api-b'), provider('codex', 'codex'), provider('grok', 'grok')];
const models = [model('a-one', 'api-a'), model('a-two', 'api-a'), model('b-one', 'api-b'), model('codex-one', 'codex'), model('grok-one', 'grok')];

describe('provider selections and preserved model-scoped bindings', () => {
  it('keeps an exact model selection closed when empty or when providers add models', () => {
    const selected = binding('codex', { mode: 'aggregate', providerIds: ['api-a', 'api-b'], modelSelection: 'selected', modelIds: ['a-one', 'b-one'] });
    const expanded = [...models, model('new-a', 'api-a'), model('new-b', 'api-b')];
    expect(resolveBindingModels(selected, expanded, providers).map(item => item.id)).toEqual(['a-one', 'b-one']);
    const cleared = { ...selected, modelIds: [], defaultModelId: '' };
    expect(resolveBindingModels(cleared, expanded, providers)).toEqual([]);
    expect(bindingConnectionPolicy(cleared, expanded, providers)).toEqual({ kind: 'aggregate', groups: [{ connection: 'local-managed', providerIds: ['api-a', 'api-b'], modelIds: [] }] });
  });
  it('treats explicit all as all provider models while absent metadata preserves an old partial filter', () => {
    const legacy = binding('opencode', { providerIds: ['api-a'], modelIds: ['a-one'] });
    expect(resolveBindingModels(legacy, models, providers).map(item => item.id)).toEqual(['a-one']);
    expect(resolveBindingModels({ ...legacy, modelSelection: 'all' }, models, providers).map(item => item.id)).toEqual(['a-one', 'a-two']);
  });
  it('auto includes all enabled models of every selected provider, including subsequently added models', () => {
    const selected = binding('opencode', { providerIds: ['api-a', 'codex'] });
    const before = resolveBindingModels(selected, models, providers);
    expect(before.map(item => item.id)).toEqual(['a-one', 'a-two', 'codex-one']);
    const after = resolveBindingModels(selected, [...models, model('a-new', 'api-a'), model('unselected-new', 'api-b')], providers);
    expect(after.map(item => item.id)).toEqual(['a-one', 'a-two', 'codex-one', 'a-new']);
    expect(selected.modelIds).toEqual([]);
  });
  it.each(['auto', 'aggregate'] as const)('%s keeps every selected provider while filtering disabled sources and models', mode => {
    const changedModels = [...models, model('disabled-model', 'api-a', false)];
    const changedProviders = providers.map(item => item.id === 'api-b' ? { ...item, enabled: false } : item);
    expect(resolveBindingModels(binding('vscode', { mode }), changedModels, changedProviders).map(item => item.id)).toEqual(['a-one', 'a-two', 'codex-one', 'grok-one']);
  });
  it('legacy direct resolves only its first selected source and never falls through to another disabled-source alternative', () => {
    const legacy = binding('codex', { mode: 'direct' });
    expect(resolveBindingModels(legacy, models, providers).map(item => item.id)).toEqual(['a-one', 'a-two']);
    expect(resolveBindingModels(legacy, models, providers.map(item => item.id === 'api-a' ? { ...item, enabled: false } : item))).toEqual([]);
  });
  it('preserves legacy partial model filters until an explicit provider checkbox edit clears them', () => {
    const legacy = binding('vscode', { mode: 'aggregate', providerIds: ['api-a', 'api-b'], modelIds: ['a-one', 'b-one'], defaultModelId: 'a-one' });
    const saved = structuredClone(legacy);
    expect(resolveBindingModels(legacy, models, providers).map(item => item.id)).toEqual(['a-one', 'b-one']);
    // Merely computing topology or opening the tool page must not migrate it.
    expect(bindingConnectionPolicy(legacy, models, providers).groups[0].modelIds).toEqual(['a-one', 'b-one']);
    expect(legacy).toEqual(saved);
    const userChanged = { ...legacy, mode: 'auto' as const, modelIds: [] };
    expect(resolveBindingModels(userChanged, models, providers).map(item => item.id)).toEqual(['a-one', 'a-two', 'b-one']);
  });
  it('never expands a model-scoped binding whose provider selection is absent', () => {
    const legacy = binding('copilot', { mode: undefined, providerIds: undefined, modelIds: ['a-one', 'codex-one'] });
    expect(resolveBindingModels(legacy, [...models, model('a-new', 'api-a')], providers).map(item => item.id)).toEqual(['a-one', 'codex-one']);
    expect(bindingConnectionPolicy(legacy, models, providers)).toEqual({ kind: 'aggregate', groups: [{ connection: 'local-managed', providerIds: ['api-a', 'codex'], modelIds: ['a-one', 'codex-one'] }] });
    expect(legacy.providerIds).toBeUndefined();
  });
  it('keeps filters in an auto binding too, so a non-checkbox save cannot silently add previously excluded models', () => {
    const selected = binding('dsh', { providerIds: ['api-a', 'api-b'], modelIds: ['b-one'] });
    expect(resolveBindingModels(selected, models, providers).map(item => item.id)).toEqual(['b-one']);
    expect(bindingConnectionPolicy(selected, models, providers).groups.map(group => group.modelIds)).toEqual([[], ['b-one']]);
  });
  it('disabled tools and explicit empty provider selections cannot resolve an available catalog', () => {
    expect(resolveBindingModels(binding('codex', { enabled: false }), models, providers)).toEqual([]);
    expect(resolveBindingModels(binding('codex', { providerIds: [] }), models, providers)).toEqual([]);
    expect(bindingConnectionPolicy(binding('vscode', { enabled: false }), models, providers).groups).toEqual([]);
  });
});

describe('automatic client connection topology without credentials', () => {
  it.each(['opencode', 'vscode', 'dsh', 'copilot'] as const)('%s legacy auto mode connects each selected provider separately', tool => {
    const selected = binding(tool, { mode: 'auto', modelSelection: 'selected', modelIds: ['a-one', 'b-one', 'codex-one', 'grok-one'] });
    expect(resolveBindingModels(selected, models, providers).map(item => item.id)).toEqual(['a-one', 'b-one', 'codex-one', 'grok-one']);
    expect(bindingConnectionPolicy(selected, models, providers)).toEqual({ kind: 'native', groups: [
      { connection: 'direct-api', providerIds: ['api-a'], modelIds: ['a-one'] },
      { connection: 'direct-api', providerIds: ['api-b'], modelIds: ['b-one'] },
      { connection: 'local-managed', providerIds: ['codex'], modelIds: ['codex-one'] },
      { connection: 'local-managed', providerIds: ['grok'], modelIds: ['grok-one'] },
    ] });
  });
  it('Codex uses the single selected API directly, keeping model identity untouched for the adapter', () => {
    const selected = binding('codex', { providerIds: ['api-a'] });
    expect(bindingConnectionPolicy(selected, models, providers)).toEqual({ kind: 'direct', groups: [{ connection: 'direct-api', providerIds: ['api-a'], modelIds: ['a-one', 'a-two'] }] });
    const resolved = resolveBindingModels(selected, models, providers);
    expect(resolved[0]).toMatchObject({ upstreamId: 'upstream-a-one', alias: 'alias-a-one' });
  });
  it.each([['api-a', 'api-b'], ['api-a', 'codex'], ['codex'], ['grok'], ['codex', 'grok']])('Codex routes selected sources %j through one managed endpoint', (...providerIds: string[]) => {
    // Vitest expands rows, so each row's source IDs arrive as positional args.
    const selected = binding('codex', { providerIds });
    const result = bindingConnectionPolicy(selected, models, providers);
    expect(result.kind).toBe('aggregate'); expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toEqual({ connection: 'local-managed', providerIds, modelIds: resolveBindingModels(selected, models, providers).map(item => item.id) });
  });
  it('Codex chooses aggregate topology when a second selected API has no models yet', () => {
    const selected = binding('codex', { providerIds: ['api-a', 'api-b'] });
    const onlyFirst = models.filter(item => item.providerId === 'api-a');
    expect(bindingConnectionPolicy(selected, onlyFirst, providers)).toEqual({ kind: 'aggregate', groups: [{ connection: 'local-managed', providerIds: ['api-a', 'api-b'], modelIds: ['a-one', 'a-two'] }] });
    expect(bindingConnectionPolicy(selected, [...onlyFirst, model('new-b', 'api-b')], providers).groups[0].modelIds).toEqual(['a-one', 'a-two', 'new-b']);
  });
  it.each(['opencode', 'vscode', 'dsh', 'copilot'] as const)('%s creates one native endpoint group per provider with subscription authorization kept local', tool => {
    expect(bindingConnectionPolicy(binding(tool), models, providers)).toEqual({ kind: 'native', groups: [
      { connection: 'direct-api', providerIds: ['api-a'], modelIds: ['a-one', 'a-two'] },
      { connection: 'direct-api', providerIds: ['api-b'], modelIds: ['b-one'] },
      { connection: 'local-managed', providerIds: ['codex'], modelIds: ['codex-one'] },
      { connection: 'local-managed', providerIds: ['grok'], modelIds: ['grok-one'] },
    ] });
  });
  it('never combines different API credentials or projects secret-bearing provider fields into its policy', () => {
    const extendedProviders = providers.map(item => ({ ...item, apiKey: `PRIVATE_KEY_${item.id}`, refreshToken: `PRIVATE_REFRESH_${item.id}` }));
    const result = bindingConnectionPolicy(binding('opencode'), models, extendedProviders);
    for (const group of result.groups.filter(group => group.connection === 'direct-api')) expect(group.providerIds).toHaveLength(1);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|apiKey|refreshToken/);
  });
  it('retains legacy aggregate and direct modes rather than migrating them merely by reading', () => {
    const aggregate = binding('opencode', { mode: 'aggregate', providerIds: ['api-a'] });
    expect(bindingConnectionPolicy(aggregate, models, providers)).toEqual({ kind: 'aggregate', groups: [{ connection: 'local-managed', providerIds: ['api-a'], modelIds: ['a-one', 'a-two'] }] });
    const direct = binding('vscode', { mode: 'direct', providerIds: ['codex'] });
    expect(bindingConnectionPolicy(direct, models, providers)).toEqual({ kind: 'direct', groups: [{ connection: 'local-managed', providerIds: ['codex'], modelIds: ['codex-one'] }] });
    expect(aggregate.mode).toBe('aggregate'); expect(direct.mode).toBe('direct');
  });
  it('does not assume unknown provider metadata means a direct API endpoint', () => {
    const selected = binding('codex', { providerIds: ['api-a'] });
    expect(bindingConnectionPolicy(selected, models)).toEqual({ kind: 'aggregate', groups: [{ connection: 'local-managed', providerIds: ['api-a'], modelIds: ['a-one', 'a-two'] }] });
    expect(bindingConnectionPolicy(binding('dsh', { providerIds: ['api-a'] }), models)).toEqual({ kind: 'native', groups: [{ connection: 'local-managed', providerIds: ['api-a'], modelIds: ['a-one', 'a-two'] }] });
  });
  it('does not mutate the saved providers, models or binding while computing routes', () => {
    const selected = binding('vscode'); const saved = structuredClone({ selected, providers, models });
    const result = bindingConnectionPolicy(selected, models, providers);
    result.groups[0].providerIds.push('mutated-result'); result.groups[0].modelIds.push('mutated-result');
    expect({ selected, providers, models }).toEqual(saved);
  });
});
