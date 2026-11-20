import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AirPanel } from '../src/renderer/AirPanel';
import type { ModelDockApi } from '../src/shared/types';

const noOp = async () => {};
function panel(overrides: Partial<Parameters<typeof AirPanel>[0]> = {}) {
  return renderToStaticMarkup(createElement(AirPanel, {
    api: {} as ModelDockApi, baseUrl: 'http://127.0.0.1:18181/tool/air/v1', modelId: 'reference-model',
    aggregate: true, running: false, disabled: false, starting: false,
    onCopy: noOp, onCopyKey: noOp, onStart: noOp, onPreview: noOp, onExport: noOp, ...overrides,
  }));
}
const action = (html: string, name: string) => html.match(new RegExp(`<button[^>]*data-action="${name}"[^>]*>`))?.[0];

describe('Air BYOK connection panel', () => {
  it('exposes the manual connection and leaves Agent and model selection in Air', () => {
    const html = panel();
    expect(html).toContain('data-air-connection="air"');
    expect(html).toContain('设置 → AI → Air → Accounts → More Providers → OpenAI');
    expect(html).toContain('http://127.0.0.1:18181/tool/air/v1');
    expect(html).toContain('reference-model');
    expect(html).toContain('在 Air 会话中选择这个提供商和兼容的 Agent，再选择模型');
    for (const name of ['air-copy-url', 'air-copy-key', 'air-copy-model', 'preview-tool-config', 'export-tool-config']) {
      expect(action(html, name)).toBeDefined();
      expect(action(html, name)).not.toContain('disabled');
    }
    for (const name of ['apply-tool-config', 'jetbrains-plugin-select', 'jetbrains-completion-model', 'restore-official-tool-config']) {
      expect(html).not.toContain(name);
    }
  });
  it('starts the local gateway only from an offline aggregate connection', () => {
    expect(action(panel(), 'air-start-gateway')).toBeDefined();
    expect(action(panel({ running: true }), 'air-start-gateway')).toBeUndefined();
    expect(action(panel({ aggregate: false }), 'air-start-gateway')).toBeUndefined();
  });
  it('disables parameter delivery when a source is missing', () => {
    const html = panel({ baseUrl: '', modelId: undefined, aggregate: false });
    for (const name of ['air-copy-url', 'air-copy-key', 'air-copy-model', 'preview-tool-config', 'export-tool-config']) {
      expect(action(html, name)).toContain('disabled=""');
    }
  });
});
