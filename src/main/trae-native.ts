import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';
import { TRAE_PROVIDER_IDS, type TraeProviderId } from '../shared/trae';
import { TraeNativeConnectionError, TraeNativeMutationError, isTraeNativeErrorCode, type TraeNativeErrorCode, type TraeNativeClient, type TraeNativeModel } from './trae-sync';
import type { TraeModelConfiguration } from './trae-config';

const runFile = promisify(execFile);
interface ProcessIdentity { pid: number; parentPid: number; executable: string; commandLine: string; signatureStatus: string; signer: string; product: string }
interface Probe { processes: ProcessIdentity[]; listeners: { pid: number; port: number; address: string }[] }
interface Descriptor { version: string; pid: number; port: number; token: string; userDataPath: string; executable: string; appRoot: string; extensionPath: string }
export interface TraeNativeOptions {
  userDataPath: string;
  bridgeAssetsPath: string;
  /** Main-process test seams; never accepted from the renderer. */
  probe?: () => Promise<Probe>;
  install?: (executable: string, appRoot: string, vsix: string, userDataPath: string, extensionsDirectory?: string) => Promise<void>;
  extensionsDirectory?: string;
  activationWaitMs?: number;
}
const unavailable = () => new TraeNativeConnectionError('not-running');
const untrusted = () => new TraeNativeConnectionError('untrusted');
const incompatible = () => new TraeNativeConnectionError('schema-incompatible');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
function canonical(path: string): string { const value = realpathSync(path); return process.platform === 'win32' ? value.toLowerCase() : value; }
function ordinary(path: string, directory: boolean): string {
  const full = resolve(path);
  for (let current = full; ; current = dirname(current)) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || (current !== full || directory ? !stat.isDirectory() : !stat.isFile())) throw untrusted();
    if (dirname(current) === current) break;
  }
  return canonical(full);
}
function jsonFile(path: string, maximum = 128 * 1024): Record<string, unknown> {
  ordinary(path, false); if (lstatSync(path).size > maximum) throw untrusted();
  const value: unknown = JSON.parse(readFileSync(path, 'utf8')); if (!record(value)) throw untrusted(); return value;
}
function hash(path: string): string { ordinary(path, false); if (lstatSync(path).size > 2 * 1024 * 1024) throw untrusted(); return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function flag(command: string, name: string): string | undefined {
  const matched = command.match(new RegExp(`(?:^|\\s)--${name}(?:=|\\s+)(?:"([^"]+)"|'([^']+)'|([^\\s]+))`, 'i'));
  return matched?.[1] ?? matched?.[2] ?? matched?.[3];
}

/** Public OS metadata only. The signed process and its IPv4 listener must agree
 * before even the short-lived bridge authentication token is transmitted. */
async function windowsProbe(): Promise<Probe> {
  if (process.platform !== 'win32') throw new TraeNativeConnectionError('unsupported-platform');
  const script = String.raw`$ErrorActionPreference='Stop'; $OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); $cache=@{}; $rows=@(Get-CimInstance Win32_Process -Filter "Name='Trae CN.exe'"); $processes=@(foreach($p in $rows) { if(!$p.ExecutablePath){continue}; $exe=$p.ExecutablePath; if(!$cache.ContainsKey($exe)){ $sig=Get-AuthenticodeSignature -LiteralPath $exe; $ver=[Diagnostics.FileVersionInfo]::GetVersionInfo($exe); $signer=if($sig.SignerCertificate){$sig.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false)}else{''}; $cache[$exe]=@{status=$sig.Status.ToString();signer=$signer;product=$ver.ProductName} }; $identity=$cache[$exe]; @{pid=[int]$p.ProcessId;parentPid=[int]$p.ParentProcessId;executable=$exe;commandLine=[string]$p.CommandLine;signatureStatus=$identity.status;signer=$identity.signer;product=$identity.product} }); $ids=@($processes|ForEach-Object{$_.pid}); $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {$ids -contains $_.OwningProcess} | ForEach-Object {@{pid=[int]$_.OwningProcess;port=[int]$_.LocalPort;address=[string]$_.LocalAddress}}); @{processes=$processes;listeners=$listeners}|ConvertTo-Json -Depth 5 -Compress`;
  try {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows', shellRoot = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0');
    const { stdout } = await runFile(join(shellRoot, 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024, encoding: 'utf8',
      env: { ...process.env, PSModulePath: join(shellRoot, 'Modules') } });
    const value: unknown = JSON.parse(stdout.replace(/^\uFEFF/, ''));
    if (!record(value) || !Array.isArray(value.processes) || !Array.isArray(value.listeners)) throw untrusted();
    return value as unknown as Probe;
  } catch { throw unavailable(); }
}

function installation(process: ProcessIdentity): { executable: string; appRoot: string } {
  if (process.signatureStatus !== 'Valid' || process.signer !== '北京引力弹弓科技有限公司' || process.product !== 'Trae CN') throw untrusted();
  const executable = ordinary(process.executable, false);
  if (basename(executable).toLowerCase() !== 'trae cn.exe') throw untrusted();
  const appRoot = ordinary(join(dirname(executable), 'resources', 'app'), true), product = jsonFile(join(appRoot, 'product.json'), 2 * 1024 * 1024);
  if (product.applicationName !== 'trae-cn' || product.nameLong !== 'Trae CN' || product.dataFolderName !== '.trae-cn') throw untrusted();
  if (product.appVersion !== '3.4.14') throw new TraeNativeConnectionError('unsupported-version');
  return { executable, appRoot };
}
function profileProcess(pid: number, snapshot: Probe, executable: string, target: string): ProcessIdentity {
  let process = snapshot.processes.find(value => value.pid === pid); const visited = new Set<number>();
  while (process) {
    if (visited.has(process.pid) || visited.size > 16 || canonical(process.executable) !== executable) throw untrusted(); visited.add(process.pid);
    const parent = snapshot.processes.find(value => value.pid === process!.parentPid);
    if (!parent) break;
    process = parent;
  }
  if (!process || /(?:^|\s)--type(?:=|\s)/.test(process.commandLine)) throw untrusted();
  const explicit = flag(process.commandLine, 'user-data-dir');
  const actual = explicit ?? join(processEnvAppData(), 'Trae CN');
  if (ordinary(actual, true) !== target) throw untrusted();
  if (flag(process.commandLine, 'profile')) throw untrusted();
  return process;
}
function processEnvAppData(): string { const value = process.env.APPDATA; if (!value) throw untrusted(); return value; }

function descriptor(value: Record<string, unknown>): Descriptor {
  if (!text(value.version, 64) || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 || !Number.isSafeInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65535
    || typeof value.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token)
    || !['userDataPath', 'executable', 'appRoot', 'extensionPath'].every(key => text(value[key]))) throw untrusted();
  return value as unknown as Descriptor;
}

function rpc(connection: Descriptor, operation: string, payload: object = {}): Promise<Record<string, unknown>> {
  return new Promise((resolveReply, reject) => {
    const mutation = ['add', 'update', 'delete'].includes(operation);
    const failure = (outcome: 'not-applied' | 'unknown' = 'unknown', code?: TraeNativeErrorCode) => mutation ? new TraeNativeMutationError(outcome, code) : new TraeNativeConnectionError(code ?? 'not-running');
    const body = Buffer.from(JSON.stringify({ operation, ...payload }));
    const req = request({ hostname: '127.0.0.1', port: connection.port, path: '/v1/modeldock', method: 'POST', agent: false, headers: {
      authorization: `Bearer ${connection.token}`, 'content-type': 'application/json', 'content-length': body.length,
      'x-modeldock-time': String(Date.now()), 'x-modeldock-nonce': randomBytes(16).toString('hex'),
    } }, res => {
      const chunks: Buffer[] = []; let length = 0;
      res.on('data', chunk => { length += chunk.length; if (length > 4 * 1024 * 1024) res.destroy(failure()); else chunks.push(Buffer.from(chunk)); });
      res.on('error', () => reject(failure()));
      res.on('end', () => {
        try {
          const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!record(value)) throw failure();
          if (res.statusCode !== 200) throw failure(value.outcome === 'not-applied' ? 'not-applied' : 'unknown', isTraeNativeErrorCode(value.code) ? value.code : undefined);
          resolveReply(value);
        } catch (error) { reject(error instanceof TraeNativeMutationError || error instanceof TraeNativeConnectionError ? error : failure()); }
      });
    });
    req.setTimeout(60000, () => req.destroy(failure())); req.on('error', () => reject(failure())); req.end(body);
  });
}

function nativeModel(raw: unknown): TraeNativeModel {
  if (!record(raw) || !Object.values(TRAE_PROVIDER_IDS).includes(raw.provider as TraeProviderId) || !text(raw.custom_model_id, 64) || !/^\d+$/.test(raw.custom_model_id)
    || raw.auth_type !== 0 || typeof raw.status !== 'boolean' || !text(raw.base_url) || !text(raw.display_name, 512)) throw incompatible();
  const provider = raw.provider as TraeProviderId, prefix = `${provider}//`;
  const model = text(raw.model_name) ? raw.model_name : text(raw.name) && raw.name.startsWith(prefix) ? raw.name.slice(prefix.length) : '';
  if (!text(model)) throw incompatible();
  let url: URL; try { url = new URL(raw.base_url); } catch { throw incompatible(); }
  if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw incompatible();
  const params: TraeModelConfiguration['config_detail']['model_hyper_params'] = {};
  for (const key of ['max_tokens', 'prompt_max_tokens'] as const) {
    // Native defaults can represent an unspecified limit as zero or null.
    // Preserve that absence; never publish a fabricated positive model limit.
    if (raw[key] === undefined || raw[key] === null || raw[key] === 0) continue;
    if (!Number.isSafeInteger(raw[key]) || Number(raw[key]) <= 0) throw incompatible(); params[key] = Number(raw[key]);
  }
  if (raw.thinking_enable !== undefined) { if (![0, 1, 2].includes(Number(raw.thinking_enable))) throw incompatible(); params.thinking_enable = Number(raw.thinking_enable) as 0 | 1 | 2; }
  const emptyReasoning = record(raw.reasoning_param) && raw.reasoning_param.parameter === '' && Array.isArray(raw.reasoning_param.values) && raw.reasoning_param.values.length === 0;
  if (raw.reasoning_param !== undefined && raw.reasoning_param !== null && !emptyReasoning) {
    if (!record(raw.reasoning_param) || !text(raw.reasoning_param.parameter, 256) || !Array.isArray(raw.reasoning_param.values) || !raw.reasoning_param.values.length || raw.reasoning_param.values.some(value => !text(value, 128))) throw incompatible();
    params.reasoning_param = { parameter: raw.reasoning_param.parameter, values: raw.reasoning_param.values as string[] };
  }
  const configuration: TraeModelConfiguration = { provider, model_name: model, is_custom: true, ak: '', isAkFromServer: false, auth_type: 0,
    base_url: raw.base_url, display_name: raw.display_name, clearReasoningParam: params.reasoning_param === undefined,
    config_detail: { multimodal: raw.multimodal === true, model_hyper_params: params } };
  const extras = Object.fromEntries(['temperature', 'top_p', 'top_k', 'max_turn', 'updated_at', 'update_time', 'revision'].filter(key => raw[key] !== undefined).map(key => {
    const value = raw[key]; if (!(typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' && value.length <= 256)) throw incompatible(); return [key, value];
  }));
  const fingerprint = createHash('sha256').update(JSON.stringify({ configuration, enabled: raw.status, extras })).digest('hex');
  // No observed native metadata is proven to change on a key-only edit.
  // Keep credentialRevision absent so automatic undo correctly fails closed.
  return { id: raw.custom_model_id, configuration, enabled: raw.status, fingerprint };
}

/** Only called by an explicit synchronization/restore action. Importing this
 * module and reading undo status neither installs an extension nor writes Trae. */
export async function openTraeNativeClient(options: TraeNativeOptions): Promise<TraeNativeClient> {
  let target: string, assets: string, manifest: Record<string, unknown>;
  try {
    target = ordinary(options.userDataPath, true); assets = ordinary(options.bridgeAssetsPath, true); manifest = jsonFile(join(assets, 'package.json'));
    if (manifest.name !== 'trae-bridge' || manifest.publisher !== 'modeldock' || manifest.main !== './extension.cjs' || !text(manifest.version, 64)) throw untrusted();
  } catch { throw untrusted(); }
  const sourceHash = hash(join(assets, 'extension.cjs'));
  const probe = options.probe ?? windowsProbe;
  const connect = async (snapshot: Probe): Promise<Descriptor | undefined> => {
    const storage = join(target, 'User', 'globalStorage', 'modeldock.trae-bridge');
    let files: string[]; try { ordinary(storage, true); files = readdirSync(storage).filter(file => /^bridge-\d+\.json$/.test(file)); } catch { return undefined; }
    for (const file of files.slice(0, 64)) {
      let value: Descriptor;
      try { value = descriptor(jsonFile(join(storage, file))); } catch { continue; }
      const owner = snapshot.processes.find(row => row.pid === value.pid); if (!owner) continue;
      try {
        const install = installation(owner), main = profileProcess(owner.pid, snapshot, install.executable, target);
        if (value.version !== manifest.version || canonical(value.userDataPath) !== target || canonical(value.executable) !== install.executable || canonical(value.appRoot) !== install.appRoot) continue;
        const extensionPath = ordinary(value.extensionPath, true);
        const extensionsRoot = ordinary(options.extensionsDirectory ?? flag(main.commandLine, 'extensions-dir') ?? join(homedir(), '.trae-cn', 'extensions'), true);
        const installedManifest = jsonFile(join(extensionPath, 'package.json'));
        // Trae's normal installer appends installation-only metadata. All
        // executable/declarative extension fields must still match our bundle.
        delete installedManifest.__metadata;
        if (dirname(extensionPath) !== extensionsRoot || basename(extensionPath) !== `modeldock.trae-bridge-${manifest.version}`
          || hash(join(extensionPath, 'extension.cjs')) !== sourceHash || !isDeepStrictEqual(installedManifest, manifest)) continue;
        const listener = snapshot.listeners.filter(row => row.port === value.port);
        if (!listener.length || listener.some(row => row.pid !== value.pid || row.address !== '127.0.0.1')) continue;
        const health = await rpc(value, 'health');
        if (health.version !== manifest.version || health.productVersion !== '3.4.14' || health.pid !== value.pid || typeof health.userDataPath !== 'string' || canonical(health.userDataPath) !== target
          || typeof health.executable !== 'string' || canonical(health.executable) !== install.executable) continue;
        return value;
      } catch { /* Do not disclose descriptor tokens, paths, native replies or credentials. */ }
    }
    return undefined;
  };
  let snapshot = await probe(), connection = await connect(snapshot);
  if (!connection) {
    let unsupportedVersion = false;
    const candidates = new Map<string, { executable: string; appRoot: string; extensionsDirectory?: string }>();
    for (const process of snapshot.processes) try {
      const candidate = installation(process), main = profileProcess(process.pid, snapshot, candidate.executable, target), customExtensions = flag(main.commandLine, 'extensions-dir');
      candidates.set(candidate.executable, { ...candidate, ...(customExtensions ? { extensionsDirectory: ordinary(customExtensions, true) } : {}) });
    } catch (error) { if (error instanceof TraeNativeConnectionError && error.code === 'unsupported-version') unsupportedVersion = true; }
    if (!candidates.size && unsupportedVersion) throw new TraeNativeConnectionError('unsupported-version');
    if (candidates.size !== 1) throw unavailable();
    const candidate = [...candidates.values()][0], vsix = join(assets, 'modeldock-trae-bridge.vsix'); ordinary(vsix, false);
    try {
      const cli = join(candidate.appRoot, 'out', 'cli.js');
      if (options.install) await options.install(candidate.executable, candidate.appRoot, vsix, target, candidate.extensionsDirectory);
      else await runFile(candidate.executable, [ordinary(cli, false), '--user-data-dir', target, '--install-extension', vsix, '--force', ...(candidate.extensionsDirectory ? ['--extensions-dir', candidate.extensionsDirectory] : [])],
        { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: '' } });
    } catch { throw new TraeNativeConnectionError('install-failed'); }
    const until = Date.now() + (options.activationWaitMs ?? 8000);
    do {
      await new Promise(resolveWait => setTimeout(resolveWait, 400)); snapshot = await probe(); connection = await connect(snapshot);
    } while (!connection && Date.now() < until);
    if (!connection) throw new TraeNativeConnectionError('restart-required');
  }
  let closed = false;
  const send = async (operation: string, payload?: object) => {
    if (closed) throw ['add', 'update', 'delete'].includes(operation) ? new TraeNativeMutationError('not-applied', 'not-running') : unavailable();
    if (['add', 'update', 'delete'].includes(operation)) {
      // A previously valid port can be rebound after a host exit. Revalidate
      // its OS owner and trusted extension session before every mutation/key.
      try {
        const current = await connect(await probe());
        if (!current || current.pid !== connection!.pid || current.port !== connection!.port || current.token !== connection!.token) throw untrusted();
      } catch (error) { throw new TraeNativeMutationError('not-applied', error instanceof TraeNativeConnectionError ? error.code : 'untrusted'); }
    }
    return rpc(connection!, operation, payload);
  };
  const mutation = async (operation: 'add' | 'update', configuration: TraeModelConfiguration, id?: string) => {
    const reply = await send(operation, { configuration, ...(id ? { id } : {}) });
    try { return nativeModel(reply.model); } catch { throw new TraeNativeMutationError('unknown'); }
  };
  return {
    targetId: target,
    listModels: async () => {
      const reply = await send('list'); if (!Array.isArray(reply.models) || reply.models.length > 10000) throw incompatible();
      return reply.models.filter(raw => record(raw) && Object.values(TRAE_PROVIDER_IDS).includes(raw.provider as TraeProviderId)).map(nativeModel);
    },
    addModel: configuration => mutation('add', configuration), updateModel: (id, configuration) => mutation('update', configuration, id),
    deleteModel: async id => { await send('delete', { id }); }, close: () => { closed = true; },
  };
}
