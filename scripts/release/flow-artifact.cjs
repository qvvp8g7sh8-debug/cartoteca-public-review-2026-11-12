const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { safePath } = require('./files.cjs');
const { cleanEnvironment } = require('./process.cjs');

const MAX_BYTES = 512 * 1024 * 1024;
function artifactIdentity(value, state, name = 'verified-release') {
  if (
    !value ||
    !Number.isSafeInteger(value.id) ||
    value.id < 1 ||
    value.name !== name ||
    value.expired !== false ||
    value.workflow_run?.id !== state.run ||
    value.workflow_run?.head_sha !== state.head ||
    !/^sha256:[a-f0-9]{64}$/.test(value.digest) ||
    !Number.isSafeInteger(value.size_in_bytes) ||
    value.size_in_bytes < 1 ||
    value.size_in_bytes > MAX_BYTES
  )
    throw Error('Artifact identity does not match the release');
  return { id: value.id, name, digest: value.digest, bytes: value.size_in_bytes };
}
function relayUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    !url.hostname.endsWith('.oaiusercontent.com') ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  )
    throw Error('Only a GitHub connector file reference is accepted');
  return url;
}
async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  return 'sha256:' + hash.digest('hex');
}
async function download(
  directory,
  metadata,
  reference,
  { request = fetch, emit = () => {}, signal, idleMs = 30000, totalMs = 300000 } = {},
) {
  const file = safePath(directory, 'artifact-' + metadata.id + '.zip');
  if (fs.existsSync(file)) {
    if (fs.statSync(file).size !== metadata.bytes || (await hashFile(file)) !== metadata.digest)
      throw Error('Cached artifact changed');
    return file;
  }
  const partial = safePath(directory, 'artifact-' + metadata.id + '.next-' + crypto.randomUUID());
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  let idle,
    descriptor,
    received = 0,
    lastProgress = 0;
  const deadline = setTimeout(abort, totalMs);
  const resetIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(abort, idleMs);
  };
  try {
    if (signal?.aborted) abort();
    let url = relayUrl(reference);
    resetIdle();
    let response;
    for (let redirects = 0; redirects <= 3; redirects++) {
      response = await request(url.href, { redirect: 'manual', signal: controller.signal });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      if (redirects === 3) throw Error('Connector redirect limit exceeded');
      url = relayUrl(new URL(response.headers.get('location'), url).href);
    }
    if (!response.ok || !response.body) throw Error('Connector download unavailable');
    const hash = crypto.createHash('sha256');
    descriptor = await fs.promises.open(partial, 'wx');
    for await (const chunk of response.body) {
      if (controller.signal.aborted) throw Error('Download cancelled');
      const bytes = Buffer.from(chunk);
      received += bytes.length;
      if (received > metadata.bytes) throw Error('Artifact exceeds its declared size');
      resetIdle();
      hash.update(bytes);
      await descriptor.writeFile(bytes);
      if (Date.now() - lastProgress >= 10000) {
        emit({ event: 'download', received, bytes: metadata.bytes });
        lastProgress = Date.now();
      }
    }
    if (
      controller.signal.aborted ||
      received !== metadata.bytes ||
      'sha256:' + hash.digest('hex') !== metadata.digest
    )
      throw Error('Downloaded artifact digest mismatch');
    await descriptor.sync();
    await descriptor.close();
    descriptor = null;
    fs.renameSync(partial, file);
    return file;
  } catch (error) {
    // Neither provider errors nor temporary signed references may enter logs/state.
    throw Error(
      controller.signal.aborted
        ? 'Connector download timed out or cancelled'
        : 'Connector artifact download failed',
    );
  } finally {
    clearTimeout(idle);
    clearTimeout(deadline);
    signal?.removeEventListener('abort', abort);
    if (descriptor) await descriptor.close();
    if (fs.existsSync(partial)) fs.unlinkSync(partial);
  }
}

const powershell = `
$ErrorActionPreference='Stop'
[void][Reflection.Assembly]::LoadWithPartialName('System.IO.Compression.FileSystem')
$base=[IO.Path]::GetFullPath($env:RELEASE_FLOW_STAGE)+[IO.Path]::DirectorySeparatorChar
$zip=[IO.Compression.ZipFile]::OpenRead($env:RELEASE_FLOW_ARCHIVE)
try {
  $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $size=0L
  if($zip.Entries.Count -gt 20000){throw 'Too many entries'}
  foreach($entry in $zip.Entries){
    $name=$entry.FullName
    $parts=$name.TrimEnd('/').Split('/')
    $mode=($entry.ExternalAttributes -shr 16) -band 61440
    if(!$name -or $name.StartsWith('/') -or $name.Contains('\\') -or $name.Contains(':') -or
       ($parts | Where-Object {$_ -eq '' -or $_ -eq '.' -or $_ -eq '..' -or $_.TrimEnd(' ','.') -ne $_}) -or
       $mode -notin @(0,16384,32768) -or !$seen.Add($name.TrimEnd('/'))){throw 'Invalid entry'}
    $target=[IO.Path]::GetFullPath([IO.Path]::Combine($base,$name))
    if(!$target.StartsWith($base,[StringComparison]::OrdinalIgnoreCase)){throw 'Escaping entry'}
    $size+=$entry.Length
    if($entry.Length -gt 1073741824 -or $size -gt 2147483648){throw 'Expanded archive too large'}
  }
  foreach($entry in $zip.Entries){
    $target=[IO.Path]::Combine($base,$entry.FullName)
    if($entry.FullName.EndsWith('/')){[void][IO.Directory]::CreateDirectory($target);continue}
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
    $inputStream=$entry.Open()
    $outputStream=[IO.File]::Open($target,[IO.FileMode]::CreateNew)
    try{$inputStream.CopyTo($outputStream)}finally{$outputStream.Dispose();$inputStream.Dispose()}
  }
}finally{$zip.Dispose()}
`;
const python = `
import pathlib,sys,zipfile,stat
base=pathlib.Path(sys.argv[2]).resolve()
with zipfile.ZipFile(sys.argv[1]) as archive:
 entries=archive.infolist();seen=set();size=0
 if len(entries)>20000: raise ValueError('Too many entries')
 for entry in entries:
  name=entry.filename;parts=name.rstrip('/').split('/');kind=stat.S_IFMT(entry.external_attr>>16)
  if not name or name.startswith('/') or '\\\\' in name or ':' in name or any(p in ('','.', '..') or p.rstrip(' .')!=p for p in parts) or kind not in (0,stat.S_IFREG,stat.S_IFDIR) or name.rstrip('/').casefold() in seen: raise ValueError('Invalid entry')
  seen.add(name.rstrip('/').casefold());size+=entry.file_size
  if entry.file_size>1073741824 or size>2147483648 or not (base/name).resolve().is_relative_to(base): raise ValueError('Escaping or oversized entry')
 archive.extractall(base)
`;
function extract(file, directory) {
  if (fs.existsSync(directory)) throw Error('Extraction destination already exists');
  fs.mkdirSync(directory, { recursive: true });
  try {
    if (process.platform === 'win32')
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(powershell, 'utf16le').toString('base64'),
        ],
        {
          env: cleanEnvironment({ RELEASE_FLOW_ARCHIVE: file, RELEASE_FLOW_STAGE: directory }),
          timeout: 120000,
          windowsHide: true,
          stdio: 'ignore',
        },
      );
    else
      execFileSync('python3', ['-c', python, file, directory], {
        timeout: 120000,
        stdio: 'ignore',
      });
  } catch {
    throw Error('Artifact extraction refused; inspect the private download');
  }
}
module.exports = { artifactIdentity, relayUrl, download, extract, hashFile };
