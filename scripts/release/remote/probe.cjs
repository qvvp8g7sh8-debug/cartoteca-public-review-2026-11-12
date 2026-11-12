// Mounted into the candidate image. Synthetic storage only; never mounts production data.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
async function main() {
  const input = JSON.parse(fs.readFileSync('/tmp/probe-input.json', 'utf8'));
  assert.ok(
    input.storageBackend === undefined || ['sqlite', 'postgres'].includes(input.storageBackend),
  );
  assert.ok(
    (input.storageBackend === 'postgres'
      ? [11, 15, 16, 17, 18, 19, 20]
      : [11, 15, 16, 17, 18, 19]
    ).includes(input.schema),
  );
  for (const [name, hash] of Object.entries(input.runtime)) {
    assert.ok(!path.isAbsolute(name) && !name.split('/').includes('..'));
    assert.equal(
      crypto
        .createHash('sha256')
        .update(fs.readFileSync('/app/' + name))
        .digest('hex'),
      hash,
    );
  }
  if (input.storageBackend === 'postgres') {
    assert.equal(input.synthetic, true);
    assert.equal(input.postgresProfile, 'production-v1');
    // The rehearsal's existing owner is queried through its private control
    // socket. Do not start another owner or create SQLite synthetic storage.
    const readiness = await require('/app/scripts/postgres-readiness.cjs').postgresReadiness();
    assert.equal(readiness.ready, true);
    assert.equal(readiness.schema, input.schema);
    const { clientRelease, releaseFiles } = require('/app/src/server/http/client-release.cjs');
    const { publicAssetRoot } = require('/app/src/shared/web-assets.cjs');
    const excluded = new Set([
      'app.js',
      'app-settings.js',
      'app-assistant.js',
      'assistant-capture-worklet.js',
      'assistant-playback-worklet.js',
      'security.js',
    ]);
    const publicAssets = Object.fromEntries(
      releaseFiles
        .filter((name) => !name.endsWith('.html') && !excluded.has(name))
        .map((name) => [
          name,
          crypto
            .createHash('sha256')
            .update(fs.readFileSync(path.join(publicAssetRoot('/app'), name)))
            .digest('hex'),
        ]),
    );
    console.log(
      JSON.stringify({
        build: await clientRelease(publicAssetRoot('/app')),
        publicAssets,
        schema: input.schema,
        storageBackend: 'postgres',
        postgresProfile: 'production-v1',
        postgresReadiness: readiness,
      }),
    );
    return;
  }
  const directory = fs.mkdtempSync('/tmp/cartoteca-release-probe-');
  const platform = path.join(directory, 'platform');
  let server;
  try {
    require('/app/platform-store.cjs').createPlatformStore(platform).close();
    if (input.schema >= 15) {
      const database =
        require('/app/src/server/infrastructure/platform-database.cjs').createPlatformDatabase(
          platform,
        );
      try {
        for (const [name, fn] of [
          ['012-max-connections', 'migrateMaxConnections'],
          ['013-notification-queue', 'migrateNotificationQueue'],
          ['014-notification-channels', 'migrateNotificationChannels'],
          ['015-max-inbox', 'migrateMaxInbox'],
        ])
          require('/app/src/server/migrations/' + name + '.cjs')[fn](database, platform);
        if (input.schema >= 16)
          require('/app/src/server/migrations/016-staff-max.cjs').migrateStaffMax(
            database,
            platform,
          );
        if (input.schema >= 17)
          require('/app/src/server/migrations/017-staff-push.cjs').migrateStaffPush(
            database,
            platform,
          );
        if (input.schema === 19) {
          const budget = require('/app/src/server/infrastructure/booking-read-budget-store.cjs');
          database.db.exec(budget.registrationTable);
          const identity = crypto.randomUUID();
          database.db
            .prepare("INSERT INTO booking_read_budget_store VALUES(1,1,?,'isolated')")
            .run(identity);
          for (const guard of budget.legacyGuards) database.db.exec(guard.sql);
          const counters = new (require('node:sqlite').DatabaseSync)(
            path.join(platform, budget.filename),
          );
          try {
            counters.exec(budget.schema);
            counters.prepare('INSERT INTO budget_meta VALUES(1,?,NULL)').run(identity);
          } finally {
            counters.close();
          }
          database.db.exec(
            require('/app/src/server/infrastructure/booking-public-links-schema.cjs').schema,
          );
        }
        if (input.schema >= 18)
          require('/app/src/server/migrations/018-notification-schedule.cjs').migrateNotificationSchedule(
            database,
            platform,
          );
        if (input.schema === 19) {
          require('/app/src/server/migrations/019-paid-services.cjs').migratePaidServices(
            database,
            platform,
          );
          require('/app/src/server/modules/billing/prepared-schema.cjs').validatePaidSchema(
            database.db,
          );
        }
      } finally {
        database.db.close();
      }
    }
    server = require('/app/multi-server.cjs').createMultiServer({
      dataDir: directory,
      notificationSchema: input.schema,
      cabinetSchema: input.schema === 18 ? 2 : 0,
      scheduledNotifications: input.schema === 18,
      ...(input.schema === 19
        ? { sharedCabinetWrites: true, isolatedReadBudgets: true, readBudgetVersion: 1 }
        : {}),
      paymentNetworkEnabled: false,
      production: false,
      origin: '',
      sendMail: null,
      telegramBot: null,
      supportBot: null,
      telegramAutostart: false,
      supportAutostart: false,
      maxAutostart: false,
      adminEmailAutostart: false,
      bookingPublicationAutostart: false,
      pushEnabled: false,
      pushAutostart: false,
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    if (input.schema === 19)
      assert.equal(
        require('/app/src/server/config.cjs').configuration({ production: false })
          .paymentNetworkEnabled,
        false,
      );
    const base = 'http://127.0.0.1:' + server.address().port;
    assert.equal((await fetch(base + '/api/auth/session')).status, 200);
    assert.equal((await fetch(base + '/api/cabinet')).status, 401);
    const { clientRelease, releaseFiles } = require('/app/src/server/http/client-release.cjs');
    const { publicAssetRoot } = require('/app/src/shared/web-assets.cjs');
    const publicAssets = {};
    for (const name of releaseFiles) {
      if (
        name.endsWith('.html') ||
        [
          'app.js',
          'app-settings.js',
          'app-assistant.js',
          'assistant-capture-worklet.js',
          'assistant-playback-worklet.js',
          'security.js',
        ].includes(name)
      )
        continue;
      publicAssets[name] = crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(publicAssetRoot('/app'), name)))
        .digest('hex');
    }
    console.log(
      JSON.stringify({
        build: await clientRelease(publicAssetRoot('/app')),
        publicAssets,
        schema: input.schema,
        ...(input.schema === 19 ? { paymentNetworkEnabled: false } : {}),
      }),
    );
  } finally {
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    assert.equal(path.dirname(directory), '/tmp');
    assert.ok(path.basename(directory).startsWith('cartoteca-release-probe-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(() => {
  console.error('IMAGE_PROBE_FAILED');
  process.exitCode = 1;
});
