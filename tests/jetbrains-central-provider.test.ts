import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Store } from '../src/main/store';
import { OAuthManager } from '../src/main/oauth';
import { ModelCatalog } from '../src/main/catalog';
import { buildConfig } from '../src/main/adapters';
import { JETBRAINS_RELAY_BASE_URL } from '../src/shared/presets';

it('persists the local Central supplier and generates the actual VS Code Chat endpoint with its relay key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'modeldock-central-provider-'));
  const store = await Store.create(directory);
  const oauth = new OAuthManager(store, { openExternal: async () => { throw new Error('Unexpected browser login'); } });
  try {
    const apiKey = 'synthetic-key-for-the-local-bridge';
    const upstreamId = 'anthropic/fixture-model';
    expect(store.listProviders().some(provider => provider.presetId === 'jetbrains-central')).toBe(false);
    const input = { presetId: 'jetbrains-central', kind: 'openai-compatible', baseUrl: JETBRAINS_RELAY_BASE_URL,
      name: 'JetBrains AI', enabled: true, apiKey } as const;
    expect(() => store.saveProvider({ ...input, baseUrl: 'http://127.0.0.1:18080/v1' })).toThrow(/固定本机/);
    expect(() => store.saveProvider({ ...input, claudeBaseUrl: 'https://example.org/' })).toThrow(/固定本机/);
    const provider = store.saveProvider(input);
    const catalog = new ModelCatalog(store, oauth, { fetch: async (url, init) => {
      expect(String(url)).toBe(JETBRAINS_RELAY_BASE_URL + '/models');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ' + apiKey);
      return Response.json({ object: 'list', data: [{ id: upstreamId, name: 'Fixture model',
        context_window: 65536, max_output_tokens: 4096, input_modalities: ['text'], supports_tools: true }] });
    } });
    expect((await catalog.discover(provider.id)).models).toMatchObject([{ upstreamId, wireApi: 'chat-completions' }]);
    const { added: [model] } = catalog.addSelected(provider.id, [{ upstreamId }]);
    expect(() => store.saveModel({ ...model, wireApi: 'responses' })).toThrow(/Chat Completions/);
    const binding = store.listBindings().find(item => item.id === 'vscode')!;
    for (const mode of ['direct', 'aggregate'] as const) {
      store.saveBinding({ ...binding, mode, enabled: true, providerIds: [provider.id], modelSelection: 'selected', modelIds: [model.id], defaultModelId: model.id });
      const [group] = JSON.parse(buildConfig(store, 'vscode', 19191, true).content);
      const direct = mode === 'direct';
      expect(group.vendor).toBe('customendpoint');
      expect(group.models).toMatchObject([{ id: direct ? upstreamId : model.alias, toolCalling: true,
        url: (direct ? JETBRAINS_RELAY_BASE_URL : 'http://127.0.0.1:19191/tool/vscode/v1') + '/chat/completions',
        requestHeaders: { authorization: 'Bearer ' + (direct ? apiKey : store.gatewayKey()) } }]);
    }
  } finally { oauth.dispose(); store.close(); await rm(directory, { recursive: true, force: true }); }
});
