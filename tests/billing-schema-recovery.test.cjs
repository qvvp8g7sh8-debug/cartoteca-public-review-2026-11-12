const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { recoveryFixture } = require('./helpers/billing-recovery-fixture.cjs');
const { multiServiceSchema } = require('../src/server/modules/billing/multi-service-schema.cjs');
const { assertPreparedNotifications } = require('../src/server/application/startup-schema.cjs');
const { validateRecovered } = require('../src/server/infrastructure/backup/validation.cjs');

// Hash only this fixture's temporary synthetic database, random key and manifest.
function fingerprints(f) {
  return ['platform/platform.sqlite', 'platform/platform.key', 'manifest.json'].map((name) => {
    const file = path.join(f.directory, name);
    return [
      name,
      fs.existsSync(file)
        ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
        : null,
    ];
  });
}

for (const version of [19, 20]) {
  const name = version === 19 ? 'billing_payment_open_org' : 'billing_payment_open_service';
  const columns = version === 19 ? 'organization_id' : 'organization_id,service_code';
  const scenarios = [
    ['missing payment guard', 'DROP INDEX ' + name],
    [
      'nonunique payment guard',
      'DROP INDEX ' +
        name +
        ';CREATE INDEX ' +
        name +
        ' ON billing_payment_orders(' +
        columns +
        ") WHERE state IN ('creating','pending','uncertain','review')",
    ],
    [
      'narrowed payment guard',
      'DROP INDEX ' +
        name +
        ';CREATE UNIQUE INDEX ' +
        name +
        ' ON billing_payment_orders(' +
        columns +
        ") WHERE state='pending'",
    ],
  ];

  test(
    'complete schema' + version + ' startup and archive validation leave files unchanged',
    async (t) => {
      const f = recoveryFixture(t, { seed: true });
      if (version === 20) f.db.exec(multiServiceSchema + 'PRAGMA user_version=20');
      const seen = f.manifest();
      const before = fingerprints(f);
      assert.doesNotThrow(() => assertPreparedNotifications(f.directory, version));
      await validateRecovered(f.directory, seen);
      assert.deepEqual(fingerprints(f), before);
    },
  );

  for (const [description, ddl] of scenarios) {
    test('schema' + version + ' startup rejects ' + description + ' without repairs', (t) => {
      const f = recoveryFixture(t, { seed: true });
      if (version === 20) f.db.exec(multiServiceSchema + 'PRAGMA user_version=20');
      f.db.exec(ddl);
      f.close();
      const before = fingerprints(f);
      assert.throws(() => assertPreparedNotifications(f.directory, version), { status: 503 });
      assert.deepEqual(fingerprints(f), before);
    });

    test('schema' + version + ' archive rejects ' + description + ' without repairs', async (t) => {
      const f = recoveryFixture(t, { seed: true });
      if (version === 20) f.db.exec(multiServiceSchema + 'PRAGMA user_version=20');
      f.db.exec(ddl);
      const seen = f.manifest();
      const before = fingerprints(f);
      await assert.rejects(() => validateRecovered(f.directory, seen));
      assert.deepEqual(fingerprints(f), before);
    });
  }
}
