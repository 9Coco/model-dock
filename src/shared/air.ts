import type { ToolBinding } from './types';

export type AirProvider = NonNullable<ToolBinding['airProvider']>;
export function airProviderFor(binding?: Pick<ToolBinding, 'airProvider'>): AirProvider {
  return binding?.airProvider ?? 'openai';
}
export function airProviderLabel(provider: AirProvider): 'OpenAI' | 'Anthropic' {
  return provider === 'anthropic' ? 'Anthropic' : 'OpenAI';
}
export function airSettingsPath(provider: AirProvider): string {
  return `设置 → AI → Air → 账户 → 更多供应商 → ${airProviderLabel(provider)}`;
}
/** Air appends /v1/messages and /v1/models for Anthropic accounts. */
export function airAccountBaseUrl(provider: AirProvider, baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  return provider === 'anthropic' ? base.replace(/\/v1$/, '') : base;
}
export function airGatewayBaseUrl(provider: AirProvider, port: number): string {
  return `http://127.0.0.1:${port}/tool/air${provider === 'anthropic' ? '' : '/v1'}`;
}
export function isAirAnthropic(binding?: Pick<ToolBinding, 'id' | 'airProvider'>): boolean {
  return binding?.id === 'air' && airProviderFor(binding) === 'anthropic';
}
export const AIR_MANUAL_SETUP = '请在 Air 自己的 Accounts 界面保存账户与 API Key；ModelDock 提供接入参数，不自动写入或还原 Air 账户。';
