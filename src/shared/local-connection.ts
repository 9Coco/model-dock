import type { Model, Provider, Snapshot } from './types';
import { isTraeRelayProvider } from './trae-relay-models';

/** The public gateway has one shared local entrance; aliases select the source. */
export function localGatewayBaseUrl(data: Pick<Snapshot, 'gateway'>): string {
  return `http://127.0.0.1:${data.gateway.port}/v1`;
}

/** Matches the models advertised by the gateway's general /v1/models catalog. */
export function isPublishedGatewayModel(data: Pick<Snapshot, 'gatewayExposure'>, provider: Provider, model: Model): boolean {
  const exposure = data.gatewayExposure;
  return model.providerId === provider.id && model.enabled && provider.enabled && provider.hasSecret && provider.authStatus === 'ready'
    && !!provider.baseUrl.trim() && (!exposure || !exposure.excludedProviderIds.includes(provider.id) && !exposure.excludedModelIds.includes(model.id))
    && (model.wireApi !== 'messages' || isTraeRelayProvider(provider));
}

export function localModelStatus(data: Pick<Snapshot, 'gateway' | 'gatewayExposure'>, provider: Provider, model: Model): string {
  if (!provider.enabled) return '供应商已停用';
  if (!provider.hasSecret || provider.authStatus !== 'ready') return '需完成授权或连接';
  if (!provider.baseUrl.trim()) return '连接尚未配置';
  if (!model.enabled) return '模型已停用';
  if (data.gatewayExposure?.excludedProviderIds.includes(provider.id)) return '供应商未加入本地接口';
  if (data.gatewayExposure?.excludedModelIds.includes(model.id)) return '模型未发布';
  if (model.wireApi === 'messages' && !isTraeRelayProvider(provider)) return '需支持 Messages 的工具入口';
  return data.gateway.running ? '已发布' : '待启动本地服务';
}
