import { execFile } from 'node:child_process';

export interface CopilotLinuxCredentialEntry {
  kind: 'api_key' | 'bearer_token';
  blobBase64: string;
  attributes: Record<string, string>;
  label: string;
  contentType: string;
  collection: string;
}
export interface CopilotLinuxCredentialBackup {
  version: 2;
  platform: 'linux';
  providers: Array<{ providerId: string; entries: CopilotLinuxCredentialEntry[] }>;
}
export class CopilotLinuxTransportError extends Error {
  constructor(readonly category: 'timeout' | 'protocol' | 'read' | 'write') { super(category); }
}

// 修改点：Linux Copilot 1.1.27 使用 dbus-secret-service-keyring-store 1.0.1。
// 只按该实现的 service + username 查两个 BYOK 项，绝不列举账户或整个钥匙串。
// 固定 helper 通过 stdin/stdout 交换不透明备份，秘密不会出现在 argv、日志或临时文件。
// 使用系统 python3-secretstorage 的加密会话；缺失依赖、锁定、歧义或提示均停止操作。
export const copilotLinuxCredentialHelper = String.raw`
import sys, json, base64, re
MAX = 2 * 1024 * 1024
UUID = re.compile(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$')
COLLECTION = re.compile(r'^/org/freedesktop/secrets/collection/[A-Za-z0-9_]+$')
SERVICE = 'github-copilot-app'
SS = 'org.freedesktop.Secret.'
KINDS = ('api_key', 'bearer_token')
class Stopped(Exception):
    def __init__(self, code):
        self.code = code
def text(v, limit):
    return isinstance(v, str) and len(v) <= limit and '\0' not in v
def attrs(provider, kind):
    return {'service': SERVICE, 'username': 'byok:' + provider + ':' + ('apiKey' if kind == 'api_key' else 'bearerToken')}
def valid_ids(ids):
    return isinstance(ids, list) and len(ids) <= 1000 and all(isinstance(i, str) and UUID.fullmatch(i) for i in ids) and len(set(ids)) == len(ids)
def valid_entry(provider, e):
    if not isinstance(e, dict) or set(e) != {'kind','blobBase64','attributes','label','contentType','collection'} or e['kind'] not in KINDS:
        return False
    a = e['attributes']
    if not isinstance(a, dict) or not 2 <= len(a) <= 32 or any(not text(k, 256) or not k or not text(v, 8192) for k,v in a.items()) or any(a.get(k) != v for k,v in attrs(provider,e['kind']).items()):
        return False
    if not text(e['label'],2048) or not text(e['contentType'],256) or not e['contentType'] or not isinstance(e['collection'],str) or not COLLECTION.fullmatch(e['collection']):
        return False
    try:
        raw = base64.b64decode(e['blobBase64'], validate=True)
        return len(raw) <= 16384 and base64.b64encode(raw).decode('ascii') == e['blobBase64']
    except Exception:
        return False
def valid_backup(b):
    if not isinstance(b,dict) or set(b) != {'version','platform','providers'} or b['version'] != 2 or b['platform'] != 'linux' or not isinstance(b['providers'],list):
        return False
    if not valid_ids([p.get('providerId') if isinstance(p,dict) else None for p in b['providers']]):
        return False
    for p in b['providers']:
        if set(p) != {'providerId','entries'} or not isinstance(p['entries'],list) or len(p['entries']) > 2 or any(not valid_entry(p['providerId'], e) for e in p['entries']) or len({e['kind'] for e in p['entries']}) != len(p['entries']):
            return False
    return True
def main():
    raw = sys.stdin.read(MAX + 1)
    if len(raw) > MAX:
        raise ValueError()
    request = json.loads(raw)
    if not isinstance(request,dict):
        raise ValueError()
    operation = request.get('operation')
    if operation == 'capture':
        if set(request) != {'operation','providerIds'} or not valid_ids(request['providerIds']):
            raise ValueError()
    elif operation == 'restore':
        if set(request) != {'operation','backup'} or not valid_backup(request['backup']):
            raise ValueError()
    else:
        raise ValueError()
    try:
        import secretstorage
        from secretstorage.util import DBusAddressWrapper, open_session, format_secret
    except ImportError:
        return {'ok': False, 'code': 'backend-unavailable'}
    connection = secretstorage.dbus_init()
    service = DBusAddressWrapper('/org/freedesktop/secrets', SS + 'Service', connection)
    session = None
    def encrypted_session():
        nonlocal session
        if session is None:
            session = open_session(connection)
        # 不把现有加密会话降级为明文 D-Bus 消息；无法协商时保留原配置。
        if not session.encrypted:
            raise ValueError()
        return session
    def item(provider, kind):
        unlocked, locked = service.call('SearchItems','a{ss}',attrs(provider,kind))
        if locked:
            raise Stopped('locked-keyring')
        if len(unlocked) > 1:
            raise Stopped('ambiguous-credential')
        if not unlocked:
            return None
        path = unlocked[0]
        collection = str(path).rsplit('/',1)[0]
        if not COLLECTION.fullmatch(collection):
            raise ValueError()
        result = DBusAddressWrapper(path, SS + 'Item', connection)
        a = result.get_property('Attributes')
        if result.get_property('Locked'):
            raise Stopped('locked-keyring')
        if any(a.get(k) != v for k,v in attrs(provider,kind).items()):
            raise ValueError()
        return result, collection, dict(a)
    def capture(provider, kind):
        found = item(provider,kind)
        if found is None:
            return None
        native, collection, a = found
        if DBusAddressWrapper(collection, SS + 'Collection', connection).get_property('Locked'):
            raise Stopped('locked-keyring')
        active = encrypted_session()
        secret, = native.call('GetSecret','o',active.object_path)
        if str(secret[0]) != active.object_path:
            raise ValueError()
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        from cryptography.hazmat.primitives.padding import PKCS7
        decryptor = Cipher(algorithms.AES(active.aes_key), modes.CBC(bytes(secret[1]))).decryptor()
        padded = decryptor.update(bytes(secret[2])) + decryptor.finalize()
        unpad = PKCS7(128).unpadder()
        secret_bytes = unpad.update(padded) + unpad.finalize()
        e = {'kind':kind,'blobBase64':base64.b64encode(secret_bytes).decode('ascii'),'attributes':a,'label':native.get_property('Label'),'contentType':str(secret[3]),'collection':collection}
        if not valid_entry(provider,e):
            raise ValueError()
        return e
    def remove(native):
        prompt, = native.call('Delete','')
        if prompt != '/':
            raise ValueError()
    try:
        if operation == 'capture':
            providers = []
            for provider in request['providerIds']:
                entries = []
                for kind in KINDS:
                    e = capture(provider,kind)
                    if e is not None:
                        entries.append(e)
                providers.append({'providerId':provider,'entries':entries})
            result = {'ok':True,'backup':{'version':2,'platform':'linux','providers':providers}}
            if len(json.dumps(result)) > MAX:
                raise ValueError()
            return result
        # 先验证全部匹配与目标集合，再开始任何写入，避免后面的锁定项导致部分恢复。
        work = []
        for provider in request['backup']['providers']:
            present = {e['kind']:e for e in provider['entries']}
            for kind in KINDS:
                found = item(provider['providerId'],kind)
                e = present.get(kind)
                collection = None
                if e is not None:
                    collection = DBusAddressWrapper(e['collection'],SS + 'Collection',connection)
                    if collection.get_property('Locked'):
                        raise Stopped('locked-keyring')
                    # 不跨集合先建后删：中断会留下两个同域项，无法在下一次安全判定。
                    if found is not None and found[1] != e['collection']:
                        raise Stopped('collection-changed')
                work.append((provider['providerId'],kind,found,e,collection))
        if any(e is not None for _,_,_,e,_ in work):
            encrypted_session()
        for provider,kind,found,e,collection in work:
            if e is None:
                if found is not None:
                    remove(found[0])
                if item(provider,kind) is not None:
                    raise ValueError()
                continue
            secret = format_secret(session,base64.b64decode(e['blobBase64']),e['contentType'])
            if found is not None and found[1] == e['collection']:
                native = found[0]
                native.call('SetSecret','(oayays)',secret)
                native.set_property('Label','s',e['label'])
                native.set_property('Attributes','a{ss}',e['attributes'])
            else:
                props = {SS+'Item.Label':('s',e['label']),SS+'Item.Attributes':('a{ss}',e['attributes'])}
                new_path,prompt = collection.call('CreateItem','a{sv}(oayays)b',props,secret,False)
                if prompt != '/' or not str(new_path).startswith(e['collection']+'/'):
                    raise ValueError()
            # 恢复后再次读同一个精确域，验证字节、元数据和集合，绝不把写调用成功当恢复成功。
            if capture(provider,kind) != e:
                raise ValueError()
        return {'ok':True}
    finally:
        if session is not None:
            try:
                DBusAddressWrapper(session.object_path, SS+'Session',connection).call('Close','')
            except Exception:
                pass
        connection.close()
try:
    response = main()
except Stopped as error:
    response = {'ok':False,'code':error.code}
except Exception:
    response = {'ok':False}
print(json.dumps(response,separators=(',',':')))
`;

export function runLinuxCopilotCredentials(operation: 'capture' | 'restore', payload: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = execFile('/usr/bin/python3', ['-I', '-c', copilotLinuxCredentialHelper], { timeout: 15000, maxBuffer: 3 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      if (error) { reject(new CopilotLinuxTransportError(error.killed ? 'timeout' : operation === 'capture' ? 'read' : 'write')); return; }
      try { resolve(JSON.parse(stdout.trim())); } catch { reject(new CopilotLinuxTransportError('protocol')); }
    });
    child.stdin?.on('error', () => { /* 上层只接收受控错误，不转发秘密或本机诊断。 */ });
    child.stdin?.end(JSON.stringify(operation === 'capture' ? { operation, providerIds: payload } : { operation, backup: payload }));
  });
}
