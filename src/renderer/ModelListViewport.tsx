import { useState, type ReactNode } from 'react';
import type { Model } from '../shared/types';
import './model-list-viewport.css';

export function ModelListViewport({ models, children }: { models: Model[]; children: (visible: Model[]) => ReactNode }) {
  const [selectedId, setSelectedId] = useState('');
  const longList = models.length > 6;
  const selected = longList ? models.find(model => model.id === selectedId) : undefined;
  return <div className="model-list-viewport">
    {longList && <label className="model-list-filter">筛选模型
      <select value={selected?.id ?? ''} onChange={event => setSelectedId(event.target.value)}>
        <option value="">全部模型（{models.length}）</option>
        {models.map(model => <option key={model.id} value={model.id}>{model.alias}</option>)}
      </select>
    </label>}
    <div className={'table-scroll' + (longList ? ' model-list-scroll' : '')}
      role={longList ? 'region' : undefined} aria-label={longList ? '模型列表' : undefined} tabIndex={longList ? 0 : undefined}>
      {children(selected ? [selected] : models)}
    </div>
  </div>;
}
