const test = require('node:test');
const assert = require('node:assert/strict');
const { postgresBusinessFixture } = require('./helpers/postgres-business133-fixture.cjs');
const {
  createNotificationCoordinator,
} = require('../src/server/modules/notifications/notification-coordinator.cjs');

test(
  'managed PostgreSQL client planning reaches real enqueue and delivery without replacing the coordinator transaction',
  { timeout: 90000 },
  async (t) => {
    const f = await postgresBusinessFixture(t);
    const settings = f.platform.telegram.settings(f.org);
    f.platform.telegram.saveReminderPeriod(f.org, f.owner.accountId, {
      expectedLeadMinutes: settings.leadMinutes,
      leadMinutes: 20160,
    });
    const sent = [];
    const coordinator = createNotificationCoordinator({
      platform: f.platform,
      tenantStore: f.context.tenantStore,
      store: f.platform.notificationStore,
      links: f.platform.maxLinks,
      providers: {
        telegram: {
          status: () => ({ configured: true, connected: true, botId: 'synthetic-bot' }),
          acquire: async () => true,
          send: async (value) => {
            assert.equal(f.database.db.isTransaction, false, 'provider starts only after commit');
            sent.push(value);
            return { message_id: 1 };
          },
        },
      },
      clock: () => f.now,
    });
    // Real UUID organizations after this fixture's cabinet. Their durable work
    // must remain untouched when the first cabinet already has a due reminder.
    const others = Array.from({ length: 8 }, (_, index) => {
      const hex = (BigInt('0x' + f.org.replaceAll('-', '')) + BigInt(index + 1))
        .toString(16)
        .padStart(32, '0');
      return [
        hex.slice(0, 8),
        hex.slice(8, 12),
        hex.slice(12, 16),
        hex.slice(16, 20),
        hex.slice(20),
      ].join('-');
    });
    f.platform.telegram.saveSettings(f.org, f.owner.accountId, {
      enabled: true,
      leadMinutes: 20160,
      timeZone: settings.timeZone,
      events: ['reminder'],
    });
    f.database.transaction(() => {
      for (const [index, org] of others.entries()) {
        f.database.db
          .prepare(
            'INSERT INTO organizations SELECT ?,value,?,status,created_at FROM organizations WHERE id=?',
          )
          .run(org, 'synthetic-planner-' + index, f.org);
        f.database.db
          .prepare('INSERT INTO telegram_links VALUES(?,?,?,?)')
          .run(
            org,
            'synthetic-foreign',
            'synthetic-' + index,
            f.database.seal({ chatId: 'synthetic-other', linkedAt: 1 }),
          );
        f.platform.notificationSchedule.markDirty(org, 'client');
      }
      f.platform.notificationSchedule.markDirty(f.org, 'client');
    });
    const foreignDirty = () =>
      f.database.db
        .prepare(
          'SELECT * FROM notification_schedule_dirty WHERE organization_id<>? ORDER BY organization_id,subject',
        )
        .all(f.org);
    const foreignBefore = foreignDirty();
    const foreignLock =
      require('../src/server/infrastructure/postgres/lock-intents.cjs').advisoryKey(
        'cartoteca:platform-organization:v1:' + f.database.db.scope.storeId + ':' + others[0],
      );
    await f.admin.query('SELECT pg_advisory_lock($1::bigint)', [foreignLock]);
    const controller = new AbortController();
    let queuedBeforeFullDiscovery = false;
    try {
      assert.equal(
        await coordinator.scheduleBatched({
          signal: controller.signal,
          runWork(work) {
            const value = work();
            if (
              f.database.db
                .prepare('SELECT 1 FROM notification_channel_jobs WHERE organization_id=?')
                .get(f.org)
            ) {
              queuedBeforeFullDiscovery = true;
              controller.abort();
            }
            return value;
          },
        }),
        false,
      );
    } finally {
      await f.admin.query('SELECT pg_advisory_unlock($1::bigint)', [foreignLock]);
    }
    assert.equal(queuedBeforeFullDiscovery, true);
    assert.deepEqual(
      foreignDirty(),
      foreignBefore,
      'foreign work and captured generations remain untouched despite a held foreign lock',
    );
    f.database.transaction(() =>
      f.database.db
        .prepare('DELETE FROM notification_schedule_dirty WHERE organization_id<>?')
        .run(f.org),
    );
    const jobs = () =>
      f.database.db
        .prepare('SELECT channel,status FROM notification_channel_jobs WHERE organization_id=?')
        .all(f.org);
    assert.deepEqual(
      jobs().map((r) => ({ ...r })),
      [{ channel: 'telegram', status: 'pending' }],
    );
    await coordinator.tick();
    assert.equal(sent.length, 1);
    assert.deepEqual(
      jobs().map((r) => ({ ...r })),
      [{ channel: 'telegram', status: 'sent' }],
    );
    assert.equal(await coordinator.scheduleBatched(), true);
    await coordinator.tick();
    assert.equal(sent.length, 1, 'completed due work cannot create a duplicate delivery');
  },
);
