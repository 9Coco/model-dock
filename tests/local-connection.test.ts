import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Model, ModelDockApi, Provider, Snapshot } from '../src/shared/types';
import { isPublishedGatewayModel, localGatewayBaseUrl, localModelStatus } from '../src/shared/local-connection';
import { SubscriptionConnection } from '../src/renderer/SubscriptionConnection';
import { AggregatePanel } from '../src/renderer/AggregatePanel';
import { ConnectionPrinciples } from '../src/renderer/ConnectionPrinciples';

const provider: Provider = { id: 'subscription', name: 'Synthetic subscription', kind: 'codex', presetId: 'codex-subscription', baseUrl: 'https://remote.synthetic.invalid/backend', enabled: true, hasSecret: true, authStatus: 'ready', note: '' };
const model: Model = { id: 'model', providerId: provider.id, alias: 'local-alias', upstreamId: 'PRIVATE_UPSTREAM_MODEL', displayName: 'Synthetic model', wireApi: 'responses', enabled: true, contextWindow: 64000, tools: true, vision: false };
const data: Snapshot = { providers: [provider], models: [model], bindings: [], logs: [], dataDir: '', version: '', gateway: { running: true, host: '127.0.0.1', port: 19234, baseUrl: 'http://127.0.0.1:19234/v1', requests: 0, lastError: '' }, gatewayExposure: { excludedProviderIds: [], excludedModelIds: [] } };
const copy = vi.fn(async () => {}), notify = vi.fn(), onService = vi.fn();

describe('subscription local calling parameters', () => {
  it('uses the implemented general gateway entrance and never invents a supplier route', () => {
    expect(localGatewayBaseUrl(data)).toBe('http://127.0.0.1:19234/v1');
    const api = { revealGatewayKey: vi.fn(), copyGatewayKey: vi.fn(), revealProviderKey: vi.fn() } as unknown as ModelDockApi;
    const html = renderToStaticMarkup(createElement(SubscriptionConnection, { data, provider, api, secretRevision: 0, copy, notify, onService }));
    expect(html).toContain('http://127.0.0.1:19234/v1');
    expect(html).toContain('local-alias');
    expect(html).toContain('MODELDOCK_API_KEY');
    expect(html).toContain('/v1/responses');
    expect(html).not.toContain('/provider/');
    expect(html).not.toContain(provider.baseUrl);
    expect(html).not.toContain(model.upstreamId);
    expect(api.revealGatewayKey).not.toHaveBeenCalled();
    expect(api.revealProviderKey).not.toHaveBeenCalled();
  });

  it('keeps publication and service readiness separate and honors source and model exclusions', () => {
    expect(isPublishedGatewayModel(data, provider, model)).toBe(true);
    expect(localModelStatus(data, provider, model)).toBe('已发布');
    const stopped = { ...data, gateway: { ...data.gateway, running: false } };
    expect(isPublishedGatewayModel(stopped, provider, model)).toBe(true);
    expect(localModelStatus(stopped, provider, model)).toBe('待启动本地服务');
    const excludedModel = { ...data, gatewayExposure: { excludedProviderIds: [], excludedModelIds: [model.id] } };
    expect(isPublishedGatewayModel(excludedModel, provider, model)).toBe(false);
    expect(localModelStatus(excludedModel, provider, model)).toBe('模型未发布');
    const excludedSource = { ...data, gatewayExposure: { excludedProviderIds: [provider.id], excludedModelIds: [] } };
    expect(isPublishedGatewayModel(excludedSource, provider, model)).toBe(false);
    expect(localModelStatus(excludedSource, provider, model)).toBe('供应商未加入本地接口');
    expect(isPublishedGatewayModel(data, { ...provider, authStatus: 'missing' }, model)).toBe(false);
    expect(isPublishedGatewayModel(data, { ...provider, hasSecret: false }, model)).toBe(false);
    expect(isPublishedGatewayModel(data, provider, { ...model, providerId: 'another-source' })).toBe(false);
  });

  it('only advertises a Messages model in the general catalog when its TRAE relay supports it', () => {
    const messages = { ...model, wireApi: 'messages' as const };
    expect(isPublishedGatewayModel(data, provider, messages)).toBe(false);
    expect(localModelStatus(data, provider, messages)).toContain('Messages');
    const trae = { ...provider, kind: 'openai-compatible' as const, presetId: 'trae-cn-relay' as const };
    expect(isPublishedGatewayModel(data, trae, messages)).toBe(true);
  });

  it('groups relays with subscriptions and keeps remote connection details inside the folded explanation', () => {
    const apiProvider: Provider = { ...provider, id: 'api', kind: 'openai-compatible', presetId: 'custom' };
    const relay: Provider = { ...provider, id: 'relay', kind: 'openai-compatible', presetId: 'jetbrains-central' };
    const snapshot = { ...data, providers: [apiProvider, provider, relay] };
    const html = renderToStaticMarkup(createElement(AggregatePanel, { data: snapshot, api: undefined, secretRevision: 0, search: '', onSearch: vi.fn(), onChanged: async () => {}, onProvider: vi.fn(), onService, copy, notify, showServiceSummary: false }));
    expect(html).toContain('data-aggregate-category="api"');
    expect(html).toContain('data-aggregate-category="subscription"');
    expect(html).not.toContain('class="aggregate-strip"');
    expect(html).not.toContain(provider.baseUrl);
    expect(html).not.toContain(model.upstreamId);
    const explanation = renderToStaticMarkup(createElement(ConnectionPrinciples, { providers: [provider, relay], models: [model] }));
    expect(explanation).toContain(provider.baseUrl);
    expect(explanation).toContain('JetBrains Central CLI');
    expect(explanation).toContain('TRAE');
    expect(explanation).toContain('data-connection-model-mapping');
    expect(explanation).toContain(model.alias);
    expect(explanation).toContain(model.upstreamId);
    expect(explanation.match(/<details[^>]*>/)?.[0]).not.toContain('open=');
  });
});
