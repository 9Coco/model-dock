import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { collectLinuxCopilotProcessEvidence, isVerifiedLinuxCopilotProcess } from './copilot-process-linux';

interface Identity {
  pid: number;
  parentPid: number;
  startedAt: string;
  filename?: string;
  directoryHash?: string;
  productName?: string;
  companyName?: string;
  signatureStatus?: string;
  signerName?: string;
}
interface Listener { pid: number; port: number; address: string }
export interface CopilotProcessEvidence {
  published: Identity;
  listener: Identity;
  ancestry: Identity[];
  listeners: Listener[];
  stable: boolean;
}
export class CopilotProcessVerificationError extends Error {
  constructor(readonly category: 'unsupported-platform') { super('当前系统没有可验证的官方 Copilot 进程身份接口，未连接或发送凭据。'); }
}
const number = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 0xffffffff;
const company = (value: unknown): string => typeof value === 'string' ? value.toLowerCase().replace(/[\s.,]/g, '') : '';
const identity = (value: unknown): value is Identity => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Identity;
  return number(item.pid) && typeof item.parentPid === 'number' && Number.isSafeInteger(item.parentPid) && item.parentPid >= 0
    && typeof item.startedAt === 'string' && Number.isFinite(Date.parse(item.startedAt));
};
function official(item: Identity): boolean {
  // Verified against the official Windows desktop binary's public metadata:
  // github.exe / GitHub Copilot / GitHub Inc. / Valid / GitHub, Inc.
  return item.filename?.toLowerCase() === 'github.exe' && item.productName === 'GitHub Copilot'
    && company(item.companyName) === 'githubinc' && item.signatureStatus === 'Valid' && company(item.signerName) === 'githubinc'
    && typeof item.directoryHash === 'string' && /^[a-f0-9]{64}$/.test(item.directoryHash);
}

/** Pure verification of narrowly scoped OS evidence. A file name or a PID alone
 * is insufficient: the listener must be the signed app or its verified child.
 */
export function isVerifiedCopilotProcess(value: unknown, pid: number, port: number): boolean {
  if (!number(pid) || !Number.isInteger(port) || port < 1 || port > 65535 || value === null || typeof value !== 'object') return false;
  const proof = value as CopilotProcessEvidence;
  if (proof.stable !== true || !identity(proof.published) || !identity(proof.listener) || proof.published.pid !== pid || !official(proof.published) || !official(proof.listener)) return false;
  if (proof.published.directoryHash !== proof.listener.directoryHash || !Array.isArray(proof.listeners) || !proof.listeners.length || proof.listeners.length > 8) return false;
  // The actual client connects to 127.0.0.1, never a wildcard/remote binding.
  if (!proof.listeners.some(item => item && item.address === '127.0.0.1') || proof.listeners.some(item => !item || item.port !== port || item.pid !== proof.listener.pid || !['127.0.0.1', '::1'].includes(item.address))) return false;
  if (proof.listener.pid === pid) return proof.listener.startedAt === proof.published.startedAt;
  if (!Array.isArray(proof.ancestry) || proof.ancestry.length < 2 || proof.ancestry.length > 9) return false;
  const chain = proof.ancestry;
  if (!chain.every(identity)) return false;
  if (chain[0].pid !== proof.listener.pid || chain[0].startedAt !== proof.listener.startedAt || chain.at(-1)?.pid !== pid || chain.at(-1)?.startedAt !== proof.published.startedAt) return false;
  const seen = new Set<number>();
  for (let index = 0; index < chain.length; index++) {
    const current = chain[index]; if (!identity(current) || seen.has(current.pid)) return false; seen.add(current.pid);
    const parent = chain[index + 1];
    if (parent && (!identity(parent) || current.parentPid !== parent.pid || Date.parse(parent.startedAt) > Date.parse(current.startedAt))) return false;
  }
  return true;
}

// Only numeric PID/port are inputs. No command line, token, profile contents,
// credential manager or user-account identity is read. Installation paths are
// hashed in the helper and never included in its output or renderer messages.
const WINDOWS_EVIDENCE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$verificationStage = 'process'
try {
  $verificationStage = 'security-module'
  Import-Module -Name (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
  $verificationStage = 'process'
  $copilotTargetPid = [uint32]$env:MODELDOCK_COPILOT_VERIFY_PID
  $copilotTargetPort = [uint16]$env:MODELDOCK_COPILOT_VERIFY_PORT
  # Read-only Windows IP Helper avoids slow CIM network-provider initialization.
  # Return only listening IPv4 entries for the client-specified local port.
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Net;
using System.Runtime.InteropServices;
public class ModelDockCopilotListener { public long OwningProcess; public int LocalPort; public string LocalAddress; }
public static class ModelDockCopilotTcpIdentity {
 [DllImport("iphlpapi.dll", SetLastError=true)] static extern uint GetExtendedTcpTable(IntPtr table, ref int length, bool ordered, int family, int tableClass, uint reserved);
 public static ModelDockCopilotListener[] List(int targetPort) {
  int length=0; uint error=GetExtendedTcpTable(IntPtr.Zero,ref length,false,2,3,0);
  if ((error!=0 && error!=122) || length<4 || length>16777216) throw new InvalidOperationException();
  IntPtr table=Marshal.AllocHGlobal(length);
  try {
   error=GetExtendedTcpTable(table,ref length,false,2,3,0); if(error!=0) throw new InvalidOperationException();
   uint count=unchecked((uint)Marshal.ReadInt32(table)); if(count>(length-4)/24) throw new InvalidOperationException();
   List<ModelDockCopilotListener> found=new List<ModelDockCopilotListener>();
   for(int i=0;i<count;i++) {
    int offset=4+i*24; uint state=unchecked((uint)Marshal.ReadInt32(table,offset)); uint rawPort=unchecked((uint)Marshal.ReadInt32(table,offset+8));
    int port=(int)(((rawPort&255)<<8)|((rawPort>>8)&255)); if(state!=2 || port!=targetPort) continue;
    uint address=unchecked((uint)Marshal.ReadInt32(table,offset+4)); uint owner=unchecked((uint)Marshal.ReadInt32(table,offset+20));
    found.Add(new ModelDockCopilotListener { OwningProcess=owner, LocalPort=port, LocalAddress=new IPAddress(BitConverter.GetBytes(address)).ToString() });
   }
   return found.ToArray();
  } finally { Marshal.FreeHGlobal(table); }
 }
}
'@ | Out-Null
  function ProcessInfo([uint32]$target) {
    $p = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId=' + $target) -Property ProcessId,ParentProcessId,ExecutablePath,CreationDate
    if ($null -eq $p -or [string]::IsNullOrEmpty($p.ExecutablePath)) { throw 'unavailable' }
    return $p
  }
  function PublicIdentity($p) {
    $script:verificationStage = 'version'
    $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($p.ExecutablePath)
    $script:verificationStage = 'signature'
    $signature = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $p.ExecutablePath
    $script:verificationStage = 'publisher'
    $publisher = if ($null -eq $signature.SignerCertificate) { '' } else { $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false) }
    $script:verificationStage = 'directory-hash'
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $directory = [IO.Path]::GetFullPath([IO.Path]::GetDirectoryName($p.ExecutablePath)).ToUpperInvariant(); $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($directory))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
    $script:verificationStage = 'public-fields'
    return @{ pid=[int64]$p.ProcessId; parentPid=[int64]$p.ParentProcessId; startedAt=$p.CreationDate.ToUniversalTime().ToString('o'); filename=[IO.Path]::GetFileName($p.ExecutablePath); directoryHash=$hash; productName=$version.ProductName; companyName=$version.CompanyName; signatureStatus=$signature.Status.ToString(); signerName=$publisher }
  }
  function MinimalIdentity($p) { return @{pid=[int64]$p.ProcessId;parentPid=[int64]$p.ParentProcessId;startedAt=$p.CreationDate.ToUniversalTime().ToString('o')} }
  $published = ProcessInfo $copilotTargetPid
  $verificationStage = 'listeners'
  $connections = @([ModelDockCopilotTcpIdentity]::List($copilotTargetPort))
  if ($connections.Count -lt 1 -or $connections.Count -gt 8) { throw 'unavailable' }
  $owners = @($connections | Select-Object -ExpandProperty OwningProcess -Unique)
  if ($owners.Count -ne 1) { throw 'unavailable' }
  $listener = if ($owners[0] -eq $published.ProcessId) { $published } else { ProcessInfo ([uint32]$owners[0]) }
  $verificationStage = 'ancestry'
  $chain = New-Object System.Collections.Generic.List[object]
  $current = $listener
  for ($depth=0; $depth -lt 9; $depth++) {
    $chain.Add((MinimalIdentity $current))
    if ($current.ProcessId -eq $published.ProcessId) { break }
    if ($current.ParentProcessId -eq 0) { throw 'unavailable' }
    $current = ProcessInfo ([uint32]$current.ParentProcessId)
  }
  $verificationStage = 'signature'
  $public = PublicIdentity $published
  $owner = if ($listener.ProcessId -eq $published.ProcessId) { $public } else { PublicIdentity $listener }
  $verificationStage = 'recheck'
  $publishedAfter = ProcessInfo $copilotTargetPid
  $listenerAfter = if ($listener.ProcessId -eq $published.ProcessId) { $publishedAfter } else { ProcessInfo ([uint32]$listener.ProcessId) }
  $connectionsAfter = @([ModelDockCopilotTcpIdentity]::List($copilotTargetPort))
  $beforePorts = ($connections | ForEach-Object { [string]$_.LocalAddress + ':' + [string]$_.LocalPort + ':' + [string]$_.OwningProcess } | Sort-Object) -join '|'
  $afterPorts = ($connectionsAfter | ForEach-Object { [string]$_.LocalAddress + ':' + [string]$_.LocalPort + ':' + [string]$_.OwningProcess } | Sort-Object) -join '|'
  $stable = $published.CreationDate -eq $publishedAfter.CreationDate -and $published.ExecutablePath -eq $publishedAfter.ExecutablePath -and $listener.CreationDate -eq $listenerAfter.CreationDate -and $listener.ExecutablePath -eq $listenerAfter.ExecutablePath -and $beforePorts -eq $afterPorts
  $result = @{published=$public;listener=$owner;ancestry=$chain.ToArray();listeners=@($connections | ForEach-Object { @{pid=[int64]$_.OwningProcess;port=[int]$_.LocalPort;address=[string]$_.LocalAddress} });stable=[bool]$stable}
  $verificationStage = 'json'
  [Console]::Out.Write(($result | ConvertTo-Json -Depth 6 -Compress))
} catch { [Console]::Out.Write((@{failedStage=$script:verificationStage;errorType=$_.Exception.GetType().FullName;line=$_.InvocationInfo.ScriptLineNumber} | ConvertTo-Json -Compress)); exit 1 }
`;

interface VerificationOptions {
  platform?: NodeJS.Platform;
  inspect?: (pid: number, port: number) => Promise<unknown>;
}
/** Diagnostic evidence is limited to public process/signature/listener fields.
 * It is not a renderer API and never includes paths, command lines or tokens. */
export function collectCopilotProcessEvidence(pid: number, port: number): Promise<unknown> {
  if (!number(pid) || !Number.isInteger(port) || port < 1 || port > 65535) return Promise.resolve({ failedStage: 'invalid-target' });
  // 修改点：Linux 通过 /proc 和系统安装权限验证，Windows 继续使用签名证据。
  if (process.platform === 'linux') return collectLinuxCopilotProcessEvidence(pid, port);
  return new Promise(resolve => {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
    const shell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    execFile(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_EVIDENCE_SCRIPT], {
      windowsHide: true, timeout: 8500, maxBuffer: 8192, encoding: 'utf8',
      env: { ...process.env, PSModulePath: join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'), MODELDOCK_COPILOT_VERIFY_PID: String(pid), MODELDOCK_COPILOT_VERIFY_PORT: String(port) },
    }, (error, stdout) => {
      if (error && !stdout) { resolve({ failedStage: error.killed ? 'timeout' : 'inspection' }); return; }
      try { resolve(JSON.parse(stdout)); } catch { resolve(undefined); }
    });
  });
}
export async function verifyCopilotDesktopProcess(pid: number, port: number, options: VerificationOptions = {}): Promise<boolean> {
  if (!number(pid) || !Number.isInteger(port) || port < 1 || port > 65535) return false;
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32' && platform !== 'linux') throw new CopilotProcessVerificationError('unsupported-platform');
  if (platform === 'linux') {
    try { return isVerifiedLinuxCopilotProcess(await (options.inspect ?? collectLinuxCopilotProcessEvidence)(pid, port), pid, port); }
    catch { return false; }
  }
  try { return isVerifiedCopilotProcess(await (options.inspect ?? collectCopilotProcessEvidence)(pid, port), pid, port); }
  catch { return false; }
}
