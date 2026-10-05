import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { CopilotProcessVerificationError, verifyCopilotDesktopProcess } from './copilot-process';

// GitHub Copilot desktop 1.1.26 publishes this loopback WS endpoint. Its native
// handlers own SQLite, the OS credential store and the running app's updates.
// Do not replace it with CLI providers.json or rewrite the desktop database.
const MAX_FRAME = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Failure = 'not-running' | 'invalid-metadata' | 'unsupported-platform' | 'network' | 'timeout' | 'protocol' | 'native-error' | 'busy' | 'ownership' | 'configuration' | 'backup' | 'closed';
const messages: Record<Failure, string> = {
  'not-running': '请先启动 GitHub Copilot 桌面应用，再同步模型。',
  'invalid-metadata': '无法确认官方 Copilot 进程及其监听端口，连接信息无效、已变化或无法安全读取；未发送配置凭据。',
  'unsupported-platform': '当前系统没有可验证的官方 Copilot 进程身份接口，未连接或发送凭据。',
  network: '无法连接本机 Copilot 桌面应用，请确认应用仍在运行。',
  timeout: 'Copilot 桌面同步超时，部分配置可能已应用，请检查后重新同步。',
  protocol: 'Copilot 桌面配置接口格式与预期不符，未继续同步。',
  'native-error': 'Copilot 桌面应用拒绝了配置操作，未继续同步。',
  busy: 'Copilot 钥匙串正在处理其他请求，请稍后重新同步。',
  ownership: 'Copilot 中存在不属于 ModelDock 管理的同 ID 供应商，未修改该配置。',
  configuration: 'Copilot 同步配置无效，请检查供应商地址、凭据和模型设置。',
  backup: '无法保存 Copilot 配置恢复记录，未修改 Copilot。',
  closed: 'Copilot 桌面连接已关闭，请重新同步。',
};
export class CopilotDesktopError extends Error {
  constructor(readonly category: Failure) { super(messages[category]); this.name = 'CopilotDesktopError'; }
}
function fail(kind: Failure): never { throw new CopilotDesktopError(kind); }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function text(value: unknown, limit = 512): value is string { return typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value); }
function nativeFailure(message: unknown): CopilotDesktopError {
  const busy = typeof message === 'string' && /\ball\s+\d{1,2}\s+native[- ]worker\s+slots\s+(?:are\s+)?occupied\b/i.test(message);
  return new CopilotDesktopError(busy ? 'busy' : 'native-error');
}

export interface CopilotDesktopModelInput {
  id: string; modelId: string; wireModel?: string; displayName: string;
  wireApi: 'chat' | 'responses'; contextWindow?: number; maxOutputTokens?: number;
  supportedReasoningEfforts?: string[];
}
export interface CopilotDesktopProviderInput {
  id: string; name: string; baseUrl: string; apiKey: string;
  headers?: Record<string, string>; wireApi?: 'chat' | 'responses'; models: CopilotDesktopModelInput[];
}
export interface CopilotDesktopPlan { providers: CopilotDesktopProviderInput[] }
export interface CopilotNativeProvider {
  id: string; name: string; kind: string; settings: Record<string, unknown>;
  hasSecret: boolean; accountId?: string;
}
export interface CopilotNativeModel {
  id: string; providerId: string; modelId: string; displayName: string;
  wireModel?: string; maxPromptTokens?: number; maxOutputTokens?: number;
  wireApiOverride?: 'completions' | 'responses'; supportedReasoningEfforts?: string[];
}
export interface CopilotDesktopSnapshot { providers: Array<{ provider: CopilotNativeProvider; models: CopilotNativeModel[] }> }
export interface CopilotDesktopSyncOptions {
  ownedProviderIds: readonly string[];
  syncScope?: 'managed' | 'selected';
  beforeMutation?: (snapshot: CopilotDesktopSnapshot) => Promise<void> | void;
}
export interface CopilotDesktopSyncResult { providerCount: number; modelCount: number; removedProviderCount: number; removedModelCount: number }
export interface CopilotDesktopSocket {
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
  send(data: string): void; close(): void;
}
export interface CopilotDesktopOptions {
  timeoutMs?: number;
  socketFactory?: (url: string) => CopilotDesktopSocket;
  readRunFile?: (name: string) => Promise<string>;
  // Explicit trusted verifier injection for isolated fixtures. Omitting it
  // always uses the OS identity/port verifier, including with test transports.
  // Receives no token; runs before socket creation and before configuration writes.
  verifyProcess?: (pid: number, port: number) => Promise<boolean>;
}

async function boundedFile(file: string): Promise<string> {
  const directoryTree = async () => {
    for (let directory = dirname(resolve(file)); ; directory = dirname(directory)) {
      const item = await lstat(directory);
      if (item.isSymbolicLink() || !item.isDirectory() || process.platform !== 'win32' && item.mode & 0o022 && !(item.mode & 0o1000)) fail('invalid-metadata');
      if (directory === dirname(directory)) break;
    }
  };
  await directoryTree();
  const before = await lstat(file);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || before.size > 4096 || process.platform !== 'win32' && (before.mode & 0o077 || typeof process.getuid === 'function' && before.uid !== process.getuid())) fail('invalid-metadata');
  const canonical = await realpath(file);
  const fd = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const same = (a: typeof before, b: typeof before) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
  try {
    const opened = await fd.stat();
    if (!same(before, opened) || !opened.isFile()) fail('invalid-metadata');
    const buffer = Buffer.alloc(4097), { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4096 || bytesRead !== opened.size || !same(opened, await fd.stat()) || !same(opened, await lstat(file)) || canonical !== await realpath(file)) fail('invalid-metadata');
    await directoryTree();
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await fd.close(); }
}
function descriptor(portFile: string, tokenFile: string): { port: number; pid: number; token: string } {
  const port = /^(\d{1,5})\r?\n(\d{1,10})\r?\n?$/.exec(portFile);
  const token = /^([A-Za-z0-9_-]{32,256})\r?\n(\d{1,10})\r?\n?$/.exec(tokenFile);
  if (!port || !token || Number(port[2]) !== Number(token[2]) || Number(port[1]) < 1 || Number(port[1]) > 65535 || Number(port[2]) < 1 || Number(port[2]) > 0xffffffff) fail('invalid-metadata');
  return { port: Number(port[1]), pid: Number(port[2]), token: token[1] };
}
function parseProvider(value: unknown): CopilotNativeProvider {
  if (object(value)) for (const key of ['secretError', 'hasSecretError', 'credentialError']) if (value[key]) throw nativeFailure(value[key]);
  if (!object(value) || !text(value.id) || !text(value.name) || !text(value.kind) || !object(value.settings) || typeof value.hasSecret !== 'boolean' || value.accountId !== undefined && !text(value.accountId)) fail('protocol');
  // Private main-process recovery must retain the entire native settings JSON,
  // including provider-specific metadata. This is never a renderer DTO; callers
  // must encrypt snapshots and must not print this object or its headers.
  const settings = structuredClone(value.settings);
  return { id: value.id, name: value.name, kind: value.kind, settings, hasSecret: value.hasSecret, ...(value.accountId ? { accountId: value.accountId as string } : {}) };
}
function parseModel(value: unknown, providerId: string): CopilotNativeModel {
  if (!object(value) || !text(value.id) || value.providerId !== providerId || !text(value.modelId) || !text(value.displayName)) fail('protocol');
  const result: CopilotNativeModel = { id: value.id, providerId, modelId: value.modelId, displayName: value.displayName };
  if (value.wireModel !== undefined && value.wireModel !== null) { if (!text(value.wireModel)) fail('protocol'); result.wireModel = value.wireModel; }
  for (const key of ['maxPromptTokens', 'maxOutputTokens'] as const) if (value[key] !== undefined && value[key] !== null) {
    if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 1) fail('protocol'); result[key] = value[key] as number;
  }
  if (value.wireApiOverride !== undefined && value.wireApiOverride !== null) {
    if (value.wireApiOverride !== 'completions' && value.wireApiOverride !== 'responses') fail('protocol'); result.wireApiOverride = value.wireApiOverride;
  }
  if (value.supportedReasoningEfforts !== undefined && value.supportedReasoningEfforts !== null) {
    if (!Array.isArray(value.supportedReasoningEfforts) || value.supportedReasoningEfforts.some(v => !text(v, 64))) fail('protocol'); result.supportedReasoningEfforts = [...value.supportedReasoningEfforts] as string[];
  }
  return result;
}
function validatePlan(plan: CopilotDesktopPlan): CopilotDesktopPlan {
  if (!object(plan) || !Array.isArray(plan.providers) || plan.providers.length > 1000) fail('configuration');
  const ids = new Set<string>();
  for (const provider of plan.providers) {
    if (!object(provider) || !text(provider.id) || !UUID.test(provider.id) || ids.has(provider.id) || !text(provider.name, 256) || !text(provider.baseUrl, 4096) || !text(provider.apiKey, 8192) || !Array.isArray(provider.models) || provider.models.length > 10000) fail('configuration');
    ids.add(provider.id);
    if (provider.wireApi !== undefined && !['chat', 'responses'].includes(provider.wireApi)) fail('configuration');
    let url: URL; try { url = new URL(provider.baseUrl); } catch { fail('configuration'); }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url!.hostname.toLowerCase());
    if (url!.protocol !== 'https:' && !(url!.protocol === 'http:' && loopback) || !url!.hostname || url!.username || url!.password || url!.search || url!.hash) fail('configuration');
    if (provider.headers !== undefined && (!object(provider.headers) || Object.entries(provider.headers).some(([key, value]) => !/^[!#$%&'*+.^_`|~\w-]+$/.test(key) || typeof value !== 'string' || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value) || /^(authorization|cookie|host|connection|content-length)$/i.test(key)))) fail('configuration');
    const names = new Set<string>();
    for (const model of provider.models) {
      if (!object(model) || !text(model.id) || !UUID.test(model.id) || ids.has(model.id) || !text(model.modelId) || names.has(model.modelId) || !text(model.displayName) || !['chat', 'responses'].includes(model.wireApi)) fail('configuration');
      if (model.wireModel !== undefined && !text(model.wireModel)) fail('configuration');
      if (model.supportedReasoningEfforts !== undefined && (!Array.isArray(model.supportedReasoningEfforts) || model.supportedReasoningEfforts.length > 32 || model.supportedReasoningEfforts.some(value => !text(value, 64)) || new Set(model.supportedReasoningEfforts).size !== model.supportedReasoningEfforts.length)) fail('configuration');
      for (const key of ['contextWindow', 'maxOutputTokens'] as const) if (model[key] !== undefined && (!Number.isSafeInteger(model[key]) || Number(model[key]) < (key === 'contextWindow' ? 0 : 1))) fail('configuration');
      ids.add(model.id); names.add(model.modelId);
    }
  }
  // The caller cannot change a queued plan, including secrets, while earlier
  // native requests are awaiting acknowledgements.
  return structuredClone(plan);
}
/** Validate a private recovery DTO without opening a socket or touching keys. */
export function validateCopilotDesktopSnapshot(value: unknown): CopilotDesktopSnapshot {
  if (!object(value) || !Array.isArray(value.providers) || value.providers.length > 1000) fail('configuration');
  const ids = new Set<string>();
  const snapshot: CopilotDesktopSnapshot = { providers: value.providers.map(entry => {
    if (!object(entry) || !Array.isArray(entry.models) || entry.models.length > 10000) fail('configuration');
    const provider = parseProvider(entry.provider);
    if (!UUID.test(provider.id) || ids.has(provider.id) || provider.kind !== 'custom' || provider.accountId) fail('ownership'); ids.add(provider.id);
    const models = entry.models.map(model => parseModel(model, provider.id));
    for (const model of models) { if (!UUID.test(model.id) || ids.has(model.id)) fail('ownership'); ids.add(model.id); }
    if (new Set(models.map(m => m.modelId)).size !== models.length) fail('configuration');
    return { provider, models };
  }) };
  if (JSON.stringify(snapshot).length > MAX_FRAME) fail('configuration'); return snapshot;
}

export class CopilotDesktopClient {
  private pending?: { type: string; matches: (value: Record<string, unknown>) => boolean; resolve: (value: Record<string, unknown>) => void; reject: (error: CopilotDesktopError) => void; timer: ReturnType<typeof setTimeout> };
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly onMessage = (event: { data?: unknown }) => {
    // Suppress all unrelated app broadcasts; they can contain chat or account
    // data and are neither logged nor retained by this configuration client.
    if (this.closed || !this.pending || typeof event.data !== 'string') return;
    // Native WsServerMessage writes its enum tag first. Ignore unrelated
    // broadcasts before parsing or copying their potentially large chat body.
    const tag = /^\s*\{\s*"type"\s*:\s*"([a-z0-9_]{1,80})"/.exec(event.data.slice(0, 160));
    if (tag && tag[1] !== this.pending.type && tag[1] !== 'error') return;
    if (Buffer.byteLength(event.data, 'utf8') > MAX_FRAME) { this.finish(new CopilotDesktopError('protocol')); this.close(); return; }
    let value: unknown; try { value = JSON.parse(event.data); } catch { return; }
    if (!object(value)) return;
    if (value.type === 'error') { this.finish(nativeFailure(value.message)); return; }
    if (value.type === this.pending.type && this.pending.matches(value)) this.finish(undefined, value);
  };
  private readonly onDisconnect = () => { this.closed = true; this.finish(new CopilotDesktopError('network')); };
  private constructor(private readonly socket: CopilotDesktopSocket, private readonly timeout: number, private readonly ensureTrusted: () => Promise<void>) {
    socket.addEventListener('message', this.onMessage); socket.addEventListener('error', this.onDisconnect); socket.addEventListener('close', this.onDisconnect);
  }
  // copilotHome is the configuration root itself: ~/.copilot, or an isolated
  // native instance's COPILOT_HOME. It is not the user's operating-system home.
  static async open(copilotHome: string, options: CopilotDesktopOptions = {}): Promise<CopilotDesktopClient> {
    const timeout = options.timeoutMs ?? 10000;
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 60000) fail('configuration');
    const read = options.readRunFile ?? (name => boundedFile(join(copilotHome, 'run', name)));
    const verify = options.verifyProcess ?? verifyCopilotDesktopProcess;
    const readDescriptor = async () => {
      const [port, token] = await Promise.allSettled([read('ws.release.port'), read('ws.release.token')]);
      if (port.status === 'fulfilled' && token.status === 'fulfilled') return descriptor(port.value, token.value);
      // A partially written release pair must not fall back to an older
      // instance. Fallback is permitted only when both release files are absent.
      if (port.status === 'rejected' && token.status === 'rejected' && object(port.reason) && port.reason.code === 'ENOENT' && object(token.reason) && token.reason.code === 'ENOENT') {
        const pair = await Promise.all([read('ws.port'), read('ws.token')]); return descriptor(pair[0], pair[1]);
      }
      fail('invalid-metadata');
    };
    let metadata: { port: number; pid: number; token: string };
    let metadataTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      metadata = await Promise.race([
        (async () => {
          const value = await readDescriptor();
          if (!await verify(value.pid, value.port)) fail('invalid-metadata');
          const after = await readDescriptor();
          if (after.pid !== value.pid || after.port !== value.port || after.token !== value.token) fail('invalid-metadata');
          return value;
        })(),
        new Promise<never>((_, reject) => { metadataTimer = setTimeout(() => reject(new CopilotDesktopError('timeout')), timeout); }),
      ]);
    } catch (error) { if (error instanceof CopilotProcessVerificationError) fail('unsupported-platform'); if (error instanceof CopilotDesktopError) throw error; if (object(error) && error.code === 'ENOENT') fail('not-running'); fail('invalid-metadata'); }
    finally { if (metadataTimer) clearTimeout(metadataTimer); }
    const ensureTrusted = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([(async () => {
          const before = await readDescriptor();
          if (before.pid !== metadata.pid || before.port !== metadata.port || before.token !== metadata.token || !await verify(metadata.pid, metadata.port)) fail('invalid-metadata');
          const after = await readDescriptor();
          if (after.pid !== metadata.pid || after.port !== metadata.port || after.token !== metadata.token) fail('invalid-metadata');
        })(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new CopilotDesktopError('timeout')), timeout); })]);
      } catch (error) { if (error instanceof CopilotProcessVerificationError) fail('unsupported-platform'); if (error instanceof CopilotDesktopError) throw error; fail('invalid-metadata'); }
      finally { if (timer) clearTimeout(timer); }
    };
    let socket: CopilotDesktopSocket;
    try { socket = (options.socketFactory ?? (url => new WebSocket(url)))(`ws://127.0.0.1:${metadata.port}/?token=${encodeURIComponent(metadata.token)}`); }
    catch { fail('network'); }
    const client = new CopilotDesktopClient(socket!, timeout, ensureTrusted);
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); socket!.removeEventListener('open', opened); socket!.removeEventListener('error', failed); socket!.removeEventListener('close', failed); };
        const opened = () => { cleanup(); resolve(); };
        const failed = () => { cleanup(); reject(new CopilotDesktopError('network')); };
        const timer = setTimeout(() => { cleanup(); reject(new CopilotDesktopError('timeout')); }, timeout);
        socket!.addEventListener('open', opened); socket!.addEventListener('error', failed); socket!.addEventListener('close', failed);
      });
      await client.guardTrusted();
      return client;
    } catch (error) { client.close(); throw error; }
  }
  close(): void {
    if (!this.closed) { this.closed = true; this.finish(new CopilotDesktopError('closed')); }
    this.socket.removeEventListener('message', this.onMessage); this.socket.removeEventListener('error', this.onDisconnect); this.socket.removeEventListener('close', this.onDisconnect);
    try { this.socket.close(); } catch { /* Native errors and URLs never escape. */ }
  }
  private async guardTrusted(): Promise<void> {
    if (this.closed) fail('closed');
    try { await this.ensureTrusted(); }
    catch (error) { this.close(); throw error; }
  }
  private finish(error?: CopilotDesktopError, value?: Record<string, unknown>): void {
    const pending = this.pending; if (!pending) return; this.pending = undefined; clearTimeout(pending.timer);
    if (error) pending.reject(error); else pending.resolve(value!);
  }
  private async command(body: Record<string, unknown>, type: string, matches: (value: Record<string, unknown>) => boolean = () => true): Promise<Record<string, unknown>> {
    if (this.closed) fail('closed');
    if (this.pending) fail('protocol');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.finish(new CopilotDesktopError('timeout')); this.close(); }, this.timeout);
      this.pending = { type, matches, resolve, reject, timer };
      try { this.socket.send(JSON.stringify(body)); } catch { this.finish(new CopilotDesktopError('network')); this.close(); }
    });
  }
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run); this.queue = next.catch(() => {}); return next;
  }
  private async readCommand(body: Record<string, unknown>, type: string): Promise<Record<string, unknown>> {
    // A failed credential read must never masquerade as "no secret". Only
    // this exact native worker-capacity error is retried, and only for reads.
    for (let attempt = 0; ; attempt++) {
      try { return await this.command(body, type); }
      catch (error) {
        if (!(error instanceof CopilotDesktopError) || error.category !== 'busy' || attempt >= 2) throw error;
        await new Promise(done => setTimeout(done, attempt === 0 ? 120 : 360));
        if (this.closed) fail('closed');
      }
    }
  }
  private async providers(): Promise<CopilotNativeProvider[]> {
    const result = await this.readCommand({ type: 'list_model_providers' }, 'model_providers_list');
    if (!Array.isArray(result.providers) || result.providers.length > 1000) fail('protocol');
    const providers = result.providers.map(parseProvider);
    if (new Set(providers.map(p => p.id)).size !== providers.length) fail('protocol'); return providers;
  }
  private async models(providerId: string): Promise<CopilotNativeModel[]> {
    const result = await this.readCommand({ type: 'list_provider_models', provider_id: providerId }, 'provider_models_list');
    if (!Array.isArray(result.models) || result.models.length > 10000) fail('protocol');
    const models = result.models.map(model => parseModel(model, providerId));
    if (new Set(models.map(m => m.id)).size !== models.length || new Set(models.map(m => m.modelId)).size !== models.length) fail('protocol'); return models;
  }
  listProviders(): Promise<CopilotNativeProvider[]> { return this.enqueue(() => this.providers()); }
  listModels(providerId: string): Promise<CopilotNativeModel[]> {
    if (!text(providerId)) return Promise.reject(new CopilotDesktopError('configuration'));
    return this.enqueue(() => this.models(providerId));
  }
  sync(rawPlan: CopilotDesktopPlan, options: CopilotDesktopSyncOptions): Promise<CopilotDesktopSyncResult> {
    let plan: CopilotDesktopPlan;
    try { plan = validatePlan(rawPlan); } catch (error) { return Promise.reject(error); }
    if (!options || !Array.isArray(options.ownedProviderIds) || options.ownedProviderIds.some(id => !text(id) || !UUID.test(id)) || new Set(options.ownedProviderIds).size !== options.ownedProviderIds.length) return Promise.reject(new CopilotDesktopError('ownership'));
    if (options.syncScope !== undefined && !['managed', 'selected'].includes(options.syncScope)) return Promise.reject(new CopilotDesktopError('configuration'));
    if (options.syncScope === 'selected' && !options.beforeMutation) return Promise.reject(new CopilotDesktopError('backup'));
    const owned = new Set(options.ownedProviderIds);
    return this.enqueue(async () => {
      const current = await this.providers();
      if (options.syncScope === 'selected') for (const provider of current) if (provider.kind === 'custom' && !provider.accountId) {
        if (!UUID.test(provider.id)) fail('ownership'); owned.add(provider.id);
      }
      for (const provider of current) if (owned.has(provider.id) && (provider.kind !== 'custom' || provider.accountId) || plan.providers.some(p => p.id === provider.id) && !owned.has(provider.id)) fail('ownership');
      const snapshot: CopilotDesktopSnapshot = { providers: [] };
      const wantedModelIds = new Set(plan.providers.flatMap(p => p.models.map(m => m.id)));
      for (const provider of current) {
        const models = await this.models(provider.id);
        if (!owned.has(provider.id) && models.some(m => wantedModelIds.has(m.id))) fail('ownership');
        if (owned.has(provider.id)) snapshot.providers.push({ provider, models });
      }
      await this.guardTrusted();
      if (options.beforeMutation) try { await options.beforeMutation(structuredClone(snapshot)); } catch { fail('backup'); }
      if (options.beforeMutation) await this.guardTrusted();
      const result: CopilotDesktopSyncResult = { providerCount: plan.providers.length, modelCount: plan.providers.reduce((n, p) => n + p.models.length, 0), removedProviderCount: 0, removedModelCount: 0 };
      const expectedProviders = new Map<string, { name: string; settings: Record<string, string> }>();
      for (const input of plan.providers) {
        const name = input.name.startsWith('ModelDock · ') ? input.name : `ModelDock · ${input.name}`;
        const settings = { baseUrl: input.baseUrl, authKind: 'api_key', wireApi: (input.wireApi ?? input.models[0]?.wireApi) === 'responses' ? 'responses' : 'completions', headersJson: JSON.stringify(input.headers ?? {}) };
        const ack = await this.command({ type: 'upsert_model_provider', provider: { id: input.id, name, kind: 'custom', settings }, secret: { kind: 'api_key', value: input.apiKey } }, 'model_provider_upserted', value => object(value.provider) && value.provider.id === input.id);
        const saved = parseProvider(ack.provider);
        if (!saved || saved.kind !== 'custom' || saved.accountId || saved.name !== name || Object.entries(settings).some(([key, value]) => saved.settings[key] !== value)) fail('protocol');
        expectedProviders.set(input.id, { name, settings });
        for (const model of input.models) {
          const native: CopilotNativeModel = { id: model.id, providerId: input.id, modelId: model.modelId, displayName: model.displayName, wireApiOverride: model.wireApi === 'responses' ? 'responses' : 'completions', ...(model.wireModel ? { wireModel: model.wireModel } : {}), ...(model.contextWindow ? { maxPromptTokens: model.contextWindow } : {}), ...(model.maxOutputTokens ? { maxOutputTokens: model.maxOutputTokens } : {}), ...(model.supportedReasoningEfforts ? { supportedReasoningEfforts: model.supportedReasoningEfforts } : {}) };
          await this.command({ type: 'upsert_provider_model', model: native }, 'provider_model_upserted', value => object(value.model) && value.model.id === model.id);
        }
        const desired = new Set(input.models.map(m => m.id));
        for (const old of snapshot.providers.find(p => p.provider.id === input.id)?.models ?? []) if (!desired.has(old.id)) {
          await this.command({ type: 'delete_provider_model', model_id: old.id }, 'provider_model_deleted', value => value.model_id === old.id); result.removedModelCount++;
        }
        const savedModels = await this.models(input.id);
        if (savedModels.length !== input.models.length || input.models.some(model => !savedModels.some(saved => saved.id === model.id && saved.modelId === model.modelId && saved.displayName === model.displayName && (saved.wireModel ?? saved.modelId) === (model.wireModel ?? model.modelId) && saved.wireApiOverride === (model.wireApi === 'responses' ? 'responses' : 'completions') && (model.supportedReasoningEfforts === undefined || JSON.stringify(saved.supportedReasoningEfforts) === JSON.stringify(model.supportedReasoningEfforts))))) fail('protocol');
      }
      for (const { provider } of snapshot.providers) if (!plan.providers.some(p => p.id === provider.id)) {
        await this.command({ type: 'delete_model_provider', provider_id: provider.id }, 'model_provider_deleted', value => value.provider_id === provider.id); result.removedProviderCount++;
      }
      const final = await this.providers();
      if (final.some(provider => owned.has(provider.id) && !plan.providers.some(p => p.id === provider.id))) fail('protocol');
      // A concurrently added source was not part of the encrypted backup.
      // Keep it intact, but do not claim an exclusive synchronization finished.
      if (options.syncScope === 'selected' && final.some(provider => provider.kind === 'custom' && !provider.accountId && !plan.providers.some(p => p.id === provider.id))) fail('protocol');
      for (const [id, wanted] of expectedProviders) {
        const saved = final.find(provider => provider.id === id);
        if (!saved || saved.kind !== 'custom' || saved.accountId || saved.name !== wanted.name || Object.entries(wanted.settings).some(([key, value]) => saved.settings[key] !== value)) fail('protocol');
      }
      return result;
    });
  }

  /** Recover encrypted metadata after the caller restores its opaque OS blobs.
   * No API key is inferred, decoded or rewritten by this operation. */
  restoreSnapshot(raw: CopilotDesktopSnapshot, options: CopilotDesktopSyncOptions): Promise<CopilotDesktopSyncResult> {
    let snapshot: CopilotDesktopSnapshot;
    try {
      snapshot = validateCopilotDesktopSnapshot(raw);
      if (!options || !Array.isArray(options.ownedProviderIds) || options.ownedProviderIds.some(id => !UUID.test(id)) || new Set(options.ownedProviderIds).size !== options.ownedProviderIds.length) fail('configuration');
    } catch (error) { return Promise.reject(error); }
    const owned = new Set(options.ownedProviderIds);
    if (snapshot.providers.some(entry => !owned.has(entry.provider.id))) return Promise.reject(new CopilotDesktopError('ownership'));
    return this.enqueue(async () => {
      const current = await this.providers();
      const wantedModelIds = new Set(snapshot.providers.flatMap(entry => entry.models.map(m => m.id)));
      const before: CopilotDesktopSnapshot = { providers: [] };
      for (const provider of current) {
        if (owned.has(provider.id) && (provider.kind !== 'custom' || provider.accountId)) fail('ownership');
        const models = await this.models(provider.id);
        if (!owned.has(provider.id) && models.some(model => wantedModelIds.has(model.id))) fail('ownership');
        if (owned.has(provider.id)) before.providers.push({ provider, models });
      }
      await this.guardTrusted();
      if (options.beforeMutation) try { await options.beforeMutation(structuredClone(before)); } catch { fail('backup'); }
      if (options.beforeMutation) await this.guardTrusted();
      const result: CopilotDesktopSyncResult = { providerCount: snapshot.providers.length, modelCount: snapshot.providers.reduce((n, p) => n + p.models.length, 0), removedProviderCount: 0, removedModelCount: 0 };
      for (const entry of snapshot.providers) {
        const { provider } = entry;
        const ack = await this.command({ type: 'upsert_model_provider', provider: { id: provider.id, name: provider.name, kind: provider.kind, settings: provider.settings } }, 'model_provider_upserted', value => object(value.provider) && value.provider.id === provider.id);
        const saved = parseProvider(ack.provider);
        if (saved.kind !== 'custom' || saved.accountId || saved.name !== provider.name || JSON.stringify(saved.settings) !== JSON.stringify(provider.settings)) fail('protocol');
        const wantedIds = new Set(entry.models.map(model => model.id));
        for (const old of before.providers.find(p => p.provider.id === provider.id)?.models ?? []) if (!wantedIds.has(old.id)) {
          await this.command({ type: 'delete_provider_model', model_id: old.id }, 'provider_model_deleted', value => value.model_id === old.id); result.removedModelCount++;
        }
        for (const model of entry.models) await this.command({ type: 'upsert_provider_model', model }, 'provider_model_upserted', value => object(value.model) && value.model.id === model.id);
        const models = await this.models(provider.id);
        if (models.length !== entry.models.length || entry.models.some(model => !models.some(saved => saved.id === model.id && JSON.stringify(saved) === JSON.stringify(model)))) fail('protocol');
      }
      for (const { provider } of before.providers) if (!snapshot.providers.some(entry => entry.provider.id === provider.id)) {
        await this.command({ type: 'delete_model_provider', provider_id: provider.id }, 'model_provider_deleted', value => value.provider_id === provider.id); result.removedProviderCount++;
      }
      const final = await this.providers();
      if (final.some(p => owned.has(p.id) && !snapshot.providers.some(entry => entry.provider.id === p.id))) fail('protocol');
      for (const { provider } of snapshot.providers) {
        const saved = final.find(p => p.id === provider.id);
        if (!saved || saved.kind !== 'custom' || saved.accountId || saved.name !== provider.name || JSON.stringify(saved.settings) !== JSON.stringify(provider.settings)) fail('protocol');
      }
      return result;
    });
  }
}
