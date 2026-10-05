import { execFile } from 'node:child_process';

// Windows Copilot desktop 1.1.26: native-keyring Generic credentials are stored
// at byok:<provider UUID>:apiKey.github-copilot-app (or bearerToken). Never
// enumerate/read account credentials or decode the credential's opaque blob.
export interface CopilotCredentialEntry {
  kind: 'api_key' | 'bearer_token'; blobBase64: string; flags: number; persist: number;
  userName: string | null; comment: string | null; targetAlias: string | null;
  attributes: Array<{ keyword: string; flags: number; valueBase64: string }>;
}
export interface CopilotCredentialBackup { version: 1; providers: Array<{ providerId: string; entries: CopilotCredentialEntry[] }> }
export interface CopilotCredentialOptions {
  platform?: string;
  run?: (operation: 'capture' | 'restore', payload: unknown) => Promise<unknown>;
}
type Failure = 'unsupported-platform' | 'configuration' | 'read' | 'write' | 'protocol' | 'timeout';
const errors: Record<Failure, string> = {
  'unsupported-platform': '当前系统没有可验证的 Copilot 钥匙串备份接口，未清理原供应商。',
  configuration: 'Copilot 凭据备份范围或格式无效，未操作钥匙串。',
  read: '无法完整备份 Copilot 供应商凭据，未继续清理原供应商。',
  write: '无法完整恢复 Copilot 供应商凭据，请保留恢复记录后重试。',
  protocol: 'Copilot 钥匙串备份接口返回格式有误，未继续操作。',
  timeout: 'Copilot 钥匙串操作超时，请保留恢复记录后重试。',
};
export class CopilotCredentialError extends Error {
  constructor(readonly category: Failure) { super(errors[category]); this.name = 'CopilotCredentialError'; }
}
function fail(kind: Failure): never { throw new CopilotCredentialError(kind); }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function identifiers(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 1000 || value.some(id => typeof id !== 'string' || !uuid.test(id)) || new Set(value).size !== value.length) fail('configuration');
  return [...value] as string[];
}
function knownKeys(value: Record<string, unknown>, keys: string[]): boolean { return Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key)); }
function nullableText(value: unknown, max: number): value is string | null { return value === null || typeof value === 'string' && value.length <= max && !value.includes('\0'); }
function unsigned(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 0xffffffff; }
function blob(value: unknown, max: number): value is string {
  if (typeof value !== 'string' || value.length > Math.ceil(max / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  const bytes = Buffer.from(value, 'base64'); return bytes.length <= max && bytes.toString('base64') === value;
}
function backup(value: unknown): CopilotCredentialBackup {
  if (!object(value) || !knownKeys(value, ['version', 'providers']) || value.version !== 1 || !Array.isArray(value.providers)) fail('configuration');
  const ids = identifiers(value.providers.map(p => object(p) ? p.providerId : undefined));
  for (const provider of value.providers) {
    if (!object(provider) || !knownKeys(provider, ['providerId', 'entries']) || !Array.isArray(provider.entries) || provider.entries.length > 2) fail('configuration');
    const kinds = new Set<string>();
    for (const entry of provider.entries) {
      if (!object(entry) || !knownKeys(entry, ['kind', 'blobBase64', 'flags', 'persist', 'userName', 'comment', 'targetAlias', 'attributes']) || !['api_key', 'bearer_token'].includes(entry.kind as string) || kinds.has(entry.kind as string) || !blob(entry.blobBase64, 16384) || !unsigned(entry.flags) || ![1, 2, 3].includes(entry.persist as number) || !nullableText(entry.userName, 1024) || !nullableText(entry.comment, 2048) || !nullableText(entry.targetAlias, 1024) || !Array.isArray(entry.attributes) || entry.attributes.length > 16) fail('configuration');
      kinds.add(entry.kind as string);
      const keywords = new Set<string>();
      for (const attribute of entry.attributes) {
        if (!object(attribute) || !knownKeys(attribute, ['keyword', 'flags', 'valueBase64']) || typeof attribute.keyword !== 'string' || !attribute.keyword.length || !nullableText(attribute.keyword, 256) || keywords.has(attribute.keyword) || !unsigned(attribute.flags) || !blob(attribute.valueBase64, 8192)) fail('configuration'); keywords.add(attribute.keyword);
      }
    }
  }
  // Retain bytes exactly; an opaque backup is not a decrypted API-key DTO.
  const result = structuredClone(value) as unknown as CopilotCredentialBackup;
  if (JSON.stringify(result).length > 2 * 1024 * 1024 || result.providers.length !== ids.length) fail('configuration'); return result;
}
/** Pure validation for decrypting a recovery journal; performs no OS access. */
export function validateCopilotCredentialBackup(value: unknown): CopilotCredentialBackup { return backup(value); }

const powershell = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
public class CopilotCredentialAttribute { public string keyword; public uint flags; public string valueBase64; }
public class CopilotCredentialEntry { public string kind; public string blobBase64; public uint flags; public uint persist; public string userName; public string comment; public string targetAlias; public CopilotCredentialAttribute[] attributes; }
public class CopilotCredentialProvider { public string providerId; public CopilotCredentialEntry[] entries; }
public static class ModelDockCopilotCredentials {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Credential { public uint Flags; public uint Type; public string TargetName; public string Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist; public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Attribute { public string Keyword; public uint Flags; public uint ValueSize; public IntPtr Value; }
 [DllImport("Advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);
 [DllImport("Advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredWriteW(ref Credential credential, uint flags);
 [DllImport("Advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredDeleteW(string target, uint type, uint flags);
 [DllImport("Advapi32.dll")] static extern void CredFree(IntPtr buffer);
 static string Target(string providerId, string kind) { Guid id; if (!Guid.TryParseExact(providerId, "D", out id)) throw new InvalidOperationException(); if (kind != "api_key" && kind != "bearer_token") throw new InvalidOperationException(); return "byok:" + providerId + ":" + (kind == "api_key" ? "apiKey" : "bearerToken") + ".github-copilot-app"; }
 static string Bytes(IntPtr value, uint size, uint max) { if (size > max || (size > 0 && value == IntPtr.Zero)) throw new InvalidOperationException(); byte[] bytes = new byte[size]; if (size > 0) Marshal.Copy(value, bytes, 0, (int)size); return Convert.ToBase64String(bytes); }
 static CopilotCredentialEntry Read(string providerId, string kind) {
  string target = Target(providerId, kind); IntPtr ptr;
  if (!CredReadW(target, 1, 0, out ptr)) { int error = Marshal.GetLastWin32Error(); if (error == 1168) return null; throw new Win32Exception(error); }
  try {
   Credential c = (Credential)Marshal.PtrToStructure(ptr, typeof(Credential)); if (c.Type != 1 || c.TargetName != target || c.AttributeCount > 16) throw new InvalidOperationException();
   List<CopilotCredentialAttribute> attributes = new List<CopilotCredentialAttribute>(); int size = Marshal.SizeOf(typeof(Attribute));
   for (int i=0; i<c.AttributeCount; i++) { Attribute a = (Attribute)Marshal.PtrToStructure(IntPtr.Add(c.Attributes, i*size), typeof(Attribute)); attributes.Add(new CopilotCredentialAttribute { keyword=a.Keyword, flags=a.Flags, valueBase64=Bytes(a.Value,a.ValueSize,8192) }); }
   return new CopilotCredentialEntry { kind=kind,blobBase64=Bytes(c.CredentialBlob,c.CredentialBlobSize,16384),flags=c.Flags,persist=c.Persist,userName=c.UserName,comment=c.Comment,targetAlias=c.TargetAlias,attributes=attributes.ToArray() };
  } finally { CredFree(ptr); }
 }
 public static CopilotCredentialProvider[] Capture(string[] providerIds) { List<CopilotCredentialProvider> result = new List<CopilotCredentialProvider>(); foreach(string id in providerIds) { List<CopilotCredentialEntry> entries = new List<CopilotCredentialEntry>(); foreach(string kind in new [] {"api_key","bearer_token"}) { CopilotCredentialEntry entry = Read(id,kind); if (entry != null) entries.Add(entry); } result.Add(new CopilotCredentialProvider { providerId=id, entries=entries.ToArray() }); } return result.ToArray(); }
 static void Write(string providerId, CopilotCredentialEntry e) {
  string target=Target(providerId,e.kind); byte[] bytes=Convert.FromBase64String(e.blobBase64); IntPtr blob=IntPtr.Zero,attrs=IntPtr.Zero; List<IntPtr> values=new List<IntPtr>(); int initialized=0; int size=Marshal.SizeOf(typeof(Attribute));
  try {
   if (bytes.Length>0) { blob=Marshal.AllocHGlobal(bytes.Length); Marshal.Copy(bytes,0,blob,bytes.Length); }
   if(e.attributes.Length>0) attrs=Marshal.AllocHGlobal(size*e.attributes.Length);
   for(int i=0;i<e.attributes.Length;i++) { byte[] v=Convert.FromBase64String(e.attributes[i].valueBase64); IntPtr vp=IntPtr.Zero; if(v.Length>0){vp=Marshal.AllocHGlobal(v.Length);Marshal.Copy(v,0,vp,v.Length);} values.Add(vp); Attribute a=new Attribute{Keyword=e.attributes[i].keyword,Flags=e.attributes[i].flags,ValueSize=(uint)v.Length,Value=vp};Marshal.StructureToPtr(a,IntPtr.Add(attrs,i*size),false); initialized++; }
   Credential c=new Credential { Flags=e.flags,Type=1,TargetName=target,Comment=e.comment,CredentialBlobSize=(uint)bytes.Length,CredentialBlob=blob,Persist=e.persist,AttributeCount=(uint)e.attributes.Length,Attributes=attrs,TargetAlias=e.targetAlias,UserName=e.userName };
   if(!CredWriteW(ref c,0)) throw new Win32Exception(Marshal.GetLastWin32Error());
  } finally { if(blob!=IntPtr.Zero) Marshal.FreeHGlobal(blob); for(int i=0;i<initialized;i++)Marshal.DestroyStructure(IntPtr.Add(attrs,i*size),typeof(Attribute));foreach(IntPtr value in values)if(value!=IntPtr.Zero)Marshal.FreeHGlobal(value);if(attrs!=IntPtr.Zero)Marshal.FreeHGlobal(attrs); }
 }
 public static void Restore(string providerId,CopilotCredentialEntry[] entries) {
  HashSet<string> present=new HashSet<string>();foreach(CopilotCredentialEntry entry in entries)present.Add(entry.kind);
  foreach(string kind in new [] {"api_key","bearer_token"})if(!present.Contains(kind)&&!CredDeleteW(Target(providerId,kind),1,0)){int error=Marshal.GetLastWin32Error();if(error!=1168)throw new Win32Exception(error);}
  foreach(CopilotCredentialEntry entry in entries)Write(providerId,entry);
 }
}
'@
try {
 $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
 if ($request.operation -eq 'capture') {
  $providers = [ModelDockCopilotCredentials]::Capture([string[]]$request.providerIds)
  @{ok=$true;backup=@{version=1;providers=@($providers)}} | ConvertTo-Json -Depth 12 -Compress
 } elseif ($request.operation -eq 'restore') {
  foreach($provider in $request.backup.providers) {
   $entries=@();foreach($entry in $provider.entries){$native=New-Object CopilotCredentialEntry;$native.kind=$entry.kind;$native.blobBase64=$entry.blobBase64;$native.flags=$entry.flags;$native.persist=$entry.persist;$native.userName=$entry.userName;$native.comment=$entry.comment;$native.targetAlias=$entry.targetAlias;$attributes=@();foreach($attribute in $entry.attributes){$a=New-Object CopilotCredentialAttribute;$a.keyword=$attribute.keyword;$a.flags=$attribute.flags;$a.valueBase64=$attribute.valueBase64;$attributes+=$a};$native.attributes=[CopilotCredentialAttribute[]]$attributes;$entries+=$native}
   [ModelDockCopilotCredentials]::Restore([string]$provider.providerId,[CopilotCredentialEntry[]]$entries)
  }
  @{ok=$true} | ConvertTo-Json -Compress
 } else { @{ok=$false} | ConvertTo-Json -Compress }
} catch { @{ok=$false} | ConvertTo-Json -Compress }
`;

function runWindows(operation: 'capture' | 'restore', payload: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const process = execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(powershell, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10000, maxBuffer: 3 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      if (error) { reject(new CopilotCredentialError(error.killed ? 'timeout' : operation === 'capture' ? 'read' : 'write')); return; }
      try { resolve(JSON.parse(stdout.trim())); } catch { reject(new CopilotCredentialError('protocol')); }
    });
    process.stdin?.on('error', () => { /* Only controlled callback errors escape. */ });
    process.stdin?.end(JSON.stringify(operation === 'capture' ? { operation, providerIds: payload } : { operation, backup: payload }));
  });
}
async function invoke(operation: 'capture' | 'restore', value: unknown, options: CopilotCredentialOptions): Promise<Record<string, unknown>> {
  if ((options.platform ?? process.platform) !== 'win32') fail('unsupported-platform');
  let result: unknown;
  try { result = await (options.run ?? runWindows)(operation, value); }
  catch (error) { if (error instanceof CopilotCredentialError) throw error; fail(operation === 'capture' ? 'read' : 'write'); }
  if (!object(result) || typeof result.ok !== 'boolean') fail('protocol');
  if (!result.ok) fail(operation === 'capture' ? 'read' : 'write'); return result;
}
/** Main-process only. The caller must encrypt this object before any deletion. */
export async function captureCopilotCredentials(providerIds: readonly string[], options: CopilotCredentialOptions = {}): Promise<CopilotCredentialBackup> {
  const ids = identifiers(providerIds);
  const result = await invoke('capture', ids, options);
  let value: CopilotCredentialBackup; try { value = backup(result.backup); } catch { fail('protocol'); }
  if (value.providers.length !== ids.length || value.providers.some((p, index) => p.providerId !== ids[index])) fail('protocol'); return value;
}
/** Restores the exact two app-owned targets per ID, including prior absence. */
export async function restoreCopilotCredentials(value: CopilotCredentialBackup, options: CopilotCredentialOptions = {}): Promise<void> {
  const copy = backup(value); await invoke('restore', copy, options);
}
