import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/main/store';
import { jetBrainsCompletionCandidates, jetBrainsCompletionParameters, nativeJetBrainsCompletion } from '../src/shared/jetbrains-completion';
import { switchSingleEntryMode, updateSingleEntryBinding } from '../src/shared/single-entry';

async function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'modeldock-completion-selection-'));
  const store = await Store.create(path);
  const ds = store.saveProvider({ name: 'Synthetic DS', kind: 'openai-compatible', presetId: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'SYNTHETIC_DS_KEY', enabled: true });
  const ark = store.saveProvider({ name: 'Synthetic Ark', kind: 'openai-compatible', presetId: 'volcengine-agent', baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3', apiKey: 'SYNTHETIC_ARK_KEY', enabled: true });
  const add = (providerId: string, upstreamId: string, alias: string) => store.saveModel({ providerId, upstreamId, alias, displayName: alias, wireApi: 'responses', contextWindow: 32768, tools: true, vision: false, enabled: true });
  const flash = add(ds.id, 'deepseek-flash', 'ds-flash'), pro = add(ds.id, 'deepseek-v4-pro', 'ds-pro'), kimi = add(ark.id, 'kimi-k3', 'ark-kimi');
  const save = (value: any) => { store.saveBinding(value); return store.listBindings().find(item => item.id === 'rider')!; };
  const binding = save({ id: 'rider', name: 'Rider', mode: 'direct', enabled: true, providerIds: [ds.id], modelSelection: 'all', modelIds: [], defaultModelId: flash.id, note: '' });
  return { store, ds, ark, flash, pro, kimi, binding, save, plan: (value: any) => jetBrainsCompletionParameters(value, store.listModels(), store.listProviders(), 18181), close: () => { store.close(); rmSync(path, { recursive: true, force: true }); } };
}

describe('JetBrains independent completion selection', () => {
  it('known native FIM uses Beta/real ID while keeping global Responses metadata', async () => {
    const f = await fixture(); try {
      expect(f.plan(f.binding)).toMatchObject({ configured: true, supported: true, baseUrl: 'https://api.deepseek.com/beta', model: 'deepseek-flash', schemaId: 'fim.generic' });
      expect(f.store.listModels().find(model => model.id === f.flash.id)?.wireApi).toBe('responses');
      expect(nativeJetBrainsCompletion(f.flash, { ...f.ds, baseUrl: 'https://api.deepseek.com.untrusted.invalid' })).toBeUndefined();
    } finally { f.close(); }
  });
  it('other supplier updates its target and model without claiming native completion support', async () => {
    const f = await fixture(); try {
      const next = f.save(updateSingleEntryBinding(f.binding, { providerIds: [f.ark.id], defaultModelId: f.kimi.id }, f.store.listModels(), f.store.listProviders()));
      expect(f.plan(next)).toMatchObject({ configured: true, supported: false, baseUrl: f.ark.baseUrl, model: 'kimi-k3', keyIdentity: `supplier:${f.ark.id}` });
    } finally { f.close(); }
  });
  it('aggregation completion model stays in the exact active mapping, and both modes remember their own choice', async () => {
    const f = await fixture(); try {
      let direct = f.save(updateSingleEntryBinding(f.binding, { connectionChoices: { direct: { providerId: f.ds.id, defaultModelId: f.flash.id, completionModelId: f.pro.id } } }, f.store.listModels(), f.store.listProviders()));
      let aggregate = switchSingleEntryMode(direct, 'aggregate', f.store.listModels(), f.store.listProviders());
      aggregate = f.save(updateSingleEntryBinding(aggregate, { enabled: true, providerIds: [f.ds.id, f.ark.id], modelSelection: 'selected', modelIds: [f.flash.id, f.kimi.id], defaultModelId: f.kimi.id,
        connectionChoices: { ...aggregate.connectionChoices, aggregate: { providerIds: [f.ds.id, f.ark.id], modelIds: [f.flash.id, f.kimi.id], defaultModelId: f.kimi.id, modelSelection: 'selected', completionModelId: f.flash.id } } }, f.store.listModels(), f.store.listProviders()));
      expect(jetBrainsCompletionCandidates(aggregate, f.store.listModels(), f.store.listProviders()).map(model => model.id)).toEqual([f.flash.id]);
      expect(f.plan(aggregate)).toMatchObject({ supported: true, baseUrl: 'http://127.0.0.1:18181/tool/rider/v1', model: 'ds-flash', keyIdentity: 'modeldock-local' });
      direct = f.save(switchSingleEntryMode(aggregate, 'direct', f.store.listModels(), f.store.listProviders()));
      expect(f.plan(direct).model).toBe('deepseek-v4-pro');
      aggregate = f.save(switchSingleEntryMode(direct, 'aggregate', f.store.listModels(), f.store.listProviders()));
      expect(f.plan(aggregate).model).toBe('ds-flash');
      const withoutDS = f.save(updateSingleEntryBinding(aggregate, { providerIds: [f.ark.id], modelIds: [f.kimi.id] }, f.store.listModels(), f.store.listProviders()));
      expect(withoutDS.connectionChoices?.aggregate?.completionModelId).toBeUndefined();
      expect(f.plan(withoutDS)).toMatchObject({ configured: true, supported: false, model: 'ark-kimi' });
    } finally { f.close(); }
  });
  it('deleted completion models are pruned and cannot revive an old endpoint or mapping', async () => {
    const f = await fixture(); try {
      f.save(updateSingleEntryBinding(f.binding, { connectionChoices: { direct: { providerId: f.ds.id, defaultModelId: f.flash.id, completionModelId: f.pro.id } } }, f.store.listModels(), f.store.listProviders()));
      f.store.deleteModel(f.pro.id);
      const next = f.store.listBindings().find(item => item.id === 'rider')!;
      expect(next.connectionChoices?.direct?.completionModelId).toBeUndefined();
      expect(f.plan(next)).toMatchObject({ model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/beta' });
    } finally { f.close(); }
  });
});
