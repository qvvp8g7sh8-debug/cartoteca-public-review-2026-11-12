#requires -Version 5.1
<#
Installs only pinned official whisper.cpp CPU binaries and multilingual base weights.
Does not run whisper, change application configuration, contact models, or read secrets.
Sources reviewed 2026-10-16 (metadata and source only; no runtime download for authoring):
https://api.github.com/repos/ggml-org/whisper.cpp/releases/tags/b5454
https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.5
https://github.com/ggml-org/whisper.cpp/blob/d1be6fde11ac6e0407606b4e42fe72d34add8037/.github/workflows/release.yml#L226
https://huggingface.co/api/models/ggerganov/whisper.cpp/revision/5359861c739e955e79d9a303bcbc70fb988958b1?blobs=true
https://github.com/ggml-org/whisper.cpp/blob/d1be6fde11ac6e0407606b4e42fe72d34add8037/models/download-ggml-model.sh#L8
The ggml-org project itself points to the maintainer's ggerganov Hugging Face repository.
.EXAMPLE
powershell.exe -NoProfile -File .\scripts\setup-assistant-local-speech.ps1 -WhatIf
.EXAMPLE
powershell.exe -NoProfile -File .\scripts\setup-assistant-local-speech.ps1
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param([ValidateRange(1, 3)][int]$DownloadAttempts = 3)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath('C:\Cartoteca\tools\whisper')
$Release = 'b5454'
$Commit = 'd1be6fde11ac6e0407606b4e42fe72d34add8037'
$ModelRevision = '5359861c739e955e79d9a303bcbc70fb988958b1'
$ZipUrl = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip'
$ZipHash = '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb'
$ZipBytes = 8928640L
$ModelUrl = "https://huggingface.co/ggerganov/whisper.cpp/resolve/$ModelRevision/ggml-base.bin"
$ModelHash = '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe'
$ModelBytes = 147951465L

function Assert-LocalPath([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    if ($full -ne $Root -and -not $full.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Installer path escapes its fixed target directory.'
    }
    $ancestor = $full
    while ($ancestor) {
        if (Test-Path -LiteralPath $ancestor) {
            $item = Get-Item -LiteralPath $ancestor -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse points are not allowed in installer paths.' }
        }
        $parent = [IO.Path]::GetDirectoryName($ancestor)
        if ($parent -eq $ancestor) { break }
        $ancestor = $parent
    }
    return $full
}
function New-LocalDirectory([string]$Path) {
    $full = Assert-LocalPath $Path
    [void][IO.Directory]::CreateDirectory($full)
    return $full
}
function Assert-NoTreeLinks([string]$Path) {
    [void](Assert-LocalPath $Path)
    foreach ($item in Get-ChildItem -LiteralPath $Path -Recurse -Force) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Existing installation contains a reparse point.' }
    }
}
function Test-Artifact([string]$Path, [long]$Bytes, [string]$Hash) {
    [void](Assert-LocalPath $Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    if ((Get-Item -LiteralPath $Path).Length -ne $Bytes) { return $false }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -eq $Hash
}
function Preserve-Invalid([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw 'Expected a regular artifact file.' }
    $old = Assert-LocalPath $Path
    $saved = Assert-LocalPath ($Path + '.invalid-' + [Guid]::NewGuid().ToString('N'))
    Move-Item -LiteralPath $old -Destination $saved
}
function Get-PinnedArtifact([string]$Url, [string]$Path, [long]$Bytes, [string]$Hash) {
    if (Test-Artifact $Path $Bytes $Hash) { Write-Host ('Verified existing ' + [IO.Path]::GetFileName($Path)); return }
    Preserve-Invalid $Path
    $partial = Assert-LocalPath ($Path + '.part')
    for ($attempt = 1; $attempt -le $DownloadAttempts; $attempt++) {
        if (Test-Path -LiteralPath $partial) {
            $length = (Get-Item -LiteralPath $partial).Length
            if ($length -ge $Bytes) {
                if (Test-Artifact $partial $Bytes $Hash) { Move-Item -LiteralPath $partial -Destination $Path; return }
                Preserve-Invalid $partial
            }
        }
        Write-Host ('Downloading ' + [IO.Path]::GetFileName($Path) + ' (attempt ' + $attempt + '/' + $DownloadAttempts + ')')
        # --disable is first: no user curl config, implicit credentials or custom hooks.
        & $Curl --disable --fail --location --proto '=https' --proto-redir '=https' --retry 0 --connect-timeout 20 --max-time 900 --max-filesize $Bytes --continue-at - --output $partial $Url
        $downloadExit = $LASTEXITCODE
        if ($downloadExit -eq 0 -and (Test-Artifact $partial $Bytes $Hash)) {
            Move-Item -LiteralPath $partial -Destination $Path
            return
        }
        if ($downloadExit -eq 0) { Preserve-Invalid $partial }
        # A server that refuses ranges gets a clean retry within the same bounded budget.
        if ($downloadExit -in 33, 36) { Preserve-Invalid $partial }
        if ($attempt -lt $DownloadAttempts) { Start-Sleep -Seconds (2 * $attempt) }
    }
    throw ('Pinned artifact could not be verified: ' + [IO.Path]::GetFileName($Path) + '. A resumable .part may remain; existing installation is preserved.')
}
function Expand-VerifiedRuntime([string]$Zip, [string]$Destination) {
    $archive = [IO.Compression.ZipFile]::OpenRead($Zip)
    $selected = @()
    try {
        if ($archive.Entries.Count -gt 1024) { throw 'Unexpected ZIP entry count.' }
        $names = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        $total = 0L
        foreach ($entry in $archive.Entries) {
            $name = $entry.FullName.Replace('\', '/')
            if (-not $name.StartsWith('Release/', [StringComparison]::Ordinal) -or $name -match '(^|/)\.{1,2}(/|$)|[:\x00-\x1f]' -or [IO.Path]::IsPathRooted($name)) { throw 'Unsafe or unexpected ZIP path.' }
            if (($entry.ExternalAttributes -shr 16 -band 0xF000) -eq 0xA000) { throw 'ZIP symlinks are not allowed.' }
            foreach ($piece in $name.TrimEnd('/').Split('/')) {
                if ($piece -notmatch '^[A-Za-z0-9_. -]+$' -or $piece -match '[. ]$|^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { throw 'Unsafe Windows ZIP name.' }
            }
            $total += $entry.Length
            if ($total -gt 268435456) { throw 'Unexpected ZIP expanded size.' }
            if ($name.EndsWith('/')) { continue }
            if (-not $names.Add($name)) { throw 'Duplicate ZIP path.' }
            # Upstream archive layout is Release/. Keep the CLI and every adjacent runtime DLL.
            if ($name -notmatch '^Release/([^/]+\.dll|whisper-cli\.exe)$') { continue }
            $target = Assert-LocalPath (Join-Path $Destination ([IO.Path]::GetFileName($name)))
            $zipStream = $null; $fileStream = $null
            try {
                $zipStream = $entry.Open()
                $fileStream = [IO.File]::Open($target, [IO.FileMode]::CreateNew)
                $zipStream.CopyTo($fileStream)
            } finally {
                if ($fileStream) { $fileStream.Dispose() }
                if ($zipStream) { $zipStream.Dispose() }
            }
            if ((Get-Item -LiteralPath $target).Length -ne $entry.Length) { throw 'ZIP extraction length mismatch.' }
            $selected += [PSCustomObject]@{ name = [IO.Path]::GetFileName($target); bytes = $entry.Length; sha256 = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() }
        }
        if (-not ($selected | Where-Object { $_.name -eq 'whisper-cli.exe' })) { throw 'Pinned ZIP is missing Release/whisper-cli.exe.' }
        return $selected
    } finally { $archive.Dispose() }
}

if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitOperatingSystem -or ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -and $env:PROCESSOR_ARCHITEW6432 -ne 'AMD64')) { throw 'This pinned installer requires Windows x64.' }
$Curl = Join-Path $env:WINDIR 'System32\curl.exe'
if (-not (Test-Path -LiteralPath $Curl -PathType Leaf)) { throw 'The Windows inbox curl.exe is required.' }
if (-not $PSCmdlet.ShouldProcess($Root, 'Install pinned whisper.cpp v1.9.5 / b5454 CPU runtime and multilingual base model (no execution)')) { return }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[void](New-LocalDirectory $Root)
$downloads = New-LocalDirectory (Join-Path $Root '.downloads')
$models = New-LocalDirectory (Join-Path $Root 'models')
$zip = Assert-LocalPath (Join-Path $downloads 'whisper-b5454-x64.zip')
$model = Assert-LocalPath (Join-Path $models 'ggml-base.bin')
$bin = Assert-LocalPath (Join-Path $Root 'bin')
$stage = Assert-LocalPath (Join-Path $Root ('.stage-' + [Guid]::NewGuid().ToString('N')))
$lockPath = Assert-LocalPath (Join-Path $Root '.setup.lock')
$lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
$backup = $null
try {
    Get-PinnedArtifact $ZipUrl $zip $ZipBytes $ZipHash
    # Preserve a known-good binary installation if the model download fails.
    Get-PinnedArtifact $ModelUrl $model $ModelBytes $ModelHash
    [void](New-LocalDirectory $stage)
    $files = @(Expand-VerifiedRuntime $zip $stage)
    $same = Test-Path -LiteralPath $bin -PathType Container
    if ($same) {
        Assert-NoTreeLinks $bin
        foreach ($item in $files) {
            if (-not (Test-Artifact (Join-Path $bin $item.name) $item.bytes $item.sha256)) { $same = $false; break }
        }
        if (@(Get-ChildItem -LiteralPath $bin -Force).Count -ne $files.Count) { $same = $false }
    }
    if (-not $same) {
        if (Test-Path -LiteralPath $bin) {
            Assert-NoTreeLinks $bin
            $backup = Assert-LocalPath (Join-Path $Root ('bin.previous-' + [Guid]::NewGuid().ToString('N')))
            Move-Item -LiteralPath (Assert-LocalPath $bin) -Destination (Assert-LocalPath $backup)
        }
        try { Move-Item -LiteralPath (Assert-LocalPath $stage) -Destination (Assert-LocalPath $bin) }
        catch {
            if ($backup -and -not (Test-Path -LiteralPath $bin)) { Move-Item -LiteralPath (Assert-LocalPath $backup) -Destination (Assert-LocalPath $bin) }
            throw
        }
    }
    $receipt = [ordered]@{
        schemaVersion = 1; installedAt = [DateTime]::UtcNow.ToString('o'); runtimeExecuted = $false
        version = 'v1.9.5'; build = $Release; commit = $Commit; architecture = 'Windows-x64-CPU'
        binary = @{ url = $ZipUrl; bytes = $ZipBytes; sha256 = $ZipHash; source = 'https://api.github.com/repos/ggml-org/whisper.cpp/releases/tags/b5454' }
        model = @{ repository = 'ggerganov/whisper.cpp'; revision = $ModelRevision; url = $ModelUrl; bytes = $ModelBytes; sha256 = $ModelHash; multilingual = $true }
        executable = (Join-Path $bin 'whisper-cli.exe'); modelPath = $model; files = $files
    }
    $receiptPath = Assert-LocalPath (Join-Path $Root 'installation.json')
    $temporaryReceipt = Assert-LocalPath ($receiptPath + '.new-' + [Guid]::NewGuid().ToString('N'))
    [IO.File]::WriteAllText($temporaryReceipt, ($receipt | ConvertTo-Json -Depth 8), ([Text.UTF8Encoding]::new($false)))
    Move-Item -LiteralPath $temporaryReceipt -Destination $receiptPath -Force
    Write-Host ('Ready: ' + $receipt.executable)
    Write-Host ('Model: ' + $model)
    Write-Host 'No recognition, microphone access, application restart, or provider calls were performed.'
} finally {
    try {
    if (Test-Path -LiteralPath $stage -PathType Container) {
        $checkedStage = Assert-LocalPath $stage
        if ([IO.Path]::GetFileName($checkedStage) -notmatch '^\.stage-[a-f0-9]{32}$') { throw 'Unsafe temporary cleanup target.' }
        Assert-NoTreeLinks $checkedStage
        Remove-Item -LiteralPath $checkedStage -Recurse -Force
    }
    } finally { $lock.Dispose() }
}
