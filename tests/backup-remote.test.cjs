const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  signS3,
  signCanonical,
  encode,
} = require('../src/server/infrastructure/backup/s3-signing.cjs');
const { createS3Storage } = require('../src/server/infrastructure/backup/s3-storage.cjs');
const config = {
  endpoint: 'https://storage.synthetic.test',
  bucket: 'synthetic-bucket',
  region: 'synthetic-1',
  prefix: 'private',
  accessKey: 'SYNTHETICACCESS',
  secretKey: 'synthetic-secret-not-real',
};
const now = new Date('2026-10-07T03:30:00Z');

function transport({
  version = 'synthetic-version',
  lock = 'COMPLIANCE',
  corrupt = false,
  expired = false,
  failPut = false,
} = {}) {
  const requests = [];
  let bytes, until;
  return {
    requests,
    fetchImpl: async (url, options) => {
      assert.equal(new URL(url).origin, config.endpoint);
      requests.push({ url, method: options.method, headers: options.headers });
      if (options.method === 'PUT') {
        const chunks = [];
        for await (const chunk of options.body) chunks.push(chunk);
        bytes = Buffer.concat(chunks);
        assert.equal(
          options.headers['x-amz-content-sha256'],
          crypto.createHash('sha256').update(bytes).digest('hex'),
        );
        assert.equal(
          options.headers['content-md5'],
          crypto.createHash('md5').update(bytes).digest('base64'),
        );
        until = expired
          ? '2026-10-06T00:00:00Z'
          : options.headers['x-amz-object-lock-retain-until-date'];
        return new Response('', {
          status: failPut ? 403 : 200,
          headers: version ? { 'x-amz-version-id': version } : {},
        });
      }
      assert.equal(new URL(url).searchParams.get('versionId'), version);
      if (new URL(url).searchParams.has('retention'))
        return new Response(
          `<Retention><Mode>${lock}</Mode><RetainUntilDate>${until}</RetainUntilDate></Retention>`,
        );
      return new Response(corrupt ? Buffer.concat([bytes, Buffer.from('corrupt')]) : bytes);
    },
  };
}
function archive(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-backup-remote-'));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true });
  });
  const file = path.join(directory, 'synthetic.enc');
  fs.writeFileSync(file, 'synthetic-ciphertext');
  return file;
}
test('SigV4 matches the published AWS S3 fixed signing vector, not just a mock accepting any signature', () => {
  // PUBLIC example key, never an account credential:
  // https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html
  const empty = crypto.createHash('sha256').update('').digest('hex');
  const canonical = [
    'GET',
    '/test.txt',
    '',
    'host:examplebucket.s3.amazonaws.com\nrange:bytes=0-9\nx-amz-content-sha256:' +
      empty +
      '\nx-amz-date:20130524T000000Z\n',
    'host;range;x-amz-content-sha256;x-amz-date',
    empty,
  ].join('\n');
  assert.equal(
    signCanonical(
      { region: 'us-east-1', secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
      canonical,
      '20130524T000000Z',
    ).signature,
    'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
  );
});
test('SigV4 canonical encoding preserves object slashes, sorts query and signs retention/checksum headers', () => {
  assert.equal(encode("x y+!'"), 'x%20y%2B%21%27');
  const signed = signS3({
    config,
    method: 'GET',
    key: 'private/hello world.enc',
    query: { versionId: 'v+1', retention: '' },
    now,
  });
  assert.equal(
    signed.url,
    'https://storage.synthetic.test/synthetic-bucket/private/hello%20world.enc?retention=&versionId=v%2B1',
  );
  assert.equal(signed.headers['x-amz-date'], '20261007T033000Z');
  assert.match(
    signed.headers.authorization,
    /Credential=SYNTHETICACCESS\/20261007\/synthetic-1\/s3\/aws4_request/,
  );
  assert.match(
    signed.headers.authorization,
    /SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[a-f0-9]{64}$/,
  );
  assert.throws(
    () => signS3({ config, method: 'GET', key: '../bad', now }),
    /BACKUP_REMOTE_FAILED/,
  );
  assert.notEqual(
    signed.headers.authorization,
    signS3({ config, method: 'GET', key: 'different', now }).headers.authorization,
  );
});
test('S3 upload verifies a specific locked version with full readback, never HEAD/DELETE; daily and weekly retention differ', async (t) => {
  const file = archive(t),
    mock = transport();
  const store = createS3Storage(config, { ...mock, clock: () => now });
  const receipt = await store.upload(file, 'synthetic-job');
  assert.equal(receipt.versionId, 'synthetic-version');
  assert.match(receipt.key, /\/daily\/2026-10-07\/synthetic-job.enc$/);
  assert.equal(receipt.retainUntil, '2026-11-06T03:30:00.000Z');
  assert.deepEqual(
    mock.requests.map((x) => x.method),
    ['PUT', 'GET', 'GET'],
  );
  assert.match(
    mock.requests[0].headers.authorization,
    /x-amz-object-lock-mode;x-amz-object-lock-retain-until-date/,
  );
  assert.equal(store.delete, undefined);
  const weekly = await createS3Storage(config, {
    ...transport(),
    clock: () => new Date('2026-10-11T03:30:00Z'),
  }).upload(file, 'weekly-job');
  assert.match(weekly.key, /\/weekly\//);
  assert.equal(weekly.retainUntil, '2026-12-06T03:30:00.000Z');
});
for (const [name, options, code] of [
  ['missing version', { version: null }, 'FAILED'],
  ['unversioned null', { version: 'null' }, 'FAILED'],
  ['governance instead of compliance', { lock: 'GOVERNANCE' }, 'RETENTION'],
  ['expired lock', { expired: true }, 'RETENTION'],
  ['wrong readback', { corrupt: true }, 'CHECKSUM'],
  ['provider denied request', { failPut: true }, 'FAILED'],
])
  test('S3 cannot claim protection: ' + name, async (t) => {
    await assert.rejects(
      createS3Storage(config, { ...transport(options), clock: () => now }).upload(
        archive(t),
        'job',
      ),
      new RegExp('BACKUP_REMOTE_' + code),
    );
  });
test('network/provider exception does not leak secret payload in error', async (t) => {
  const store = createS3Storage(config, {
    clock: () => now,
    fetchImpl: async () => {
      throw Error(config.secretKey);
    },
  });
  await assert.rejects(
    store.upload(archive(t), 'job'),
    (error) => error.message === 'BACKUP_REMOTE_FAILED',
  );
});
