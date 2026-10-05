import { describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { DSH_LEGACY_PLUGIN_SOURCE, validateDshLegacyDispatch, type DshLegacyDispatchPlan } from '../src/main/dsh-runtime';

const plan: DshLegacyDispatchPlan = { version: 1, mappings: [
  { legacyProvider: 'deepseek-official', model: 'deepseek-flash', targetProvider: 'modeldock-deepseek', targetModel: 'deepseek-flash' },
  { legacyProvider: 'deepseek-account', model: 'deepseek-flash', targetProvider: 'modeldock-deepseek', targetModel: 'deepseek-flash' },
] };
function fixture(builtin = false) {
  const module = { exports: {} as any }; runInNewContext(DSH_LEGACY_PLUGIN_SOURCE, { module });
  const listeners: (() => void)[] = [];
  const providers = new Set(['modeldock-deepseek', ...(builtin ? ['deepseek-official', 'deepseek-account'] : [])]);
  const state = { generation: 1, context: { maxInputTokens: 128000 }, extraDefaults: false, generationOnPrepare: false };
  let adapter: any;
  const nativeStream = vi.fn((options: any, generation: number) => (async function* () { yield { type: 'text', text: `generation-${generation}`, signal: options.signal }; })());
  const llm = {
    listProviders: () => [...providers].map(id => ({ id, name: id })),
    resolveModelInfo: vi.fn(async (provider, id, _signal) => ({ provider, id, context: { ...state.context } })),
    prepareCall: vi.fn(async (config: any, _signal) => {
      const generation = state.generation; if (state.generationOnPrepare) state.generation++;
      return { config: { ...config, ...(state.extraDefaults ? { maxTokens: 4096 } : {}) }, context: { ...state.context }, stream: (options: any) => nativeStream(options, generation) };
    }),
    stream: vi.fn((options: any) => nativeStream(options, state.generation)),
    registerAdapter: vi.fn((routes, value) => { adapter = value; for (const route of routes) providers.add(route); for (const notify of listeners) notify(); }),
  };
  const ctx = { llm, on: vi.fn((_event, notify) => { listeners.push(notify); }) };
  module.exports.apply(ctx, structuredClone(plan));
  return { plugin: module.exports, ctx, llm, providers, listeners, state, nativeStream, adapter: () => adapter };
}
async function collect(stream: AsyncIterable<any>) { const result = []; for await (const chunk of stream) result.push(chunk); return result; }
describe('DSH legacy same-model native dispatch plugin', () => {
  it('registers only hidden dispatch routes after original native adapters are released, without self-registration recursion', async () => {
    const f = fixture(true); expect(f.adapter()).toBeUndefined(); expect(f.llm.registerAdapter).not.toHaveBeenCalled();
    f.providers.delete('deepseek-official'); f.listeners.forEach(notify => notify()); expect(f.adapter()).toBeUndefined();
    f.providers.delete('deepseek-account'); f.listeners.forEach(notify => notify());
    expect(f.llm.registerAdapter).toHaveBeenCalledOnce();
    expect(f.plugin.inject).toEqual(['llm']); expect(await f.adapter().listModels('deepseek-official')).toEqual([]);
    expect(f.ctx).not.toHaveProperty('session'); expect(f.ctx).not.toHaveProperty('credentials'); expect(f.ctx).not.toHaveProperty('settings');
  });
  it('delegates the exact same model using a detached request, retains cancellation and explicit controls, and binds native generation at stream time', async () => {
    const f = fixture(), controller = new AbortController(), messages = Object.freeze([{ role: 'user', content: 'synthetic request' }]);
    const options = Object.freeze({ provider: 'deepseek-official', model: 'deepseek-flash', messages, maxTokens: 17, reasoningEffort: 'high', temperature: 0.3, stop: Object.freeze(['END']), signal: controller.signal });
    const prepared = await f.adapter().prepareCall(options.provider, options.model, controller.signal);
    expect(prepared.model.provider).toBe('deepseek-official'); expect(prepared.model.id).toBe('deepseek-flash');
    f.state.generationOnPrepare = true;
    const chunks = await collect(prepared.stream(options));
    expect(chunks[0].text).toBe('generation-1'); expect(f.state.generation).toBe(2);
    const [sent] = f.nativeStream.mock.calls[0];
    expect(sent).not.toBe(options); expect(sent.provider).toBe('modeldock-deepseek'); expect(sent.model).toBe('deepseek-flash');
    expect(sent.messages).toBe(messages); expect(sent.signal).toBe(controller.signal); expect(sent.stop).toBe(options.stop);
    expect(options.provider).toBe('deepseek-official'); expect(options.model).toBe('deepseek-flash');
    expect(f.llm.prepareCall.mock.calls[0]).toEqual([{ provider: 'modeldock-deepseek', model: 'deepseek-flash', reasoningEffort: 'high', temperature: 0.3, maxTokens: 17, stop: options.stop }, controller.signal]);
  });
  it('rejects a changed HMR context or newly materialized default rather than overwriting logged caller controls', async () => {
    const f = fixture(), options = Object.freeze({ provider: 'deepseek-official', model: 'deepseek-flash', messages: [] });
    const prepared = await f.adapter().prepareCall(options.provider, options.model);
    f.state.context.maxInputTokens = 64000;
    await expect(collect(prepared.stream(options))).rejects.toThrow('配置刚发生变化');
    expect(f.nativeStream).not.toHaveBeenCalled();
    f.state.context.maxInputTokens = 128000; f.state.extraDefaults = true;
    await expect(collect(prepared.stream(options))).rejects.toThrow('配置刚发生变化');
    expect(f.nativeStream).not.toHaveBeenCalled(); expect(options).not.toHaveProperty('maxTokens');
  });
  it('never substitutes an unrelated model or silently routes through a removed selected source', async () => {
    const f = fixture();
    await expect(f.adapter().resolveModel('deepseek-official', 'unselected-model')).rejects.toThrow('切换模型或新建会话');
    f.providers.delete('modeldock-deepseek');
    await expect(collect(f.adapter().stream({ provider: 'deepseek-account', model: 'deepseek-flash', messages: [] }))).rejects.toThrow('配置刚发生变化');
    expect(f.nativeStream).not.toHaveBeenCalled(); expect(f.llm.prepareCall).not.toHaveBeenCalled();
  });
  it('rejects non-exact, duplicate or nonselected compatibility mappings and keeps source free of credentials or session operations', () => {
    const providers = { 'modeldock-deepseek': { models: [{ id: 'deepseek-flash' }] } };
    expect(validateDshLegacyDispatch(plan, providers)).toEqual(plan);
    const different = structuredClone(plan); different.mappings[0].targetModel = 'different';
    expect(() => validateDshLegacyDispatch(different, providers)).toThrow('同一模型');
    const foreign = structuredClone(plan); foreign.mappings[0].targetProvider = 'unselected';
    expect(() => validateDshLegacyDispatch(foreign, providers)).toThrow('同一模型');
    expect(() => validateDshLegacyDispatch({ ...plan, mappings: [plan.mappings[0], plan.mappings[0]] }, providers)).toThrow('重复');
    expect(DSH_LEGACY_PLUGIN_SOURCE).not.toMatch(/apiKey|accessToken|refreshToken|credentials\.|session\.|model\/selection|registerConfigurable/);
  });
});
