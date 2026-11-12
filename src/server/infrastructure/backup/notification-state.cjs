const crypto = require('node:crypto');

function notificationBlobs(version) {
  return {
    ...(version >= 18
      ? { notification_schedule: 'value', notification_schedule_intents: 'value' }
      : {}),
    ...(version >= 17
      ? { staff_push_config: 'value', staff_push_devices: 'value', staff_push_jobs: 'value' }
      : {}),
    ...(version >= 12
      ? {
          max_client_links: 'value',
          max_client_tokens: 'value',
          max_client_stops: 'value',
          notification_preferences: 'value',
        }
      : {}),
    ...(version >= 13 ? { notification_jobs: 'value', notification_confirmations: 'value' } : {}),
    ...(version >= 14 ? { notification_channel_jobs: 'value' } : {}),
    ...(version >= 15 ? { max_event_inbox: 'value' } : {}),
    ...(version >= 16
      ? {
          staff_max_links: 'value',
          staff_max_tokens: 'value',
          staff_max_jobs: 'value',
          staff_max_stops: 'value',
        }
      : {}),
  };
}
// Disaster recovery retains financial/package history, amounts and task quotas.
// Paid capabilities and old orders pause until administrator reconciliation.
function pauseRestoredPaidServices(db, key, openValue, seal) {
  if (db.prepare('PRAGMA user_version').get().user_version < 19) return;
  const changedAt = Date.now();
  if (db.prepare('PRAGMA user_version').get().user_version >= 20) {
    for (const row of db.prepare('SELECT * FROM billing_financial_actions').all()) {
      const data = JSON.parse(openValue(key, row.value).toString('utf8'));
      data.receiptEmail = null;
      db.prepare(
        'UPDATE billing_financial_actions SET state=?,lease_until=0,changed_at=?,value=? WHERE id=?',
      ).run(
        ['creating', 'pending', 'uncertain', 'review'].includes(row.state) ? 'review' : row.state,
        changedAt,
        seal(key, data),
        row.id,
      );
    }
  }
  db.prepare(
    'UPDATE billing_settings SET configured=0,revision=revision+1,changed_at=? WHERE id=1',
  ).run(changedAt);
  const update = db.prepare(
    'UPDATE billing_service_connections SET enabled=0,key_id=NULL,credential_hash=NULL,' +
      'value=?,revision=revision+1,changed_at=? WHERE organization_id=? AND service=?',
  );
  for (const row of db
    .prepare('SELECT organization_id,service,value FROM billing_service_connections')
    .all())
    update.run(
      seal(key, {
        ...JSON.parse(openValue(key, row.value).toString('utf8')),
        credential: null,
        restoredPaused: true,
      }),
      changedAt,
      row.organization_id,
      row.service,
    );
  // Package grants, task states, money and completed payment history are not
  // rewritten. This source-only offline hook revokes old payment capabilities.
  for (const row of db.prepare('SELECT id,value FROM billing_payment_settings').all())
    db.prepare(
      'UPDATE billing_payment_settings SET configured=0,revision=revision+1,changed_at=?,value=? WHERE id=?',
    ).run(
      changedAt,
      seal(key, {
        ...JSON.parse(openValue(key, row.value).toString('utf8')),
        secretKey: null,
        restoredPaused: true,
      }),
      row.id,
    );
  const pauseOrder = db.prepare(
    'UPDATE billing_payment_orders SET state=?,changed_at=?,lease_until=0,lease_id=NULL,value=? WHERE id=?',
  );
  for (const row of db.prepare('SELECT id,state,value FROM billing_payment_orders').all()) {
    const data = JSON.parse(openValue(key, row.value).toString('utf8'));
    const pending = ['creating', 'pending', 'uncertain'].includes(row.state);
    data.restoredReview = true;
    if (pending) {
      data.receiptEmail = null;
      data.confirmationUrl = null;
    }
    if (data.seller && typeof data.seller === 'object')
      data.seller = { ...data.seller, secretKey: null };
    // Completed timestamps, amount and receipt fields remain unchanged. Only
    // already-open orders enter review, respecting the open-order unique index.
    pauseOrder.run(pending ? 'review' : row.state, changedAt, seal(key, data), row.id);
  }
}
// Disaster restore keeps client history/receipts, but revokes capabilities and delivery.
function pauseRestoredNotifications(db, key, openValue, seal) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version >= 17) {
    db.prepare('DELETE FROM staff_push_devices').run();
    db.prepare(
      "UPDATE staff_push_jobs SET status='cancelled',lease_id=NULL,lease_until=0 WHERE status IN ('pending','sending')",
    ).run();
  }
  if (version >= 12) {
    db.prepare('DELETE FROM max_client_tokens').run();
    for (const row of db
      .prepare('SELECT organization_id,patient_id,value FROM max_client_links')
      .all())
      db.prepare(
        'UPDATE max_client_links SET value=? WHERE organization_id=? AND patient_id=?',
      ).run(
        seal(key, {
          ...JSON.parse(openValue(key, row.value).toString('utf8')),
          bindingId: crypto.randomUUID(),
          restoredPaused: true,
        }),
        row.organization_id,
        row.patient_id,
      );
  }
  for (const table of [
    ...(version >= 13 ? ['notification_jobs'] : []),
    ...(version >= 14 ? ['notification_channel_jobs'] : []),
  ]) {
    db.prepare(
      `UPDATE ${table} SET status='failed',lease_until=0 WHERE status IN ('pending','reserved','sending')`,
    ).run();
    db.prepare(`UPDATE ${table} SET callback_hash=lower(hex(randomblob(32)))`).run();
  }
  if (version >= 15) {
    db.prepare('DELETE FROM max_runtime_leases').run();
    db.prepare(
      "UPDATE max_event_inbox SET status='failed',lease_until=0,lease_id=NULL,next_at=0",
    ).run();
  }
  if (version >= 16) {
    db.prepare('DELETE FROM staff_max_tokens').run();
    db.prepare(
      "UPDATE staff_max_jobs SET status='failed',lease_id=NULL,lease_until=0 WHERE status IN ('pending','sending')",
    ).run();
    for (const row of db
      .prepare('SELECT organization_id,account_id,value FROM staff_max_links')
      .all())
      db.prepare('UPDATE staff_max_links SET value=? WHERE organization_id=? AND account_id=?').run(
        seal(key, {
          ...JSON.parse(openValue(key, row.value).toString('utf8')),
          enabled: false,
          bindingId: crypto.randomUUID(),
        }),
        row.organization_id,
        row.account_id,
      );
  }
  pauseRestoredPaidServices(db, key, openValue, seal);
  resetNotificationInterests(db);
  if (version >= 18) resetNotificationSchedule(db);
}
// Offline restore only, after all writer triggers ran. Never preserve stale
// projection/intent ownership across replacing an authoritative tenant snapshot.
function resetNotificationSchedule(db, organizationId = '') {
  if (db.prepare('PRAGMA user_version').get().user_version < 18) return;
  for (const table of [
    'notification_schedule',
    'notification_schedule_dirty',
    'notification_schedule_intents',
  ])
    if (organizationId)
      db.prepare(`DELETE FROM ${table} WHERE organization_id=?`).run(organizationId);
    else db.prepare(`DELETE FROM ${table}`).run();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO notification_schedule_dirty(kind,organization_id,subject) VALUES(?,?,'')`,
  );
  if (organizationId) {
    insert.run('client', organizationId);
    insert.run('workday', organizationId);
  } else {
    for (const { organization_id: org } of db
      .prepare(
        'SELECT organization_id FROM telegram_links UNION SELECT organization_id FROM max_client_links',
      )
      .all())
      insert.run('client', org);
    for (const { organization_id: org } of db
      .prepare('SELECT DISTINCT organization_id FROM staff_push_devices')
      .all())
      insert.run('workday', org);
  }
}
module.exports = {
  notificationBlobs,
  pauseRestoredNotifications,
  pauseRestoredPaidServices,
  resetNotificationSchedule,
  resetNotificationInterests,
};

// Derived delivery lookups never survive an authoritative offline restore.
function resetNotificationInterests(db, organizationId = '') {
  require('../../modules/notifications/staff-notification-interest.cjs').resetStaffNotificationInterest(
    db,
    organizationId,
  );
  require('../../modules/notifications/push-activity.cjs').resetPushNotificationInterest(
    db,
    organizationId,
  );
  if (organizationId) {
    const remove = db.prepare('DELETE FROM telegram_runtime WHERE key=?');
    for (const kind of ['all', 'reminder', 'lifecycle'])
      remove.run('client-interest-v1:' + kind + ':' + organizationId);
  } else db.prepare("DELETE FROM telegram_runtime WHERE key GLOB 'client-interest-v1:*'").run();
}
