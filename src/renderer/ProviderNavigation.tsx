import type { KeyboardEvent } from 'react';
import type { Provider, ProviderKind } from '../shared/types';
import { providerCategory } from '../shared/presets';
import { subscriptionDisplayName } from '../shared/subscription-names';
import { Plus } from './MaterialIcon';
import './provider-navigation.css';

export type ProviderCategory = 'api' | 'subscription';
type ProviderNavigationProps = {
  providers: Provider[];
  selectedProviderId: string | null;
  active: boolean;
  category: ProviderCategory;
  onCategoryChange: (category: ProviderCategory) => void;
  onSelect: (id: string) => void;
  onAddApi: () => void;
};
const categories: { id: ProviderCategory; label: string }[] = [
  { id: 'api', label: 'API' },
  { id: 'subscription', label: '订阅' },
];
const symbols: Record<ProviderKind, string> = { 'openai-compatible': 'A', 'opencode-go': 'O', codex: 'C', copilot: 'P', grok: 'G' };

/** Category changes only switch this list; selecting a source remains an explicit action. */
export function ProviderNavigation({ providers, selectedProviderId, active, category, onCategoryChange, onSelect, onAddApi }: ProviderNavigationProps) {
  const changeCategory = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = event.key === 'ArrowRight' ? (index + 1) % categories.length
      : event.key === 'ArrowLeft' ? (index + categories.length - 1) % categories.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? categories.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    onCategoryChange(categories[next].id);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };
  return <nav className="sidebar-group sidebar-scroll sidebar-providers provider-navigation" data-sidebar-scroll="providers" aria-label="模型供应商导航">
    <div className="provider-navigation-heading" data-sidebar-label="providers">
      <div className="provider-navigation-title"><div className="sidebar-group-label"><span>模型供应商</span><span className="nav-count">{providers.length}</span></div>{category === 'api' && <button type="button" data-action="add-api-provider" className="icon-button" title="添加 API" aria-label="添加 API 供应商" onClick={onAddApi}><Plus size={15} /></button>}</div>
      <div className="provider-category-tabs" role="tablist" aria-label="供应商分类">
        {categories.map((item, index) => <button type="button" role="tab" key={item.id}
          id={`provider-category-tab-${item.id}`} aria-controls={`provider-category-panel-${item.id}`}
          aria-selected={category === item.id} tabIndex={category === item.id ? 0 : -1}
          className={category === item.id ? 'selected' : ''} data-provider-category={item.id}
          onClick={() => onCategoryChange(item.id)} onKeyDown={event => changeCategory(event, index)}>
          {item.label}<span className="nav-count">{providers.filter(provider => providerCategory(provider) === item.id).length}</span>
        </button>)}
      </div>
    </div>
    {categories.map(item => <div className="provider-category-panel" role="tabpanel" key={item.id}
      id={`provider-category-panel-${item.id}`} aria-labelledby={`provider-category-tab-${item.id}`}
      data-sidebar-provider-category={item.id} hidden={category !== item.id} tabIndex={providers.some(provider => providerCategory(provider) === item.id) ? undefined : 0}>
      {providers.filter(provider => providerCategory(provider) === item.id).map(provider => <button type="button" key={provider.id}
        data-source-id={provider.id} className={`nav-item source-nav ${active && selectedProviderId === provider.id ? 'active' : ''}`}
        aria-current={active && selectedProviderId === provider.id ? 'page' : undefined} title={subscriptionDisplayName(provider)} onClick={() => onSelect(provider.id)}>
        <span className={`nav-monogram ${provider.kind}`} aria-hidden="true">{symbols[provider.kind]}</span><span>{subscriptionDisplayName(provider)}</span><span className={`status-dot ${provider.authStatus === 'ready' && provider.enabled ? 'green' : ''}`} aria-hidden="true" />
      </button>)}
      {!providers.some(provider => providerCategory(provider) === item.id) && <p className="provider-navigation-empty">{item.id === 'api' ? '尚未添加 API' : '在授权中心添加订阅'}</p>}
    </div>)}
  </nav>;
}
