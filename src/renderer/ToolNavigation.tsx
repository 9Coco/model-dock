import { useEffect, useState, type KeyboardEvent } from 'react';
import type { ToolId } from '../shared/types';
import { isJetBrainsTool } from '../shared/jetbrains';
import { ToolIcon } from './ToolIcon';
import './tool-navigation.css';

type ToolCategory = 'agent' | 'jetbrains';
type NavigationTool = { id: ToolId; name: string; connected: boolean };
type ToolNavigationProps = {
  tools: NavigationTool[];
  selectedTool: ToolId;
  active: boolean;
  onSelect: (tool: ToolId) => void;
};
const categories: { id: ToolCategory; label: string }[] = [
  { id: 'agent', label: '常规 Agent' },
  { id: 'jetbrains', label: 'JetBrains' },
];
const categoryFor = (tool: ToolId): ToolCategory => isJetBrainsTool(tool) ? 'jetbrains' : 'agent';

export function ToolNavigation({ tools, selectedTool, active, onSelect }: ToolNavigationProps) {
  const [category, setCategory] = useState<ToolCategory>(() => categoryFor(selectedTool));
  useEffect(() => { setCategory(categoryFor(selectedTool)); }, [selectedTool]);
  const changeCategory = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = event.key === 'ArrowRight' ? (index + 1) % categories.length
      : event.key === 'ArrowLeft' ? (index + categories.length - 1) % categories.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? categories.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    setCategory(categories[next].id);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };

  return <nav className="sidebar-group sidebar-tools tool-navigation" data-sidebar-scroll="tools" aria-label="工具导航">
    <div className="tool-navigation-heading" data-sidebar-label="tools">
      <div className="sidebar-group-label"><span>工具</span><span>{tools.length}</span></div>
      <div className="tool-category-tabs" role="tablist" aria-label="工具分类">
        {categories.map((item, index) => <button type="button" role="tab" key={item.id}
          id={`tool-category-tab-${item.id}`} aria-controls={`tool-category-panel-${item.id}`}
          aria-selected={category === item.id} tabIndex={category === item.id ? 0 : -1}
          className={category === item.id ? 'selected' : ''} data-tool-category={item.id}
          onClick={() => setCategory(item.id)} onKeyDown={event => changeCategory(event, index)}>
          {item.label}<span>{tools.filter(tool => categoryFor(tool.id) === item.id).length}</span>
        </button>)}
      </div>
    </div>
    {categories.map(item => <div className="tool-category-panel" role="tabpanel" key={item.id}
      id={`tool-category-panel-${item.id}`} aria-labelledby={`tool-category-tab-${item.id}`}
      hidden={category !== item.id}>
      {tools.filter(tool => categoryFor(tool.id) === item.id).map(tool => <button type="button" key={tool.id}
        data-page="tools" data-tool-id={tool.id}
        className={`nav-item agent-nav ${active && selectedTool === tool.id ? 'active' : ''}`}
        aria-current={active && selectedTool === tool.id ? 'page' : undefined} onClick={() => onSelect(tool.id)}>
        <ToolIcon tool={tool.id} /><span>{tool.name}</span>{tool.connected && <span className="status-dot green" />}
      </button>)}
    </div>)}
  </nav>;
}
