import { describe, expect, it } from 'vitest';
import { modelDisplayLabel, modelLocalAlias, suggestModelAlias } from '../src/shared/model-names';

const route = (id: string, providerId: string, alias: string) => ({ id, providerId, alias });

describe('source-scoped names and stable aggregate routes', () => {
  it('allows the same name in different sources while retaining the first route', () => {
    const existing = [route('old', 'first', 'glm-5.3')];
    expect(suggestModelAlias('second', 'glm-5.3', existing)).toBe('second/glm-5.3');
    expect(suggestModelAlias('third', 'glm-5.3', [...existing, route('new', 'second', 'second/glm-5.3')])).toBe('third/glm-5.3');
    expect(existing[0].alias).toBe('glm-5.3');
  });
  it('rejects a same-source duplicate whether entered as a local name or full route', () => {
    const existing = [route('old', 'first', 'first/glm-5.3')];
    expect(() => suggestModelAlias('first', 'glm-5.3', existing)).toThrow('同一供应商');
    expect(() => suggestModelAlias('first', 'first/glm-5.3', existing)).toThrow('同一供应商');
  });
  it('keeps qualified routes when editing local names after the original bare route disappears', () => {
    const existing = [route('kept', 'second', 'second/glm-5.3')];
    expect(suggestModelAlias('second', 'glm-5.3', existing, 'kept')).toBe('second/glm-5.3');
    expect(suggestModelAlias('second', 'second/glm-5.3', existing, 'kept')).toBe('second/glm-5.3');
    expect(suggestModelAlias('second', 'different', existing, 'kept')).toBe('different');
    expect(suggestModelAlias('moved', 'glm-5.3', existing, 'kept')).toBe('glm-5.3');
  });
  it('avoids namespaces occupied by other sources and refuses repeats at the chosen suffix', () => {
    const existing = [route('a', 'first', 'glm'), route('b', 'first', 'second/glm'), route('c', 'third', 'second/glm-2')];
    expect(suggestModelAlias('second', 'glm', existing)).toBe('second/glm-3');
    expect(() => suggestModelAlias('second', 'glm', [...existing, route('d', 'second', 'second/glm-3')])).toThrow('同一供应商');
  });
  it('hides its own namespace and keeps other custom slashes in names', () => {
    expect(modelLocalAlias({ providerId: 'second', alias: 'second/glm-5.3' })).toBe('glm-5.3');
    expect(modelLocalAlias({ providerId: 'second', alias: 'custom/glm-5.3' })).toBe('custom/glm-5.3');
  });
  it('labels models with the source name without changing their route or upstream ID', () => {
    const model = { alias: 'stable/glm', upstreamId: 'glm', displayName: 'GLM 5.3' };
    expect(modelDisplayLabel(model, { name: '火山 Agent Plan' })).toBe('火山 Agent Plan - GLM 5.3');
    expect(modelDisplayLabel(model, { name: '千问 Token Plan' })).toBe('千问 Token Plan - GLM 5.3');
    expect(modelDisplayLabel({ ...model, displayName: '' })).toBe('glm');
    expect(model.alias).toBe('stable/glm');
  });
});
