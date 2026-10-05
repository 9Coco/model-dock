import { pathToFileURL } from 'node:url';

export const DSH_LEGACY_PLUGIN_ID = 'modeldock-legacy-dispatch';
export const DSH_LEGACY_SCRIPT = '.modeldock/legacy-dispatch.cjs';
export interface DshLegacyDispatchPlan {
  version: 1;
  mappings: { legacyProvider: 'deepseek-official' | 'deepseek-account'; model: string; targetProvider: string; targetModel: string }[];
}
const legacyIds = new Set(['deepseek-official', 'deepseek-account']);
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
export function validateDshLegacyDispatch(value: unknown, providers: Record<string, { models: { id: string }[] }>): DshLegacyDispatchPlan {
  if (!record(value) || value.version !== 1 || Object.keys(value).some(key => !['version', 'mappings'].includes(key)) || !Array.isArray(value.mappings) || !value.mappings.length || value.mappings.length > 1000) throw new Error('DSH 旧会话兼容配置无效。');
  const seen = new Set<string>();
  for (const row of value.mappings) {
    if (!record(row) || Object.keys(row).some(key => !['legacyProvider', 'model', 'targetProvider', 'targetModel'].includes(key)) || !legacyIds.has(row.legacyProvider)
      || typeof row.model !== 'string' || !row.model || /[\x00-\x1f\x7f]/.test(row.model) || row.model !== row.targetModel || typeof row.targetProvider !== 'string'
      || !Object.hasOwn(providers, row.targetProvider) || !providers[row.targetProvider].models.some(model => model.id === row.model)) throw new Error('DSH 旧会话只允许委托给已选来源中的同一模型。');
    const key = JSON.stringify([row.legacyProvider, row.model]); if (seen.has(key)) throw new Error('DSH 旧会话兼容映射重复。'); seen.add(key);
  }
  return structuredClone(value) as DshLegacyDispatchPlan;
}
export function dshLegacyPluginEntry(scriptPath: string, plan: DshLegacyDispatchPlan) {
  return { id: DSH_LEGACY_PLUGIN_ID, name: pathToFileURL(scriptPath).href, config: structuredClone(plan) };
}

/** Trusted static plugin. Configuration is YAML data, never generated code.
 * This uses native dispatch only: no session, credential, setting or catalog
 * APIs, and never writes a model-selection event or changes a request object. */
export const DSH_LEGACY_PLUGIN_SOURCE = String.raw`'use strict';
// ModelDock DSH legacy same-model dispatch v1. No credential or session access.
module.exports = {
  name: 'modeldock-legacy-dispatch', inject: ['llm'],
  apply(ctx, config) {
    const failure = (changed) => Object.assign(new Error(changed
      ? '所选模型配置刚发生变化，请重新发送；旧会话内容没有修改。'
      : '旧会话模型不在本次所选同模型来源中，请在 DSH 切换模型或新建会话。'), { code: 'MODELDOCK_LEGACY_MODEL_UNAVAILABLE' });
    if (!config || config.version !== 1 || !Array.isArray(config.mappings) || !config.mappings.length) throw failure(false);
    const mappings = config.mappings.map(row => {
      if (!row || !['deepseek-official', 'deepseek-account'].includes(row.legacyProvider)
        || typeof row.model !== 'string' || !row.model || row.model !== row.targetModel
        || typeof row.targetProvider !== 'string' || !row.targetProvider.startsWith('modeldock')) throw failure(false);
      return Object.freeze({ legacyProvider: row.legacyProvider, model: row.model, targetProvider: row.targetProvider, targetModel: row.targetModel });
    });
    const routes = [...new Set(mappings.map(row => row.legacyProvider))];
    const lookup = (provider, model) => {
      const row = mappings.find(value => value.legacyProvider === provider && value.model === model);
      if (!row) throw failure(false); return row;
    };
    const same = (a, b) => Array.isArray(a) || Array.isArray(b)
      ? Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => value === b[index]) : a === b;
    async function infoFor(provider, model, signal) {
      const row = lookup(provider, model);
      const info = await ctx.llm.resolveModelInfo(row.targetProvider, row.targetModel, signal);
      if (info.provider !== row.targetProvider || info.id !== row.targetModel) throw failure(true);
      return { ...info, provider, id: model };
    }
    async function* dispatch(options, captured) {
      const row = lookup(options.provider, options.model);
      // Preserve the loop-owned request and its signal; only the detached
      // downstream envelope uses the selected same-model route.
      const downstream = { ...options, provider: row.targetProvider, model: row.targetModel };
      if (!ctx.llm.listProviders().some(provider => provider.id === row.targetProvider)) throw failure(true);
      if (typeof ctx.llm.prepareCall === 'function') {
        const proposal = { provider: row.targetProvider, model: row.targetModel };
        for (const key of ['reasoningEffort', 'temperature', 'maxTokens', 'stop']) if (options[key] !== undefined) proposal[key] = options[key];
        const prepared = await ctx.llm.prepareCall(proposal, options.signal);
        if (!prepared || !prepared.config || typeof prepared.stream !== 'function'
          || prepared.config.provider !== row.targetProvider || prepared.config.model !== row.targetModel) throw failure(true);
        for (const key of ['reasoningEffort', 'temperature', 'maxTokens', 'stop']) if (!same(prepared.config[key], options[key])) throw failure(true);
        if (captured && JSON.stringify(captured.context ?? null) !== JSON.stringify(prepared.context ?? null)) throw failure(true);
        yield* prepared.stream(downstream);
      } else {
        // Older native adapters still resolve metadata before dispatch. A
        // changed context is rejected rather than silently changing budgets.
        const current = await infoFor(options.provider, options.model, options.signal);
        if (captured && JSON.stringify(captured.context ?? null) !== JSON.stringify(current.context ?? null)) throw failure(true);
        yield* ctx.llm.stream(downstream);
      }
    }
    const adapter = {
      providerInfo(provider) { return { id: provider, name: provider }; },
      providerRetryPolicy() {}, imageRequestPricing() {},
      listModels() { return Promise.resolve([]); },
      resolveModel: infoFor,
      async prepareCall(provider, model, signal) {
        const captured = await infoFor(provider, model, signal);
        return { model: captured, stream: options => dispatch(options, captured) };
      },
      stream(options) { return dispatch(options); }
    };
    let registered = false, registering = false;
    const register = () => {
      if (registered || registering || ctx.llm.listProviders().some(provider => routes.includes(provider.id))) return;
      registering = true;
      try { ctx.llm.registerAdapter(routes, adapter); registered = true; }
      finally { registering = false; }
    };
    ctx.on('llm/adapters-updated', register); register();
  }
};
`;
