import { execFile } from 'node:child_process';
import { win32 } from 'node:path';

export type JetBrainsPreferenceValues = Partial<Record<'idtoken' | 'userlogin' | 'userid', string>>;
const MAX_VALUE = 64 * 1024;
const MAX_NATIVE_VALUE = MAX_VALUE * 6;
const unavailable = '无法安全读取 Windows 中的 JetBrains IDE 本机账号，请检查本机登录和注册表读取权限。';

/** Verified against the installed IDEA 2026.2.4 / JBR 25.0.4.1 Windows
 * java.util.prefs.WindowsPreferences.toJavaValueString/toWindowsValueString.
 * REG_SZ is not the Java value: /A preserves case, \\ is /, // is \\, and
 * /uXXXX encodes UTF-16 code units (including MIME Base64 line breaks).
 * Reject noncanonical/unknown escapes rather than silently repairing data. */
export function decodeWindowsJavaPreference(value: string): string {
  if (typeof value !== 'string' || value.length > MAX_NATIVE_VALUE || /[^\x20-\x7f]/.test(value)) throw new Error(unavailable);
  let result = '';
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === '\\') result += '/';
    else if (char !== '/') {
      if (/[A-Z]/.test(char)) throw new Error(unavailable);
      result += char;
    } else {
      const next = value[++index];
      if (next === '/') result += '\\';
      else if (next && /^[A-Z]$/.test(next)) result += next;
      else if (next === 'u' && /^[\da-f]{4}$/.test(value.slice(index + 1, index + 5))) {
        result += String.fromCharCode(parseInt(value.slice(index + 1, index + 5), 16)); index += 4;
      } else throw new Error(unavailable);
    }
    if (result.length > MAX_VALUE) throw new Error(unavailable);
  }
  return result;
}

// Open exactly the 64-bit JBR user-preference node with KEY_QUERY_VALUE.
// No key creation, enumeration, PasswordSafe, other registry view or fallback.
// Query byte sizes before allocation; a concurrent enlargement fails closed.
export const windowsJetBrainsPreferencesHelper = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
try {
  Add-Type -TypeDefinition @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public static class JetBrainsPreferenceRead {
 [DllImport("advapi32.dll", CharSet=CharSet.Unicode, ExactSpelling=true)] static extern int RegOpenKeyExW(IntPtr key,string subkey,uint options,uint access,out IntPtr result);
 [DllImport("advapi32.dll", CharSet=CharSet.Unicode, ExactSpelling=true)] static extern int RegQueryValueExW(IntPtr key,string name,IntPtr reserved,out uint type,byte[] data,ref uint size);
 [DllImport("advapi32.dll")] static extern int RegCloseKey(IntPtr key);
 public static Dictionary<string,string> Read() {
   var values=new Dictionary<string,string>(); IntPtr key;
   int status=RegOpenKeyExW(new IntPtr(unchecked((int)0x80000001)),@"Software\JavaSoft\Prefs\jetbrains\jetprofile",0,0x101,out key);
   if(status==2) return values; if(status!=0) throw new Exception();
   try {
     foreach(string name in new[]{"idtoken","userlogin","userid"}) {
       uint type,size=0; status=RegQueryValueExW(key,name,IntPtr.Zero,out type,null,ref size);
       if(status==2) continue;
       if(status!=0||type!=1||size<2||size>786434||size%2!=0) throw new Exception();
       byte[] data=new byte[size]; uint capacity=size;
       status=RegQueryValueExW(key,name,IntPtr.Zero,out type,data,ref size);
       if(status!=0||type!=1||size<2||size>capacity||size%2!=0) throw new Exception();
       string value=new UnicodeEncoding(false,false,true).GetString(data,0,(int)size);
       if(value[value.Length-1]!='\0') throw new Exception();
       value=value.Substring(0,value.Length-1);
       if(value.IndexOf('\0')>=0||value.Length>393216) throw new Exception();
       values.Add(name,value);
     }
     return values;
   } finally { RegCloseKey(key); }
 }
}
'@
  $values=[JetBrainsPreferenceRead]::Read()
  [Console]::Out.Write((@{ok=$true;values=$values}|ConvertTo-Json -Compress -Depth 3))
} catch { [Console]::Out.Write('{"ok":false}'); exit 1 }
`;

export type WindowsJetBrainsPreferencesRunner = (file: string, args: string[], options: { timeout: number; maxBuffer: number; windowsHide: true; encoding: 'utf8' }) => Promise<string>;
const run: WindowsJetBrainsPreferencesRunner = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, options, (error, stdout) => error ? reject(new Error(unavailable)) : resolve(stdout));
});

/** Main-process only. Values never cross preload/IPC and no source is written. */
export async function readWindowsJetBrainsPreferences(execute: WindowsJetBrainsPreferencesRunner = run): Promise<JetBrainsPreferenceValues> {
  try {
    const command = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const raw = await execute(command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsJetBrainsPreferencesHelper, 'utf16le').toString('base64')],
      { timeout: 10_000, maxBuffer: MAX_NATIVE_VALUE * 6 + 4096, windowsHide: true, encoding: 'utf8' });
    if (Buffer.byteLength(raw) > MAX_NATIVE_VALUE * 6 + 4096) throw new Error();
    const result: unknown = JSON.parse(raw);
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    const body = result as Record<string, unknown>, values = body.values;
    if (body.ok !== true || !values || typeof values !== 'object' || Array.isArray(values) || Object.keys(body).some(key => !['ok', 'values'].includes(key))) throw new Error();
    const decoded: JetBrainsPreferenceValues = {};
    for (const [key, value] of Object.entries(values)) {
      if (!['idtoken', 'userlogin', 'userid'].includes(key) || typeof value !== 'string') throw new Error();
      decoded[key as keyof JetBrainsPreferenceValues] = decodeWindowsJavaPreference(value);
    }
    return decoded;
  } catch { throw new Error(unavailable); }
}
