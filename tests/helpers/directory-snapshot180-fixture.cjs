const {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomUUID,
} = require('node:crypto');
const { compact } = require('../../src/server/infrastructure/cabinet-directory-projection164.cjs');
const { directoryPage } = require('../../src/server/modules/cabinet/directory.cjs');
const { createReadCacheBudget } = require('../../src/server/infrastructure/read-cache-budget.cjs');
const {
  createDirectorySnapshotIndex180,
} = require('../../src/server/infrastructure/postgres/directory-snapshot-index180.cjs');
const {
  directorySnapshotKey180,
  directorySnapshotClaim180,
} = require('../../src/server/infrastructure/postgres/directory-snapshot-key180.cjs');
const ids = Array.from(
  { length: 7 },
  (_, n) => '00000000-0000-4000-8000-' + String(n + 1).padStart(12, '0'),
);
const [accountId, organizationId, sessionId, storeId, epoch, platformStoreId, other] = ids;
const current = {
  accountId,
  organizationId,
  sessionId,
  role: 'owner',
  expiresAt: Date.now() + 3600000,
};
function realCodec() {
  const key = randomBytes(32);
  return {
    encode(value) {
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([
        cipher.update(Buffer.from(JSON.stringify(value))),
        cipher.final(),
      ]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decode(value) {
      const bytes = Buffer.from(value),
        decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return JSON.parse(
        Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(),
      );
    },
    hash(value) {
      return createHmac('sha256', key).update(value).digest('hex');
    },
  };
}
function summaries() {
  const values = [
    { name: 'Ёж Петров', firstName: 'Ёж', lastName: 'Петров', phone: '+7 (999) 000-00-01' },
    { name: 'Еж Сидоров', firstName: 'Еж', lastName: 'Сидоров', phone: '89990000002' },
    { name: 'Анна', firstName: 'Анна', lastName: '', phone: '' },
    { name: 'Legacy Client', phone: '+49 123456789' },
    {
      name: 'Synthetic $& $` Client',
      firstName: 'Synthetic',
      lastName: '$& $` Client',
      phone: '+79990000005',
    },
    { name: 'İ Test', firstName: 'İ', lastName: 'Test', phone: '' },
  ];
  return values.map((value, n) => ({
    id: 'patient180-' + n,
    ...value,
    visitCount: n,
    lastVisit: n % 2 ? { date: '2026-07-01', procedure: 'Synthetic' } : null,
    appointments:
      n % 2
        ? []
        : [
            {
              id: 'appointment180-' + n,
              date: n === 0 ? '2026-10-01' : '2026-11-01',
              time: '12:00',
              service: 'Synthetic',
              duration: 30,
            },
          ],
  }));
}
function fixture() {
  const rows = summaries(),
    crypto = realCodec(),
    revision = 17,
    timeZone = 'Europe/Moscow';
  const snapshot = createDirectorySnapshotIndex180(rows, { revision, timeZone });
  const budget = createReadCacheBudget({ maxBytes: 64 * 1024 * 1024 });
  const storage = {
    filename: 'snapshot180-' + randomUUID(),
    encode: crypto.encode,
    decode: crypto.decode,
    readCacheBudget: budget,
    readCacheVersion: 'source180',
    readCacheIdentity: 'identity180',
  };
  function legacy(url, actor = current) {
    const result = directoryPage(
      storage,
      actor,
      url,
      { revision, directory: rows.map(compact) },
      timeZone,
    );
    result.directory = result.directory.map((row) => rows.find((value) => value.id === row.id));
    return result;
  }
  const url = (query) =>
    new URL('http://native.invalid/api/cabinet/directory?today=2026-10-30&' + query);
  const key = directorySnapshotKey180({ epoch, storeId, current });
  const claim = directorySnapshotClaim180({
    epoch,
    platformStoreId,
    token: 'synthetic180-cookie',
    headers: { 'x-cartoteca-account-id': accountId, 'x-cartoteca-organization-id': organizationId },
    url: url(''),
  });
  return {
    rows,
    crypto,
    revision,
    timeZone,
    snapshot,
    budget,
    storage,
    legacy,
    url,
    key,
    claim,
    render(target, actor = current) {
      return require('../../src/server/infrastructure/postgres/directory-snapshot-index180.cjs')
        .directorySnapshotIndexInfo180(snapshot)
        .render({ current: actor, url: target, cursorCrypto: crypto });
    },
    close: () => budget.clear(),
  };
}
module.exports = {
  fixture,
  summaries,
  realCodec,
  current,
  ids,
  accountId,
  organizationId,
  sessionId,
  storeId,
  epoch,
  platformStoreId,
  other,
};
