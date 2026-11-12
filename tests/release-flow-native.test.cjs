const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const flow = require('../scripts/release/flow.cjs');
const { manifest, objectHash } = require('../scripts/release/files.cjs');
const { writeJson } = require('../scripts/release/state.cjs');

function storedZip(name, data) {
  const filename = Buffer.from(name);
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  crc = ~crc >>> 0;
  const local = Buffer.alloc(30),
    central = Buffer.alloc(46),
    end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(filename.length, 26);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(filename.length, 28);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12);
  end.writeUInt32LE(local.length + filename.length + data.length, 16);
  return Buffer.concat([local, filename, data, central, filename, end]);
}

test('native flow import handles long browser report paths in a realistic Windows workspace', async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'release-flow-native-'));
  const root = path.join(temporary, 'w'.repeat(Math.max(1, 95 - temporary.length - 1)));
  t.after(() => {
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith('release-flow-native-'));
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  const candidate = path.join(root, '.release/candidates/local'),
    source = path.join(candidate, 'source');
  fs.mkdirSync(path.join(source, 'src'), { recursive: true });
  fs.writeFileSync(path.join(source, 'src/synthetic.js'), '// SYNTHETIC\n');
  const files = manifest(source),
    sourceHash = objectHash(files),
    head = 'a'.repeat(40);
  const repository = 'qvvp8g7sh8-debug/cartoteca',
    branch = 'codex/release-pipeline-synthetic';
  writeJson(path.join(candidate, 'candidate.json'), { version: 1, id: 'local', files, sourceHash });
  fs.mkdirSync(path.join(candidate, 'submission-1'));
  writeJson(path.join(candidate, 'submission-1/report.json'), {
    status: 'submitted',
    candidate: 'local',
    sourceHash,
    repository,
    branch,
    commit: head,
  });
  flow.start(root, 'local');
  await flow.advance(root, 'local', {
    kind: 'ci',
    run: {
      id: 7,
      head_sha: head,
      head_branch: branch,
      path: '.github/workflows/release.yml',
      event: 'push',
      status: 'completed',
      conclusion: 'success',
    },
    jobs: [],
    totalJobs: 0,
  });
  const report =
    'reports/windows/parts/browser-chromium-desktop/attempt-1791566394275-5092/admin-chromium-desktop-appearance.json';
  const data = Buffer.from('SYNTHETIC'),
    archive = storedZip(report, data);
  await flow.advance(root, 'local', {
    kind: 'artifacts',
    total: 1,
    artifacts: [
      {
        id: 5,
        name: 'verified-release',
        expired: false,
        workflow_run: { id: 7, head_sha: head },
        size_in_bytes: archive.length,
        digest: 'sha256:' + crypto.createHash('sha256').update(archive).digest('hex'),
      },
    ],
  });
  const result = await flow.advance(
    root,
    'local',
    { kind: 'reference', artifactId: 5, url: 'https://synthetic.oaiusercontent.com/file' },
    {
      request: async () => ({ ok: true, status: 200, body: [archive] }),
      verifyPackage: async () => ({}),
    },
  );
  assert.equal(result.phase, 'ready');
  assert.deepEqual(fs.readFileSync(path.join(root, '.release/candidates/ci-7', report)), data);
});
