import type { Provider } from '../shared/types';
import type { CentralApi, CentralCredentials } from './central-api';
import { createJetBrainsChatStream } from './jetbrains-chat-stream';
import { createCentralResponsesStream } from './central-stream';
import { CentralNativeAccountError } from './central-native-account';

interface Accounts { isNativeProvider(id: string): boolean; credentials(id: string): CentralCredentials }
/** Native main-process dispatch into the existing authenticated Gateway. There
 * is no extra listener or external process, and no implicit protocol fallback. */
export class CentralGatewayAdapter {
  constructor(private readonly accounts: Accounts, private readonly api: Pick<CentralApi, 'models' | 'request'>) {}
  async models(provider: Provider, signal: AbortSignal): Promise<Response> {
    if (provider.nativeAdapter !== 'jetbrains-central' || !this.accounts.isNativeProvider(provider.id)) throw new CentralNativeAccountError('此 Central 连接尚未导入原生会话，请重新连接账号；旧 Pi/Central 反代不会自动启动。');
    return Response.json(await this.api.models(this.accounts.credentials(provider.id), signal));
  }
  async request(provider: Provider, path: string, body: Record<string, unknown>, signal: AbortSignal): Promise<Response | undefined> {
    if (provider.nativeAdapter !== 'jetbrains-central') return;
    if (!this.accounts.isNativeProvider(provider.id)) throw new CentralNativeAccountError('此 Central 连接尚未导入原生会话，请重新连接账号；旧 Pi/Central 反代不会自动启动。');
    const response = await this.api.request(this.accounts.credentials(provider.id), path, body, signal);
    const route = path.replace(/^\/v1\//, '/');
    if (!response.ok || !response.body || !/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || route === '/messages') return response;
    // Body deltas remain incremental. Only finish/terminal frames wait for EOF
    // so truncation or a late error cannot become a successful normal close.
    const transform = route === '/chat/completions' ? createJetBrainsChatStream(String(body.model)) : createCentralResponsesStream();
    return new Response(response.body.pipeThrough(transform, { signal }), { status: response.status, headers: response.headers });
  }
}
