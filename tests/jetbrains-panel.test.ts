import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { JetBrainsPanel } from '../src/renderer/JetBrainsPanel';
import type { Model, ModelDockApi } from '../src/shared/types';

const models: Model[] = Array.from({ length: 14 }, (_, index) => ({
  id: `model-${index}`, providerId: `provider-${index}`, upstreamId: `chat-${index}`, alias: `alias-${index}`,
  displayName: `Model ${index}`, wireApi: 'responses', contextWindow: 128000, tools: true, vision: false, enabled: true,
}));
const noOp = async () => {};
function panel(overrides: Partial<Parameters<typeof JetBrainsPanel>[0]> = {}) {
  return renderToStaticMarkup(createElement(JetBrainsPanel, {
    tool: 'rider', aggregate: true, plugin: 'ai-assistant', onPluginChange: noOp, api: {} as ModelDockApi, models, defaultModel: models[0],
    gateway: { running: true, host: '127.0.0.1', port: 18181, baseUrl: 'http://127.0.0.1:18181', requests: 0, lastError: '' },
    completion: { configured: true, supported: false, mode: 'aggregate', requestedModelId: models[0].id,
      baseUrl: 'http://127.0.0.1:18181/tool/rider/v1', model: models[0].alias, schemaId: 'fim.generic', reason: '请选择支持 FIM 的模型。' },
    completionModels: [models[12], models[13]], completionSelection: '', onCompletionModelSelect: noOp,
    busy: false, notify: () => {}, onRefresh: noOp, onStatusRefresh: async () => undefined,
    onPreview: noOp, onExport: noOp, onApply: noOp, ...overrides,
  }));
}
function keyButton(html: string) { return html.match(/<button[^>]*data-action="jetbrains-copy-completion-key"[^>]*>/)?.[0]; }

describe('JetBrains completion capability boundary in the panel', () => {
  it('keeps chat mapping distinct from FIM candidates and marks an unsupported follow-chat selection', () => {
    const html = panel();
    expect(html).toContain('聊天已映射 14 个模型，其中 2 个已确认支持原生 FIM 补全');
    const select = html.match(/<select[^>]*data-action="jetbrains-completion-model"[^>]*>(.*?)<\/select>/)?.[1];
    expect(select?.match(/<option/g)).toHaveLength(3);
    expect(select).toContain('跟随聊天默认模型（当前模型未确认原生补全支持）');
    expect(html).toContain('同步后保持停用');
    expect(keyButton(html)).toContain('disabled=""');
  });
  it('allows independent completion key setup only for a supported completion model', () => {
    const html = panel({ completionSelection: models[12].id,
      completion: { configured: true, supported: true, mode: 'aggregate', requestedModelId: models[12].id,
        baseUrl: 'http://127.0.0.1:18181/tool/rider/v1', model: models[12].alias, schemaId: 'fim.generic', maxOutputTokens: 4096 } });
    expect(keyButton(html)).not.toContain('disabled');
    expect(html).toContain('需在 IDE 单独确认密钥和启用');
    expect(html).not.toContain('当前模型未确认原生补全支持');
  });
  it('does not offer completion key copying before a source is configured', () => {
    expect(keyButton(panel({ models: [], defaultModel: undefined, completionModels: [],
      completion: { configured: false, supported: false, mode: 'aggregate', requestedModelId: '' } }))).toContain('disabled=""');
  });
});


describe('JetBrains plugin target in the panel', () => {
  it.each(['webstorm', 'intellij-idea', 'rider', 'pycharm'] as const)('offers Assistant and Air in %s and reflects the chosen target', tool => {
    const html = panel({ tool, plugin: 'air' });
    expect(html).toContain(`data-jetbrains-connection="${tool}" data-jetbrains-plugin="air"`);
    const select = html.match(/<select[^>]*data-action="jetbrains-plugin-select"[^>]*>(.*?)<\/select>/)?.[1];
    expect(select).toContain('<option value="ai-assistant">AI Assistant</option>');
    expect(select).toContain('<option value="air" selected="">Air</option>');
    expect(html).toContain('切换插件不会立即写入 IDE');
  });
  it('shows only Air account parameters and keeps Agent, model, and authorization selection manual', () => {
    const html = panel({ plugin: 'air' });
    expect(html).toContain('data-air-connection="rider"');
    expect(html).toContain('设置 → AI → Air → Accounts');
    expect(html).toContain('data-air-manual-setup');
    expect(html).toContain('More Providers → OpenAI');
    expect(html).not.toContain('data-action="apply-tool-config"');
    expect(html).not.toContain('data-action="jetbrains-refresh-status"');
    expect(html).not.toContain('data-jetbrains-auto-sync=');
    expect(html).toContain('复制 Air 模型 ID');
    expect(html).toContain('不会替你切换 Agent、模型或登录方式');
    expect(html).toContain('ModelDock 不直接修改 Air 的账户文件或密码存储');
    expect(html).not.toContain('data-jetbrains-completion=');
    expect(html).not.toContain('data-action="jetbrains-copy-completion-key"');
    expect(html).not.toContain('<dt>核心功能模型 ID</dt>');
    expect(html).not.toContain('<dt>轻量 / 快速功能模型 ID</dt>');
    expect(html).not.toContain('<dt>HTTP 版本</dt>');
  });
  it('does not enable copying an Air account key before a source exists', () => {
    const html = panel({ plugin: 'air', models: [], defaultModel: undefined });
    expect(html.match(/<button[^>]*data-action="jetbrains-copy-key"[^>]*>/)?.[0]).toContain('disabled=""');
  });
});
