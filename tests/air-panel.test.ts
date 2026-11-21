import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AirPanel } from '../src/renderer/AirPanel';
import type { ModelDockApi } from '../src/shared/types';

const noOp = async () => {};
function panel(overrides: Partial<Parameters<typeof AirPanel>[0]> = {}) {
  return renderToStaticMarkup(createElement(AirPanel, {
    api: {} as ModelDockApi, provider: 'openai', description: 'ModelDock · Air · OpenAI', baseUrl: 'http://127.0.0.1:18181/tool/air/v1', modelId: 'reference-model',
    aggregate: true, running: false, disabled: false, starting: false,
    onCopy: noOp, onProviderChange: noOp, onCopyKey: noOp, onStart: noOp, onPreview: noOp, onExport: noOp, ...overrides,
  }));
}
const action = (html: string, name: string) => html.match(new RegExp(`<(?:button|select)[^>]*data-action="${name}"[^>]*>`))?.[0];

describe('Air BYOK connection panel', () => {
  it('exposes the manual connection and leaves Agent and model selection in Air', () => {
    const html = panel();
    expect(html).toContain('data-air-connection="air"');
    expect(html).toContain('设置 → AI → Air → 账户 → 更多供应商 → OpenAI');
    expect(html).toContain('http://127.0.0.1:18181/tool/air/v1');
    expect(html).toContain('reference-model');
    expect(html).toContain('Description（描述）');
    expect(html).toContain('展开「高级选项」填写 Base URL');
    expect(html).toContain('在 Air 会话中选择已保存的账号和兼容的 Agent');
    expect(html).toContain('ModelDock 不会自动写入 Air Accounts');
    expect(html).toContain('JSON 仅供参考，不能直接导入 Air');
    expect(html).toContain('Copilot 默认入口使用独立的 GitHub 授权');
    for (const name of ['air-provider-type', 'air-copy-description', 'air-copy-url', 'air-copy-key', 'air-copy-model', 'preview-tool-config', 'export-tool-config']) {
      expect(action(html, name)).toBeDefined();
      expect(action(html, name)).not.toContain('disabled');
    }
    for (const name of ['apply-tool-config', 'undo-tool-sync', 'jetbrains-plugin-select', 'jetbrains-completion-model', 'restore-official-tool-config']) {
      expect(html).not.toContain(name);
    }
  });
  it('shows the Anthropic account path and exact base URL without requesting credentials during rendering', () => {
    const html = panel({ provider: 'anthropic', description: 'ModelDock · Air · Anthropic', aggregate: false,
      baseUrl: 'https://api.deepseek.com/anthropic', modelId: 'deepseek-flash',
      api: { copyConnectionKey: () => { throw new Error('Rendering must not request the key'); } } as unknown as ModelDockApi });
    expect(html).toContain('设置 → AI → Air → 账户 → 更多供应商 → Anthropic');
    expect(html).toContain('<option value="anthropic" selected="">Anthropic</option>');
    expect(html).toContain('https://api.deepseek.com/anthropic</code>');
    expect(html).toContain('所选供应商的 API Key');
    expect(html).not.toContain('ModelDock 本机连接密钥');
    expect(action(html, 'air-start-gateway')).toBeUndefined();
  });
  it('starts the local gateway only from an offline aggregate connection', () => {
    expect(action(panel(), 'air-start-gateway')).toBeDefined();
    expect(action(panel({ running: true }), 'air-start-gateway')).toBeUndefined();
    expect(action(panel({ aggregate: false }), 'air-start-gateway')).toBeUndefined();
  });
  it('disables parameter delivery when a source is missing', () => {
    const html = panel({ baseUrl: '', modelId: undefined, aggregate: false });
    for (const name of ['air-copy-description', 'air-copy-url', 'air-copy-key', 'air-copy-model', 'preview-tool-config', 'export-tool-config']) {
      expect(action(html, name)).toContain('disabled=""');
    }
    expect(action(html, 'air-provider-type')).toBeDefined();
    expect(action(html, 'air-provider-type')).not.toContain('disabled');
  });
  it('prevents provider changes while a selection is being saved or the desktop bridge is unavailable', () => {
    expect(action(panel({ disabled: true }), 'air-provider-type')).toContain('disabled=""');
    expect(action(panel({ api: undefined }), 'air-provider-type')).toContain('disabled=""');
  });
});
