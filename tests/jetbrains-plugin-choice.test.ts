import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/main/store';
import type { JetBrainsPlugin, ToolId } from '../src/shared/types';
import { JETBRAINS_TOOL_IDS } from '../src/shared/jetbrains';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const action of cleanup.splice(0).reverse()) action(); });
async function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'modeldock-plugin-choice-'));
  cleanup.push(() => rmSync(dir,{recursive:true,force:true}));
  const store=await Store.create(dir);
  cleanup.push(() => store.close());
  return {store,dir};
}
const sources = (store: Store) => ({ providers:store.listProviders(), models:store.listModels(), bindings:store.listBindings().map(({jetBrainsPlugin:_plugin,...binding})=>binding) });

describe('per-IDE plugin preference',()=>{
  it('defaults to the current Assistant target and persists independent choices without altering bindings or sources',async()=>{
    const {store,dir}=await fixture();
    expect(JETBRAINS_TOOL_IDS.map(tool=>store.getJetBrainsPlugin(tool))).toEqual(Array(4).fill('ai-assistant'));
    const before=sources(store),gatewayKey=store.gatewayKey();
    store.setJetBrainsPlugin('rider','air');
    expect(store.listBindings().find(binding=>binding.id==='rider')?.jetBrainsPlugin).toBe('air');
    expect(store.getJetBrainsPlugin('webstorm')).toBe('ai-assistant');
    expect(sources(store)).toEqual(before); expect(store.gatewayKey()).toBe(gatewayKey);
    store.close();const reopened=await Store.create(dir);cleanup.push(()=>reopened.close());
    expect(reopened.getJetBrainsPlugin('rider')).toBe('air');
    expect(reopened.getJetBrainsPlugin('pycharm')).toBe('ai-assistant');
    reopened.setJetBrainsPlugin('webstorm','air');reopened.setJetBrainsPlugin('rider','ai-assistant');
    expect(reopened.getJetBrainsPlugin('rider')).toBe('ai-assistant');
    expect(reopened.getJetBrainsPlugin('webstorm')).toBe('air');expect(sources(reopened)).toEqual(before);
  });
  it('keeps the chosen plugin during model saves and selection restoration',async()=>{
    const {store}=await fixture();store.setJetBrainsPlugin('rider','air');
    const current=store.listBindings().find(binding=>binding.id==='rider')!;
    store.saveBinding({...current,note:'Keep target preference'});
    expect(store.getJetBrainsPlugin('rider')).toBe('air');
    store.restoreBindingSelection({...current,note:'Old draft'});
    expect(store.getJetBrainsPlugin('rider')).toBe('air');
    expect(()=>store.saveBinding({...current,jetBrainsPlugin:'ai-assistant'})).toThrow('插件选择已变化');
  });
  it('rejects unknown plugin values and non-JetBrains tools',async()=>{
    const {store}=await fixture();
    for(const tool of ['codex','opencode','missing'] as ToolId[]) expect(()=>store.setJetBrainsPlugin(tool,'air')).toThrow();
    for(const plugin of ['assistant','AIR',null,{},true] as unknown as JetBrainsPlugin[]) expect(()=>store.setJetBrainsPlugin('rider',plugin)).toThrow('插件选择无效');
    expect(store.getJetBrainsPlugin('rider')).toBe('ai-assistant');
  });
});
