import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { captureCopilotCredentials, restoreCopilotCredentials, validateCopilotCredentialBackup, type CopilotLinuxCredentialBackup } from '../src/main/copilot-credentials';
import { copilotLinuxCredentialHelper } from '../src/main/copilot-credentials-linux';

const first = 'b6c4f9bf-9df2-43c5-8964-841f83b4fc6a', second = 'b6c4f9bf-9df2-43c5-8964-841f83b4fc6b';
const collection = '/org/freedesktop/secrets/collection/test';
const entry = (providerId = first, kind: 'api_key' | 'bearer_token' = 'api_key') => ({ kind, blobBase64: Buffer.from([0, 255, 40, 0, 1]).toString('base64'), label: 'Synthetic binary BYOK credential', contentType: 'application/octet-stream', collection, attributes: { service: 'github-copilot-app', username: `byok:${providerId}:${kind === 'api_key' ? 'apiKey' : 'bearerToken'}`, 'preserved-native-metadata': 'Synthetic value' } });
const snapshot = (): CopilotLinuxCredentialBackup => ({ version: 2, platform: 'linux', providers: [{ providerId: first, entries: [entry(), entry(first, 'bearer_token')] }, { providerId: second, entries: [] }] });

describe('Linux exact Copilot credentials protocol', () => {
  it('retains binary bytes, attributes, labels, content type and explicit absence in a separate platform format', async () => {
    const expected = snapshot(), run = vi.fn(async (operation, ids) => { expect(operation).toBe('capture'); expect(ids).toEqual([first, second]); return { ok: true, backup: expected }; });
    const actual = await captureCopilotCredentials([first, second], { platform: 'linux', run });
    expect(actual).toEqual(expected); expect(actual).not.toBe(expected);
    expect(validateCopilotCredentialBackup(actual)).toEqual(expected);
    await restoreCopilotCredentials(actual, { platform: 'linux', run: async (operation, value) => { expect(operation).toBe('restore'); expect(value).toEqual(expected); return { ok: true }; } });
  });
  it('rejects cross-platform recovery journals before native writes and rejects a Windows capture reply on Linux', async () => {
    const run = vi.fn(async () => ({ ok: true, backup: { version: 1, providers: [] } }));
    await expect(restoreCopilotCredentials({ version: 1, providers: [] }, { platform: 'linux', run })).rejects.toMatchObject({ category: 'configuration' });
    await expect(restoreCopilotCredentials(snapshot(), { platform: 'win32', run })).rejects.toMatchObject({ category: 'configuration' });
    expect(run).not.toHaveBeenCalled();
    await expect(captureCopilotCredentials([], { platform: 'linux', run })).rejects.toMatchObject({ category: 'protocol' });
  });
  it('rejects account targets, injected collections, duplicate roles and malformed attributes before any OS operation', async () => {
    const mutations = [
      (v: CopilotLinuxCredentialBackup) => { v.providers[0].entries[0].attributes.username = 'github-account-access-token'; },
      (v: CopilotLinuxCredentialBackup) => { v.providers[0].entries[0].attributes.service = 'other-application'; },
      (v: CopilotLinuxCredentialBackup) => { v.providers[0].entries[0].collection = '/org/freedesktop/secrets/collection/test/other'; },
      (v: CopilotLinuxCredentialBackup) => { v.providers[0].entries[0].blobBase64 = 'invalid private blob'; },
      (v: CopilotLinuxCredentialBackup) => { v.providers[0].entries[0].label = 'INVALID\0LABEL'; },
      (v: CopilotLinuxCredentialBackup) => { v.providers[0].entries.push(entry()); },
      (v: CopilotLinuxCredentialBackup) => { (v.providers[0].entries[0] as any).targetName = 'account'; },
    ];
    const run = vi.fn();
    for (const mutate of mutations) { const invalid = snapshot(); mutate(invalid); await expect(restoreCopilotCredentials(invalid, { platform: 'linux', run })).rejects.toMatchObject({ category: 'configuration' }); }
    expect(run).not.toHaveBeenCalled();
  });
  it.each(['backend-unavailable', 'locked-keyring', 'ambiguous-credential', 'collection-changed'])('exposes a controlled %s explanation without native credential diagnostics', async code => {
    const error = await captureCopilotCredentials([first], { platform: 'linux', run: async () => ({ ok: false, code, diagnostics: 'PRIVATE_BYTES ACCOUNT_NAME' }) }).catch(e => e);
    expect(error).toMatchObject({ category: code }); expect(String(error)).not.toMatch(/PRIVATE_BYTES|ACCOUNT_NAME/);
  });
});

// 修改点：实际执行同一个 Python helper，注入内存 D-Bus 服务；不连接或读取本机钥匙串。
// 使用合成二进制数据，检查精确 SearchItems、加密会话、恢复验证以及失败前没有写操作。
const bootstrap = String.raw`
import sys, json, io, types, base64
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.padding import PKCS7
fixture = json.load(sys.stdin)
sys.stdin = io.StringIO(json.dumps(fixture['request']))
state = fixture.get('items',{})
log = []
KEY = b'\x01' * 32
IV = b'\x02' * 16
def encrypt(raw, content):
    p = PKCS7(128).padder(); padded = p.update(raw) + p.finalize()
    cipher = Cipher(algorithms.AES(KEY),modes.CBC(IV)).encryptor()
    return ('/org/freedesktop/secrets/session/test',IV,cipher.update(padded)+cipher.finalize(),content)
def decrypt(secret):
    cipher = Cipher(algorithms.AES(KEY),modes.CBC(secret[1])).decryptor()
    padded = cipher.update(secret[2])+cipher.finalize()
    p = PKCS7(128).unpadder(); return p.update(padded)+p.finalize()
class Connection:
    def close(self): log.append(['connection','Close'])
class Wrapper:
    def __init__(self,path,interface,connection): self.path,self.interface = path,interface
    def get_property(self,name):
        log.append([self.path,'Get',name])
        if self.interface.endswith('.Collection'):
            if name != 'Locked': raise ValueError('Forbidden collection enumeration')
            return self.path in fixture.get('lockedCollections',[])
        e = state[self.path]
        if name == 'Attributes': return dict(e['attributes'])
        if name == 'Label': return e['label']
        if name == 'Locked': return e.get('locked',False)
        raise ValueError('Forbidden property')
    def set_property(self,name,signature,value):
        log.append([self.path,'Set',name])
        if name == 'Label': state[self.path]['label'] = value
        elif name == 'Attributes': state[self.path]['attributes'] = value
        else: raise ValueError()
    def call(self,method,signature,*args):
        if method == 'SearchItems':
            log.append([self.path,method,args[0]])
            matches = [p for p,e in state.items() if all(e['attributes'].get(k)==v for k,v in args[0].items())]
            return ([p for p in matches if not state[p].get('locked')],[p for p in matches if state[p].get('locked')])
        log.append([self.path,method])
        if method == 'GetSecret':
            e = state[self.path]
            return (encrypt(base64.b64decode(e['blobBase64']),e['contentType']),)
        if method == 'SetSecret':
            e = state[self.path]; e['blobBase64'] = base64.b64encode(decrypt(args[0])).decode(); e['contentType'] = args[0][3]
            return ()
        if method == 'Delete':
            del state[self.path]; return ('/',)
        if method == 'CreateItem':
            props,secret,_ = args; p = self.path+'/created'+str(len(state))
            state[p] = {'kind':'api_key','collection':self.path,'attributes':props['org.freedesktop.Secret.Item.Attributes'][1],'label':props['org.freedesktop.Secret.Item.Label'][1],'contentType':secret[3],'blobBase64':base64.b64encode(decrypt(secret)).decode()}
            if fixture.get('corruptWrite'): state[p]['blobBase64'] = base64.b64encode(b'corrupted fixture').decode()
            return (p,'/')
        if method == 'Close': return ()
        raise ValueError('Unexpected method')
secretstorage = types.ModuleType('secretstorage'); secretstorage.dbus_init = Connection
util = types.ModuleType('secretstorage.util'); util.DBusAddressWrapper = Wrapper
def session(_):
    log.append(['session','OpenSession'])
    return types.SimpleNamespace(encrypted=not fixture.get('plain'),aes_key=KEY,object_path='/org/freedesktop/secrets/session/test')
util.open_session = session; util.format_secret = lambda session,raw,content: encrypt(raw,content)
sys.modules['secretstorage'] = secretstorage; sys.modules['secretstorage.util'] = util
`;
function runFixture(request: unknown, items: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const stdout = execFileSync('/usr/bin/python3', ['-I', '-c', `${bootstrap}\n${copilotLinuxCredentialHelper}\nprint(json.dumps({'state':state,'log':log},separators=(',',':')))`], { input: JSON.stringify({ request, items, ...extra }), encoding: 'utf8' });
  const lines = stdout.trim().split('\n'); return { response: JSON.parse(lines[0]), ...JSON.parse(lines[1]) };
}
describe.skipIf(process.platform !== 'linux')('fixed Linux helper with a synthetic encrypted Secret Service', () => {
  it('captures only exact BYOK attributes, preserves opaque bytes/metadata, and never enumerates an account or collection', () => {
    const items = { [`${collection}/first`]: entry(), [`${collection}/foreign`]: { ...entry(), attributes: { service: 'other-app', username: 'github-account' } } };
    const result = runFixture({ operation: 'capture', providerIds: [first, second] }, items);
    expect(result.response).toEqual({ ok: true, backup: { version: 2, platform: 'linux', providers: [{ providerId: first, entries: [entry()] }, { providerId: second, entries: [] }] } });
    expect(result.log.filter((v: any) => v[1] === 'SearchItems').map((v: any) => v[2])).toEqual([entry().attributes, entry(first, 'bearer_token').attributes, entry(second).attributes, entry(second, 'bearer_token').attributes].map(({ service, username }) => ({ service, username })));
    expect(result.log.some((v: any) => v[0] === `${collection}/foreign`)).toBe(false);
    expect(result.log.some((v: any) => ['CreateItem', 'Delete', 'SetSecret'].includes(v[1]))).toBe(false);
  });
  it('recreates the original collection entry and metadata, restores prior absence, and leaves unrelated credentials untouched', () => {
    const backup: CopilotLinuxCredentialBackup = { version: 2, platform: 'linux', providers: [{ providerId: first, entries: [entry()] }] };
    const foreign = { ...entry(), attributes: { service: 'other-app', username: 'account' } };
    const result = runFixture({ operation: 'restore', backup }, { [`${collection}/bearer`]: entry(first, 'bearer_token'), [`${collection}/foreign`]: foreign });
    expect(result.response).toEqual({ ok: true }); expect(result.state[`${collection}/foreign`]).toEqual(foreign);
    expect(result.state[`${collection}/bearer`]).toBeUndefined();
    expect(Object.values(result.state)).toContainEqual(entry());
    expect(result.log.some((v: any) => v[1] === 'GetSecret')).toBe(true);
  });
  it.each(['locked', 'duplicate', 'plain', 'lockedCollection'])('stops before writes for %s and never downgrades an encrypted session', mode => {
    const original = entry(), items: Record<string, unknown> = { [`${collection}/first`]: { ...original, locked: mode === 'locked' } };
    if (mode === 'duplicate') items[`${collection}/duplicate`] = original;
    const result = runFixture({ operation: 'capture', providerIds: [first] }, items, { plain: mode === 'plain', lockedCollections: mode === 'lockedCollection' ? [collection] : [] });
    expect(result.response.ok).toBe(false);
    expect(result.log.some((v: any) => ['CreateItem', 'Delete', 'SetSecret', 'Set'].includes(v[1]))).toBe(false);
  });
  it('does not report a corrupt native restore as successful', () => {
    const backup: CopilotLinuxCredentialBackup = { version: 2, platform: 'linux', providers: [{ providerId: first, entries: [entry()] }] };
    const result = runFixture({ operation: 'restore', backup }, {}, { corruptWrite: true });
    expect(result.response.ok).toBe(false); expect(result.log.some((v: any) => v[1] === 'GetSecret')).toBe(true);
  });
  it('refuses a changed collection before any write, keeping retries free from duplicate items', () => {
    const backup: CopilotLinuxCredentialBackup = { version: 2, platform: 'linux', providers: [{ providerId: first, entries: [entry()] }] };
    const result = runFixture({ operation: 'restore', backup }, { '/org/freedesktop/secrets/collection/changed/first': { ...entry(), collection: '/org/freedesktop/secrets/collection/changed' } });
    expect(result.response).toEqual({ ok: false, code: 'collection-changed' });
    expect(result.log.some((v: any) => ['CreateItem', 'Delete', 'SetSecret', 'Set'].includes(v[1]))).toBe(false);
  });
  it('validates every restore entry before opening D-Bus or touching the synthetic keyring', () => {
    const invalid = snapshot(); invalid.providers[1].entries = [{ ...entry(second), attributes: { service: 'other-app', username: 'github-account' } }];
    const result = runFixture({ operation: 'restore', backup: invalid });
    expect(result.response).toEqual({ ok: false }); expect(result.log).toEqual([]);
  });
});
