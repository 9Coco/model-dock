# SPDX-License-Identifier: GPL-3.0-or-later
# $source, $sid and $digest are supplied as data to this one-time installer.
$ErrorActionPreference = 'Stop'
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
if ($sid -notmatch '^S-1-(\d+-){1,14}\d+$' -or $digest -notmatch '^[0-9a-f]{64}$') { throw 'Invalid install identity' }
$account = [Security.Principal.SecurityIdentifier]::new($sid)
function ProtectedDirectory($path, $public) {
    $sddl = 'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'
    if ($public) { $sddl += '(A;OICI;0x1200a9;;;BU)' }
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetSecurityDescriptorSddlForm($sddl)
    $dir = [IO.Directory]::CreateDirectory($path, $acl)
    if ($dir.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unsafe network install directory' }
    $sections = [Security.AccessControl.AccessControlSections]'Owner,Access'
    if ($dir.GetAccessControl($sections).GetSecurityDescriptorSddlForm($sections) -ne $acl.GetSecurityDescriptorSddlForm($sections)) {
        throw 'Unexpected network directory permissions'
    }
}
function Digest($bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

$manifest = [IO.File]::ReadAllBytes((Join-Path $source 'windows/network-payload.json'))
if ((Digest $manifest) -ne $digest) { throw 'Network manifest checksum mismatch' }
$files = [Text.Encoding]::UTF8.GetString($manifest) | ConvertFrom-Json
$base = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'ModelDock.Network'
ProtectedDirectory $base $true
$owner = Join-Path $base $account.Value
ProtectedDirectory $owner $true
ProtectedDirectory (Join-Path $owner 'state') $false
$target = Join-Path $owner $digest
if (![IO.Directory]::Exists($target)) {
    $stage = Join-Path $owner ([Guid]::NewGuid().ToString('N'))
    ProtectedDirectory $stage $true
    try {
        foreach ($file in $files.PSObject.Properties) {
            if ($file.Name -notmatch '^([a-zA-Z0-9_-]+/)*[a-zA-Z0-9_][a-zA-Z0-9_.-]*$' -or $file.Value -notmatch '^[0-9a-f]{64}$') { throw 'Invalid network payload entry' }
            $dest = Join-Path $stage $file.Name
            [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($dest))
            [IO.File]::Copy((Join-Path $source $file.Name), $dest)
            if ((Get-FileHash -Algorithm SHA256 -LiteralPath $dest).Hash -ne $file.Value) { throw 'Network payload checksum mismatch' }
        }
        [IO.Directory]::Move($stage, $target)
    } finally {
        # Only this installer creates files in its unique, protected staging directory.
        if ([IO.Directory]::Exists($stage)) { [IO.Directory]::Delete($stage, $true) }
    }
}
ProtectedDirectory $target $true
$service = New-Object -ComObject 'Schedule.Service'
$service.Connect()
$folder = $service.GetFolder('\')
$task = $service.NewTask(0)
$task.RegistrationInfo.Description = "ModelDock.Network/$digest"
$task.Principal.UserId = 'S-1-5-18'
$task.Principal.LogonType = 5
$task.Settings.AllowDemandStart = $true
$task.Settings.DisallowStartIfOnBatteries = $false
$task.Settings.StopIfGoingOnBatteries = $false
$task.Settings.ExecutionTimeLimit = 'PT0S'
$task.Settings.MultipleInstances = 2
$action = $task.Actions.Create(0)
$action.Path = Join-Path $target 'python/python.exe'
$action.Arguments = '-I -B "' + (Join-Path $target 'windows/network_worker.py') + '"'
$action.WorkingDirectory = $target
# Task owner must not be the unelevated user, even when they approved UAC with their own account.
$descriptor = "O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;$sid)"
[void]$folder.RegisterTaskDefinition("ModelDock.Network.$sid", $task, 6, 'S-1-5-18', $null, 5, $descriptor)
