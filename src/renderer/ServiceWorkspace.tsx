import type { ReactNode } from 'react';
import type { ModelDockApi } from '../shared/types';
import type { FlowBridgeSnapshot } from '../shared/flowbridge-types';
import { Activity, Globe2, Waypoints } from './MaterialIcon';
import type { Notify } from './components';
import { NetworkControls, NetworkTools } from './NetworkPanel';

const tabs = [
  { id: 'interface', title: '接口与模型', Icon: Waypoints },
  { id: 'network', title: '网络工具', Icon: Globe2 },
  { id: 'logs', title: '请求与日志', Icon: Activity },
] as const;

export type ServiceTab = (typeof tabs)[number]['id'];
interface Props {
  tab: ServiceTab;
  setTab: (next: ServiceTab) => void;
  api?: ModelDockApi;
  gateway: ReactNode;
  network?: FlowBridgeSnapshot;
  error: string;
  refresh: () => Promise<void>;
  notify: Notify;
  interfaces: ReactNode;
  logs: ReactNode;
}

export function ServiceWorkspace({ tab, setTab, api, gateway, network, error, refresh, notify, interfaces, logs }: Props) {
  return <div className="service-workspace" data-service-workspace>
    {error && <p className="bridge-banner" role="alert">{error}</p>}
    <div className="service-controls">
      {gateway}
      <NetworkControls api={api} snapshot={network} onChanged={refresh} notify={notify} />
    </div>
    <div className="source-category-tabs service-tabs" role="tablist" aria-label="服务详情">
      {tabs.map(({ id, title, Icon }) => <button key={id} role="tab" id={`service-${id}-tab`} aria-controls={`service-${id}-panel`} data-service-tab={id} aria-selected={tab === id} className={tab === id ? 'selected' : ''} onClick={() => setTab(id)}><Icon size={15} />{title}</button>)}
    </div>
    <div id={`service-${tab}-panel`} role="tabpanel" aria-labelledby={`service-${tab}-tab`}>
      {tab === 'interface' ? interfaces : tab === 'logs' ? logs : <NetworkTools api={api} snapshot={network} notify={notify} />}
    </div>
  </div>;
}
