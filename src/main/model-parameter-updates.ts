import { isDeepStrictEqual } from 'node:util';
import type { DiscoveredModel, ParameterChange, ParameterRow } from '../shared/catalog-types';
import { MODEL_DRAFT_PARAMETER_FIELDS } from '../shared/model-draft';
import { documentedSupplierParameters } from '../shared/model-metadata';
import { OPENCODE_GO_BASE_URL } from '../shared/presets';
import type { Model, Provider } from '../shared/types';

export function parameterRow(provider: Provider, model: Model, entry?: Omit<DiscoveredModel, 'alias'>, includeManufacturer = false): ParameterRow | undefined {
  if (entry?.catalogImportable === false) return;
  const dictionary = documentedSupplierParameters(provider, model, includeManufacturer);
  const base = provider.baseUrl.replace(/\/+$/, '');
  const sharedCatalog = !provider.nativeAdapter && (provider.kind === 'opencode-go' && base === OPENCODE_GO_BASE_URL && model.wireApi !== 'messages'
    || provider.kind === 'openai-compatible' && ['https://api.deepseek.com', 'https://api.deepseek.com/v1'].includes(base));
  const directory = entry?.wireApi === model.wireApi || sharedCatalog ? entry : undefined;
  const ignored = new Set([...directory?.metadataDefaults ?? [], ...directory?.metadataInferred ?? []]);
  const facts = { ...dictionary?.values };
  const live = new Set<ParameterChange['field']>();
  for (const field of MODEL_DRAFT_PARAMETER_FIELDS) {
    if (directory?.[field] === undefined || ignored.has(field)) continue;
    Object.assign(facts, { [field]: directory[field] });
    live.add(field);
  }
  if (facts.reasoningEfforts?.length && live.has('reasoningEfforts') && !live.has('thinking')) {
    facts.thinking = true;
    live.add('thinking');
  }
  // A documented default for another set of levels cannot override a live list.
  if (facts.thinking === false || facts.reasoningEfforts && !facts.reasoningEfforts.includes(facts.defaultReasoningEffort!)) delete facts.defaultReasoningEffort;
  const changes = (replace: boolean) => {
    const next = { ...model };
    const result: ParameterChange[] = [];
    const assign = (field: ParameterChange['field'], value: Model[typeof field] | undefined, source: ParameterChange['source']) => {
      const before = model[field] ?? null, after = value ?? null;
      if (isDeepStrictEqual(before, after)) return;
      Object.assign(next, { [field]: value });
      result.push({ field, before, after, source });
    };
    for (const field of MODEL_DRAFT_PARAMETER_FIELDS) {
      const value = facts[field], current = model[field];
      if (value === undefined || field === 'reasoningEffortFormat' || field === 'defaultReasoningEffort') continue;
      if (!replace && current != null && current !== 0 && !(Array.isArray(current) && !current.length)) continue;
      if (!replace && field === 'thinking' && value === false && (model.reasoningEfforts?.length || model.adaptiveThinking || model.minThinkingBudget || model.maxThinkingBudget)) continue;
      if ((facts.thinking === false || next.thinking === false) && ['reasoningEfforts', 'adaptiveThinking', 'minThinkingBudget', 'maxThinkingBudget'].includes(field)) continue;
      assign(field, value, live.has(field) ? 'catalog' : 'dictionary');
    }
    const levelSource = live.has('reasoningEfforts') ? 'catalog' : 'dictionary';
    if (next.thinking === false && replace && facts.thinking === false) {
      const source = live.has('thinking') ? 'catalog' : 'dictionary';
      if (next.reasoningEfforts?.length) assign('reasoningEfforts', [], source);
      for (const field of ['adaptiveThinking', 'minThinkingBudget', 'maxThinkingBudget', 'defaultReasoningEffort', 'reasoningEffortFormat'] as const) assign(field, undefined, source);
    } else if (next.thinking !== false) {
      const levels = next.reasoningEfforts ?? [];
      const preferred = facts.defaultReasoningEffort;
      if (preferred && levels.includes(preferred) && (replace || model.defaultReasoningEffort == null)) {
        assign('defaultReasoningEffort', preferred, live.has('defaultReasoningEffort') ? 'catalog' : 'dictionary');
      } else if (replace && facts.reasoningEfforts && next.defaultReasoningEffort && !levels.includes(next.defaultReasoningEffort)) assign('defaultReasoningEffort', undefined, levelSource);
      if ((replace || !model.reasoningEffortFormat) && facts.reasoningEfforts && isDeepStrictEqual(levels, facts.reasoningEfforts)) {
        assign('reasoningEffortFormat', levels.length ? model.wireApi : undefined, 'protocol');
      }
    }
    if (next.minThinkingBudget !== undefined && next.maxThinkingBudget !== undefined && next.minThinkingBudget > next.maxThinkingBudget) {
      return result.filter(change => change.field !== 'minThinkingBudget' && change.field !== 'maxThinkingBudget');
    }
    return result;
  };
  const all = changes(true), missing = changes(false);
  if (!all.length && !missing.length) return;
  return { id: model.id, name: model.displayName || model.upstreamId, upstreamId: model.upstreamId, missing, all,
    ...(dictionary ? { reference: { url: dictionary.url, checked: dictionary.checked, manufacturer: dictionary.manufacturer } } : {}) };
}
