param([string]$NetworkRoot, [string]$Stage)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
# Exercise the shipping copy routine against the exact package without running UAC or registering a task.
$tokens = $null
$errors = $null
$installer = [Management.Automation.Language.Parser]::ParseFile((Join-Path $NetworkRoot 'windows/install-network.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Invalid Windows network installer' }
foreach ($name in @('Digest', 'Copy-NetworkPayload')) {
    $definition = $installer.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $false)
    if (!$definition) { throw "Missing network installer routine $name" }
    . ([scriptblock]::Create($definition.Extent.Text))
}
$files = [IO.File]::ReadAllText((Join-Path $NetworkRoot 'windows/network-payload.json')) | ConvertFrom-Json
Copy-NetworkPayload $files $NetworkRoot $Stage
if (@(Get-ChildItem -LiteralPath $Stage -Recurse -File).Count -ne @($files.PSObject.Properties).Count) {
    throw 'Incomplete staged Windows network installation'
}
# Load the worker with the isolated, staged interpreter and check its core files exactly as at startup.
& (Join-Path $Stage 'python/python.exe') -I -B -c "import runpy, sys; runpy.run_path(sys.argv[1]); from windows.tun_client import core_path; core_path()" (Join-Path $Stage 'windows/network_worker.py')
if ($LASTEXITCODE -ne 0) { throw 'Staged Windows network worker could not load' }

foreach ($unsafe in @('../escape', 'vendor/../escape', '/rooted', 'C:/rooted', 'vendor\escape', 'vendor//file', 'vendor./file', 'file:stream')) {
    $entry = [pscustomobject]@{ $unsafe = ('0' * 64) }
    try { Copy-NetworkPayload $entry $NetworkRoot $Stage }
    catch { if ($_.Exception.Message -eq 'Invalid network payload entry') { continue }; throw }
    throw 'Network installer accepted an unsafe path'
}
# A valid filename with incorrect contents must still fail the installer's own hash check.
$badHashStage = [IO.Directory]::CreateDirectory((Join-Path $Stage 'bad-hash-test')).FullName
try { Copy-NetworkPayload ([pscustomobject]@{ LICENSE = ('0' * 64) }) $NetworkRoot $badHashStage }
catch { if ($_.Exception.Message -eq 'Network payload checksum mismatch') { exit 0 }; throw }
throw 'Network installer accepted an incorrect file hash'
