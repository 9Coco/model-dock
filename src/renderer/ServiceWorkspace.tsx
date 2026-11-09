import type { ReactNode } from 'react';
import { Activity, Waypoints } from './MaterialIcon';

const tabs = [
  { id: 'interface', title: '接口与模型', Icon: Waypoints },
  { id: 'logs', title: '请求与日志', Icon: Activity },
] as const;

export type ServiceTab = (typeof tabs)[number]['id'];
interface Props {
  tab: ServiceTab;
  setTab: (next: ServiceTab) => void;
  gateway: ReactNode;
  error: string;
  interfaces: ReactNode;
  logs: ReactNode;
}

export function ServiceWorkspace({ tab, setTab, gateway, error, interfaces, logs }: Props) {
  return <div className="service-workspace" data-service-workspace>
    {error && <p className="bridge-banner" role="alert">{error}</p>}
    {gateway}
    <div className="source-category-tabs service-tabs" role="tablist" aria-label="服务详情">
      {tabs.map(({ id, title, Icon }) => <button key={id} role="tab" id={`service-${id}-tab`} aria-controls={`service-${id}-panel`} data-service-tab={id} aria-selected={tab === id} className={tab === id ? 'selected' : ''} onClick={() => setTab(id)}><Icon size={15} />{title}</button>)}
    </div>
    <div id={`service-${tab}-panel`} role="tabpanel" aria-labelledby={`service-${tab}-tab`}>
      {tab === 'interface' ? interfaces : logs}
    </div>
  </div>;
}
