const fs = require('node:fs');
const path = require('node:path');
const { createHmac } = require('node:crypto');
const {
  hotCalendarFixture169,
  hotSQL169,
  bounded169,
} = require('./postgres-hot-calendar169-fixture.cjs');
const {
  prepareDirectory164,
} = require('../../src/server/infrastructure/postgres/directory-component164.cjs');

// Reuse the independently tested owning-client transport and its real SQL gates.
// All fixture data and keys are temporary synthetic assets, unrelated to DATA150.
async function hotDirectoryFixture170(t, options = {}) {
  const f = await hotCalendarFixture169(t, options);
  try {
    const current = f.storage.read();
    current.patients.push(
      ...['Бета', 'Gamma'].map((name, index) => ({
        id: 'directory170-' + index,
        name: 'Synthetic ' + name,
        createdBy: f.actors[1].accountId,
        phone: '',
        notes: 'Synthetic170',
        visits: [],
        appointments: [],
      })),
    );
    f.storage.write({ ...current, revision: f.storage.get('revision') });
    const key = fs.readFileSync(path.join(f.dir, 'encryption.key'));
    const ciphers = {
      encode: f.storage.encode,
      decode: f.storage.decode,
      hash: (value) => createHmac('sha256', key).update(value).digest('hex'),
    };
    await f.admin.query('BEGIN');
    try {
      await prepareDirectory164(f.admin, f.runtime.application.user, {
        stores: [{ storeId: f.cabinets[0].storeId, ciphers }],
      });
      await f.admin.query('COMMIT');
    } catch (error) {
      await f.admin.query('ROLLBACK');
      throw error;
    } finally {
      key.fill(0);
    }
  } catch (error) {
    await f.close();
    throw error;
  }
  const url = '/api/cabinet/directory?q=Synthetic&today=2035-01-01&limit=100';
  async function raw(k, target = url, actor = f.actors[0], { cancel = null, change } = {}) {
    const metadata = f.metadata(target, actor);
    change?.(metadata);
    const r = await k.kernel.run(metadata, cancel, {
      memoryClass: 'query-probe',
      requestMemoryClass: async () => {},
    });
    const bytes = Buffer.from(r.body);
    return {
      status: r.status,
      headers: r.headers,
      bytes,
      body: JSON.parse(bytes.toString('utf8')),
    };
  }
  async function warm(k, target = url, actor = f.actors[0]) {
    const first = await raw(k, target, actor);
    if (first.status !== 200 || !Array.isArray(first.body.directory))
      throw Error('Synthetic170 cold directory unavailable');
    k.clear();
    return first;
  }
  const assetStamps = () =>
    ['postgresql-runtime.json', 'platform/platform.key', 'encryption.key'].map((p) => {
      const s = fs.lstatSync(path.join(f.dir, p), { bigint: true });
      return [
        p,
        ...['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'gid', 'nlink'].map((k) =>
          String(s[k]),
        ),
      ];
    });
  return { ...f, directoryUrl: url, raw, warm, assetStamps, hotSQL169, bounded169 };
}
module.exports = { hotDirectoryFixture170, hotSQL169, bounded169 };
