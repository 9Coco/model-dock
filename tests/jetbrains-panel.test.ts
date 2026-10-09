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
    tool: 'rider', aggregate: true, api: {} as ModelDockApi, models, defaultModel: models[0],
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
