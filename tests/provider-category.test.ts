import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Store } from '../src/main/store';
import { isRelayProvider, providerCategory, providerPresets } from '../src/shared/presets';

it('lists account relays only among subscription presets while retaining their transport', () => {
  const subscriptionIds = providerPresets.filter(preset => preset.category === 'subscription').map(preset => preset.id);
  expect(subscriptionIds).toEqual(expect.arrayContaining(['codex-subscription', 'copilot-subscription', 'grok-build', 'trae-cn-relay', 'jetbrains-central']));
  for (const preset of providerPresets) {
    const provider = { kind: preset.kind, presetId: preset.id };
    expect(providerCategory(provider)).toBe(preset.category);
    if (isRelayProvider(provider)) expect(preset.kind).toBe('openai-compatible');
  }
  expect(providerCategory({ kind: 'openai-compatible' })).toBe('api');
  expect(providerCategory({ kind: 'codex' })).toBe('subscription');
});

it('reclassifies saved relays without changing credentials, models or tool bindings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'modeldock-category-'));
  let store = await Store.create(directory);
  try {
    const relay = store.saveProvider({ name: 'Existing TRAE', kind: 'openai-compatible', presetId: 'trae-cn-relay', relayMode: 'manual', baseUrl: 'http://localhost:18999/v1', apiKey: 'synthetic-existing-relay-key', enabled: true });
    const model = store.saveModel({ providerId: relay.id, upstreamId: 'ExistingModel', alias: 'existing-relay', displayName: 'Existing Model', wireApi: 'chat-completions', contextWindow: 64000, tools: true, vision: false, enabled: true });
    store.saveBinding({ ...store.listBindings().find(item => item.id === 'junie')!, enabled: true, mode: 'direct', providerIds: [relay.id], modelIds: [model.id], defaultModelId: model.id, modelSelection: 'selected' });
    const binding = store.listBindings().find(item => item.id === 'junie');
    store.close();
    store = await Store.create(directory);
    const reopened = store.getProvider(relay.id)!;
    expect(providerCategory(reopened)).toBe('subscription');
    expect(reopened).toEqual(relay);
    expect(store.getSecret(relay.id)?.apiKey).toBe('synthetic-existing-relay-key');
    expect(store.listModels().find(item => item.id === model.id)).toEqual(model);
    expect(store.listBindings().find(item => item.id === 'junie')).toEqual(binding);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
