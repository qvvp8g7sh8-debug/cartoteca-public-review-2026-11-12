param([switch]$Stop, [switch]$Demo, [switch]$Open)
$ErrorActionPreference = 'Stop'
$localRoot = Split-Path $PSScriptRoot -Parent
$localRootItem = Get-Item -LiteralPath $localRoot
if ($localRootItem.LinkType -eq 'Junction') {
    $localRoot = [IO.Path]::GetFullPath([string]$localRootItem.Target)
}
$localHome = Split-Path $localRoot -Parent
$localState = Join-Path $localHome 'operations/local-processes.json'
$localNode = (Get-Command node.exe -ErrorAction Stop).Source
$localEntries = @()
if (Test-Path -LiteralPath $localState) {
    $localEntries = @(Get-Content -LiteralPath $localState -Raw | ConvertFrom-Json)
}
function Test-LocalPort([int]$Port) {
    $localSocket = [Net.Sockets.TcpClient]::new()
    try { return $localSocket.ConnectAsync('127.0.0.1', $Port).Wait(600) -and $localSocket.Connected }
    catch { return $false }
    finally { $localSocket.Dispose() }
}
if ($Stop) {
    foreach ($localEntry in $localEntries) {
        $localProcess = Get-CimInstance Win32_Process -Filter ("ProcessId=" + [int]$localEntry.pid)
        if ($localProcess -and $localProcess.Name -eq 'node.exe' -and
            ([string]$localProcess.CommandLine).Contains([string]$localEntry.script)) {
            Stop-Process -Id ([int]$localEntry.pid)
        }
    }
    Remove-Item -LiteralPath $localState -ErrorAction SilentlyContinue
    Write-Output 'Local Cartoteca processes stopped.'
    exit
}
$localSpecs = @(@{name='preview';port=4174;script='scripts/local-preview.cjs'})
if ($Demo) {
    if (-not (Test-Path -LiteralPath (Join-Path $localRoot 'data-demo-team-20261009-03/demo-access.json'))) {
        throw 'Existing demonstration data is required. New accounts will not be seeded here.'
    }
    $localSpecs += @{name='demo';port=4175;script='work/demo-team-2026-10-09/server.cjs'}
    $localSpecs += @{name='proxy';port=4176;script='work/demo-team-2026-10-09/tab-proxy.cjs'}
}
foreach ($localSpec in $localSpecs) {
    if (Test-LocalPort $localSpec.port) {
        Write-Output ('Already listening: ' + $localSpec.port + '; existing process retained.')
        continue
    }
    $localScript = Join-Path $localRoot $localSpec.script
    $localProcess = Start-Process -FilePath $localNode -ArgumentList ('"' + $localScript + '"') -WorkingDirectory $localRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $localHome ('operations/' + $localSpec.name + '.log')) -RedirectStandardError (Join-Path $localHome ('operations/' + $localSpec.name + '-error.log')) -PassThru
    $localEntries = @($localEntries | Where-Object { $_.port -ne $localSpec.port })
    $localEntries += [pscustomobject]@{pid=$localProcess.Id;port=$localSpec.port;script=$localScript}
}
$localEntries | ConvertTo-Json | Set-Content -LiteralPath $localState -Encoding utf8
$localDeadline = [DateTime]::UtcNow.AddSeconds(15)
foreach ($localSpec in $localSpecs) {
    while (-not (Test-LocalPort $localSpec.port)) {
        if ([DateTime]::UtcNow -gt $localDeadline) { throw ('Local server did not start on port ' + $localSpec.port + '. See operations logs.') }
        Start-Sleep -Milliseconds 200
    }
}
Write-Output 'Cartoteca: http://127.0.0.1:4174/; external deliveries disabled.'
if ($Open) { Start-Process 'http://127.0.0.1:4174/' }
