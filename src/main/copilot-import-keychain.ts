import { execFile } from 'node:child_process';
import { join } from 'node:path';

// Read exactly the Copilot CLI service/account slot; never enumerate a vault.
// Linux/Windows use the same keyring account '<https://github.com>:<login>'.
export const linuxCopilotImportHelper = String.raw`
import sys, json, re
class Stopped(Exception):
    def __init__(self,code): self.code=code
def main():
    key=sys.stdin.read(512)
    if not re.fullmatch(r'https://github\.com:[A-Za-z0-9][A-Za-z0-9-]{0,38}',key): raise Stopped('format')
    try:
        import secretstorage
        from secretstorage.util import DBusAddressWrapper, open_session
    except ImportError: raise Stopped('backend')
    connection=secretstorage.dbus_init()
    service=DBusAddressWrapper('/org/freedesktop/secrets','org.freedesktop.Secret.Service',connection)
    attrs={'service':'copilot-cli','username':key}
    unlocked,locked=service.call('SearchItems','a{ss}',attrs)
    if locked: raise Stopped('locked')
    if len(unlocked)>1: raise Stopped('ambiguous')
    if not unlocked: return {'ok':True}
    item=DBusAddressWrapper(unlocked[0],'org.freedesktop.Secret.Item',connection)
    if item.get_property('Locked'): raise Stopped('locked')
    actual=item.get_property('Attributes')
    if any(actual.get(k)!=v for k,v in attrs.items()): raise Stopped('format')
    session=open_session(connection)
    if not session.encrypted: raise Stopped('backend')
    value,=item.call('GetSecret','o',session.object_path)
    if str(value[0])!=session.object_path or len(value[2])>32784: raise Stopped('format')
    from cryptography.hazmat.primitives.ciphers import Cipher,algorithms,modes
    from cryptography.hazmat.primitives.padding import PKCS7
    decrypt=Cipher(algorithms.AES(session.aes_key),modes.CBC(bytes(value[1]))).decryptor()
    padded=decrypt.update(bytes(value[2]))+decrypt.finalize()
    unpad=PKCS7(128).unpadder()
    token=(unpad.update(padded)+unpad.finalize()).decode('utf-8')
    if not re.fullmatch(r'(?:gho_|ghu_|github_pat_)[A-Za-z0-9_]+',token) or len(token)>32768: raise Stopped('format')
    return {'ok':True,'token':token}
try: print(json.dumps(main(),separators=(',',':')))
except Stopped as error: print(json.dumps({'ok':False,'code':error.code}))
except Exception: print('{"ok":false,"code":"read"}')
`;

export const windowsCopilotImportHelper = String.raw`
$ErrorActionPreference='Stop'
try {
  $accountKey=[Console]::In.ReadToEnd()
  if($accountKey -notmatch '^https://github\.com:[A-Za-z0-9][A-Za-z0-9-]{0,38}$'){throw 'format'}
  Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class CopilotImportRead {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Credential { public uint Flags; public uint Type; public string TargetName; public string Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist; public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
 [DllImport("Advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CredReadW(string target,uint type,uint flags,out IntPtr credential);
 [DllImport("Advapi32.dll")] static extern void CredFree(IntPtr pointer);
 public static string Read(string key) {
   string target=key+".copilot-cli"; IntPtr pointer;
   if(!CredReadW(target,1,0,out pointer)){if(Marshal.GetLastWin32Error()==1168)return null;throw new Exception();}
   try {var c=(Credential)Marshal.PtrToStructure(pointer,typeof(Credential));if(c.Type!=1||c.TargetName!=target||c.UserName!=key||c.CredentialBlobSize>32768)throw new Exception();byte[] bytes=new byte[c.CredentialBlobSize];Marshal.Copy(c.CredentialBlob,bytes,0,bytes.Length);return new UTF8Encoding(false,true).GetString(bytes);}finally{CredFree(pointer);}
 }
}
'@
  $value=[CopilotImportRead]::Read($accountKey)
  @{ok=$true;token=$value}|ConvertTo-Json -Compress
} catch { @{ok=$false;code='read'}|ConvertTo-Json -Compress }
`;

const messages: Record<string, string> = {
  locked: 'Copilot CLI 系统钥匙串已锁定，请先解锁再导入。',
  ambiguous: 'Copilot CLI 同一账号存在多条系统凭据，无法确定要导入的授权。',
  backend: 'Copilot CLI 系统凭据暂不可读取；Linux 需要 python3-secretstorage 和可用的加密钥匙串。',
  read: '无法读取此 Copilot CLI 系统凭据，请在 ModelDock 直接登录 GitHub。',
  format: 'Copilot CLI 系统凭据格式不受支持，请在 ModelDock 直接登录 GitHub。',
};

function command(file: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout: 10_000, maxBuffer: 48_000, windowsHide: true, encoding: 'utf8' }, (error, stdout) => error ? reject(new Error(messages.read)) : resolve(stdout));
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}
export async function readCopilotCliKeychain(accountKey: string, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  if (!/^https:\/\/github\.com:[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(accountKey)) throw new Error('Copilot CLI 账号标识无效。');
  if (platform === 'darwin') {
    try { return (await command('/usr/bin/security', ['find-generic-password', '-s', 'copilot-cli', '-a', accountKey, '-w'])).trim(); }
    catch { throw new Error(messages.read); }
  }
  if (platform !== 'linux' && platform !== 'win32') throw new Error('当前系统没有受支持的 Copilot CLI 凭据读取方式。');
  let raw: string;
  try {
    raw = platform === 'linux' ? await command('/usr/bin/python3', ['-c', linuxCopilotImportHelper], accountKey)
      : await command(join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsCopilotImportHelper], accountKey);
  } catch { throw new Error(messages.read); }
  try {
    const result = JSON.parse(raw);
    if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') throw new Error();
    if (!result.ok) throw new Error(messages[result.code] ?? messages.read);
    if (result.token == null) return undefined;
    if (typeof result.token !== 'string' || result.token.length > 32768) throw new Error();
    return result.token;
  } catch (error) {
    if (error instanceof Error && Object.values(messages).includes(error.message)) throw error;
    throw new Error(messages.format);
  }
}
