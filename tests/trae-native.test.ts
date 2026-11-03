import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { once } from 'node:events';
import { openTraeNativeClient, type TraeNativeOptions } from '../src/main/trae-native';
import type { TraeModelConfiguration } from '../src/main/trae-config';

const roots: string[] = [], servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const canonical = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
const configuration: TraeModelConfiguration = { provider: 'custom_responses_compatible', model_name: 'fixture-model', is_custom: true, ak: 'SYNTHETIC_MODEL_KEY', isAkFromServer: false,
  auth_type: 0, base_url: 'https://fixture.example.test/v1/responses', display_name: 'ModelDock fixture', clearReasoningParam: true,
  config_detail: { multimodal: true, model_hyper_params: { max_tokens: 4096, prompt_max_tokens: 28000, thinking_enable: 1 } } };
const rawModel = () => ({ custom_model_id: '123456', provider: configuration.provider, name: `${configuration.provider}//${configuration.model_name}`, base_url: configuration.base_url,
  display_name: configuration.display_name, status: true, auth_type: 0, multimodal: true, max_tokens: 4096, prompt_max_tokens: 28000, thinking_enable: 1 });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'modeldock-trae-native-')); roots.push(root);
  const target = join(root, 'user data'), assets = join(root, 'assets'), extension = join(root, 'extensions', 'modeldock.trae-bridge-0.1.2'), exe = join(root, 'installation', 'Trae CN.exe');
  const appRoot = join(dirname(exe), 'resources', 'app'), descriptorPath = join(target, 'User', 'globalStorage', 'modeldock.trae-bridge', 'bridge-1234.json');
  const write = (path: string, content: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
  const manifest = { name: 'trae-bridge', publisher: 'modeldock', main: './extension.cjs', version: '0.1.2' };
  for (const directory of [assets, extension]) { write(join(directory, 'package.json'), JSON.stringify({ ...manifest, ...(directory === extension ? { __metadata: { installedTimestamp: 123, source: 'vsix' } } : {}) })); write(join(directory, 'extension.cjs'), '/* Synthetic trusted bridge */'); }
  write(join(assets, 'modeldock-trae-bridge.vsix'), 'Synthetic VSIX'); write(exe, 'Synthetic signed executable');
  write(join(appRoot, 'product.json'), JSON.stringify({ applicationName: 'trae-cn', nameLong: 'Trae CN', dataFolderName: '.trae-cn', appVersion: '3.4.14' }));
  mkdirSync(target, { recursive: true });
  const requests: { operation: string; headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }[] = [];
  let reply: ((operation: string) => { status?: number; value: unknown } | undefined) | undefined;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); requests.push({ operation: body.operation, headers: req.headers, body });
    let result = reply?.(body.operation);
    result ??= { value: body.operation === 'health' ? { version: '0.1.2', productVersion: '3.4.14', pid: 1234, userDataPath: canonical(target), executable: canonical(exe) }
      : body.operation === 'list' ? { models: [{ name: 'Built-in model', status: true }, rawModel()] }
        : body.operation === 'delete' ? {} : { model: rawModel() } };
    res.writeHead(result.status ?? 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result.value));
  });
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const descriptor = { version: '0.1.2', pid: 1234, port, token: 'a'.repeat(64), userDataPath: canonical(target), executable: canonical(exe), appRoot: canonical(appRoot), extensionPath: canonical(extension) };
  const publish = () => write(descriptorPath, JSON.stringify(descriptor)); publish();
  const processIdentity = { pid: 1234, parentPid: 1, executable: exe, commandLine: `"${exe}" --user-data-dir "${target}"`, signatureStatus: 'Valid', signer: '北京引力弹弓科技有限公司', product: 'Trae CN' };
  const snapshot = { processes: [processIdentity], listeners: [{ pid: 1234, port, address: '127.0.0.1' }] };
  const install = vi.fn(async (): Promise<void> => { throw new Error('Synthetic installer denied'); });
  const options: TraeNativeOptions = { userDataPath: target, bridgeAssetsPath: assets, probe: vi.fn(async () => structuredClone(snapshot)), install,
    extensionsDirectory: dirname(extension), activationWaitMs: 0 };
  return { root, target, assets, extension, exe, descriptor, descriptorPath, publish, snapshot, options, install, requests, write, setReply: (fn: typeof reply) => { reply = fn; } };
}

describe('Trae native HTTP bridge client and identity checks', () => {
  it('verifies the local bridge before sending a model key and normalizes only native compatible custom models', async () => {
    const f = await fixture(), client = await openTraeNativeClient(f.options);
    expect(client.targetId).toBe(canonical(f.target)); expect(f.install).not.toHaveBeenCalled();
    const models = await client.listModels();
    expect(models).toHaveLength(1); expect(models[0]).toMatchObject({ id: '123456', configuration: { ...configuration, ak: '' }, enabled: true });
    expect(models[0].credentialRevision).toBeUndefined(); expect(models[0].metadataRevisionCoversCredentials).toBeUndefined();
    const added = await client.addModel(configuration); expect(added.configuration.ak).toBe('');
    await client.updateModel('123456', configuration); await client.deleteModel('123456');
    expect(f.requests.map(row => row.operation)).toEqual(['health', 'list', 'health', 'add', 'health', 'update', 'health', 'delete']);
    expect(f.requests[0].body).not.toHaveProperty('configuration');
    const nonces = f.requests.map(row => row.headers['x-modeldock-nonce']); expect(new Set(nonces).size).toBe(nonces.length);
    for (const row of f.requests) { expect(row.headers.authorization).toBe(`Bearer ${'a'.repeat(64)}`); expect(row.headers['x-modeldock-nonce']).toMatch(/^[a-f0-9]{32}$/); }
    client.close(); await expect(client.listModels()).rejects.toThrow('无法连接');
  });

  it('never returns unexpected native secret fields in snapshots or fingerprints', async () => {
    const f = await fixture(); f.setReply(operation => operation === 'list' ? { value: { models: [{ ...rawModel(), ak: 'SYNTHETIC_NATIVE_SECRET', token: 'SYNTHETIC_LOGIN_TOKEN' }] } } : undefined);
    const client = await openTraeNativeClient(f.options), model = (await client.listModels())[0];
    expect(JSON.stringify(model)).not.toContain('SYNTHETIC_NATIVE_SECRET'); expect(JSON.stringify(model)).not.toContain('SYNTHETIC_LOGIN_TOKEN');
    expect(model.configuration.ak).toBe(''); client.close();
  });

  it.each(['signature', 'profile', 'port-owner', 'source-hash'] as const)('does not authenticate to a descriptor with invalid %s evidence', async defect => {
    const f = await fixture();
    if (defect === 'signature') f.snapshot.processes[0].signatureStatus = 'NotSigned';
    if (defect === 'profile') f.snapshot.processes[0].commandLine = `"${f.exe}" --user-data-dir "${f.root}"`;
    if (defect === 'port-owner') f.snapshot.listeners[0].pid = 9999;
    if (defect === 'source-hash') f.write(join(f.extension, 'extension.cjs'), '/* Unexpected modification */');
    await expect(openTraeNativeClient(f.options)).rejects.toThrow();
    expect(f.requests).toEqual([]);
  });

  it('requires health to confirm the same target and does not follow a descriptor into another profile', async () => {
    const f = await fixture(); f.setReply(operation => operation === 'health' ? { value: { version: '0.1.2', productVersion: '3.4.14', pid: 1234, userDataPath: f.root, executable: f.exe } } : undefined);
    await expect(openTraeNativeClient(f.options)).rejects.toThrow();
    expect(f.requests.map(row => row.operation)).toEqual(['health']);
    expect(f.requests[0].body).toEqual({ operation: 'health' });
  });

  it('uses the verified executable and exact profile to install the bundled helper only when explicitly opened', async () => {
    const f = await fixture(); rmSync(f.descriptorPath);
    f.install.mockImplementation(async () => { f.publish(); });
    expect(f.install).not.toHaveBeenCalled();
    const client = await openTraeNativeClient(f.options);
    expect(f.install).toHaveBeenCalledExactlyOnceWith(canonical(f.exe), canonical(join(dirname(f.exe), 'resources', 'app')), join(canonical(f.assets), 'modeldock-trae-bridge.vsix'), canonical(f.target), undefined);
    expect(await client.listModels()).toHaveLength(1); client.close();
  });

  it.each(['not-applied', 'unknown'] as const)('keeps native mutation %s outcomes while suppressing raw error text', async outcome => {
    const f = await fixture(); f.setReply(operation => operation === 'add' ? { status: 400, value: { outcome, error: 'SYNTHETIC_PRIVATE_KEY_IN_ERROR' } } : undefined);
    const client = await openTraeNativeClient(f.options), error = await client.addModel(configuration).catch(error => error);
    expect(error).toMatchObject({ name: 'TraeNativeMutationError', outcome }); expect(error.message).not.toContain('SYNTHETIC_PRIVATE'); client.close();
  });

  it('treats an unrecognized successful mutation response as unknown instead of claiming success or retrying', async () => {
    const f = await fixture(); f.setReply(operation => operation === 'add' ? { value: { model: { unexpected: true } } } : undefined);
    const client = await openTraeNativeClient(f.options);
    await expect(client.addModel(configuration)).rejects.toMatchObject({ outcome: 'unknown' });
    expect(f.requests.filter(row => row.operation === 'add')).toHaveLength(1); client.close();
  });

  it('normalizes native zero and null token limits to unspecified without inventing model budgets', async () => {
    const f = await fixture(); f.setReply(operation => operation === 'list' ? { value: { models: [{ ...rawModel(), max_tokens: 0, prompt_max_tokens: null, reasoning_param: { parameter: '', values: [] } }] } } : undefined);
    const client = await openTraeNativeClient(f.options), model = (await client.listModels())[0];
    expect(model.configuration.config_detail.model_hyper_params).toEqual({ thinking_enable: 1 }); client.close();
  });

  it('rejects an unverified Trae product version before authentication or installation', async () => {
    const f = await fixture();
    f.write(join(dirname(f.exe), 'resources', 'app', 'product.json'), JSON.stringify({ applicationName: 'trae-cn', nameLong: 'Trae CN', dataFolderName: '.trae-cn', appVersion: '9.9.9' }));
    await expect(openTraeNativeClient(f.options)).rejects.toMatchObject({ code: 'unsupported-version' });
    expect(f.requests).toEqual([]); expect(f.install).not.toHaveBeenCalled();
  });

  it('rechecks the listener before a key-bearing write and rejects a replaced host without sending the key', async () => {
    const f = await fixture(), client = await openTraeNativeClient(f.options);
    f.snapshot.listeners[0].pid = 9876;
    await expect(client.addModel(configuration)).rejects.toMatchObject({ outcome: 'not-applied', code: 'untrusted' });
    expect(f.requests.map(row => row.operation)).toEqual(['health']); client.close();
  });

  it('preserves the verified custom extensions directory when installing the bridge', async () => {
    const f = await fixture(); rmSync(f.descriptorPath);
    f.snapshot.processes[0].commandLine += ` --extensions-dir "${dirname(f.extension)}"`;
    f.install.mockImplementation(async () => { f.publish(); });
    const client = await openTraeNativeClient(f.options);
    expect(f.install).toHaveBeenCalledExactlyOnceWith(canonical(f.exe), canonical(join(dirname(f.exe), 'resources', 'app')), join(canonical(f.assets), 'modeldock-trae-bridge.vsix'), canonical(f.target), canonical(dirname(f.extension)));
    client.close();
  });

  it('surfaces only allowlisted actionable native error codes', async () => {
    const f = await fixture(); f.setReply(operation => operation === 'list' ? { status: 400, value: { outcome: 'not-applied', code: 'login-required', error: 'SYNTHETIC_PRIVATE_NATIVE_MESSAGE' } } : undefined);
    const client = await openTraeNativeClient(f.options), error = await client.listModels().catch(error => error);
    expect(error).toMatchObject({ code: 'login-required' }); expect(error.message).toContain('登录'); expect(error.message).not.toContain('SYNTHETIC_PRIVATE'); client.close();
  });
});
