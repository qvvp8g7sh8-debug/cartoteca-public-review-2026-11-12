const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { identifier: q } = require('./catalog-sqlite.cjs');
const { qualify } = require('./schema-plan.cjs');
const { openBytes } = require('./backup-verify.cjs');
const { scope } = require('./backup-snapshot.cjs');
const rowCodec = require('../../modules/assistant/access/row-codec.cjs');
function codec(key) {
  return {
    open: (bytes) => JSON.parse(openBytes(key, bytes).toString('utf8')),
    seal: (value) => {
      const iv = crypto.randomBytes(12),
        cipher = crypto.createCipheriv('aes-256-gcm', key, iv),
        data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
  };
}
async function revokePostgresCredentials(client, { directory, manifest }) {
  const platform = manifest.stores.find((store) => store.kind === 'platform'),
    key = fs.readFileSync(path.join(directory, 'platform', 'platform.key')),
    c = codec(key),
    now = Date.now();
  await scope(client, 'platform', platform.storeId);
  const exists = (name) => Boolean(platform.metadata.tables[name]);
  const run = (name, tail = '', values = []) =>
    client.query(
      tail.startsWith('SELECT')
        ? tail
        : 'DELETE FROM ' +
            qualify('platform', name) +
            ' WHERE _store_id=$1' +
            (tail ? ' AND ' + tail : ''),
      [platform.storeId, ...values],
    );
  const rows = async (name) =>
    (
      await client.query('SELECT * FROM ' + qualify('platform', name) + ' WHERE _store_id=$1', [
        platform.storeId,
      ])
    ).rows;
  async function update(name, row, changes, value) {
    const table = platform.metadata.tables[name],
      names = Object.keys(changes),
      values = Object.values(changes);
    if (value !== undefined) {
      names.push('value');
      values.push(c.seal(value));
    }
    const primary = table.primary;
    if (!primary.length) throw Error('Cannot revoke an unkeyed capability.');
    const params = [...values, platform.storeId, ...primary.map((column) => row[column])];
    await client.query(
      'UPDATE ' +
        qualify('platform', name) +
        ' SET ' +
        names.map((column, i) => q(column) + '=$' + (i + 1)).join(',') +
        ' WHERE _store_id=$' +
        (values.length + 1) +
        ' AND ' +
        primary.map((column, i) => q(column) + '=$' + (values.length + i + 2)).join(' AND '),
      params,
    );
  }
  for (const name of [
    'platform_sessions',
    'password_resets',
    'email_verifications',
    'invitations',
    'admin_bootstraps',
    'telegram_link_tokens',
    'staff_telegram_tokens',
    'max_client_tokens',
    'staff_max_tokens',
    'max_runtime_leases',
    'staff_push_devices',
    'admin_operations',
  ])
    if (exists(name)) await run(name);
  for (const row of await rows('accounts')) {
    const value = c.open(row.value);
    delete value.calendarSubscriptions;
    delete value.adminMfaPending;
    if (value.adminMfa?.enabled) value.adminMfa = { ...value.adminMfa, recoveryHashes: [] };
    await update('accounts', row, {}, value);
  }
  await run(
    'login_limits',
    "NOT ((key >= 'booking-budget:read-address:' AND key < 'booking-budget:read-address;') OR (key >= 'booking-budget:site-read:' AND key < 'booking-budget:site-read;'))",
  );
  await run(
    'telegram_runtime',
    "key IN ('poll-leader','application-process-roles') OR key LIKE 'client-interest-v1:%' OR key LIKE 'staff-interest-v1:%' OR key LIKE 'push-interest-v1:%'",
  );
  for (const name of [
    'telegram_jobs',
    'notification_jobs',
    'notification_channel_jobs',
    'staff_notification_jobs',
    'staff_max_jobs',
    'staff_push_jobs',
    'admin_email_jobs',
    'support_deliveries',
  ])
    if (exists(name))
      for (const row of await rows(name)) {
        const field = Object.hasOwn(row, 'status') ? 'status' : null;
        if (!field) continue;
        const changes = {};
        if (['pending', 'reserved', 'sending', 'waiting'].includes(row.status)) {
          changes.status = ['staff_push_jobs', 'admin_email_jobs'].includes(name)
            ? 'cancelled'
            : 'failed';
          if (Object.hasOwn(row, 'lease_until')) changes.lease_until = 0;
          if (Object.hasOwn(row, 'lease_id')) changes.lease_id = null;
        }
        if (Object.hasOwn(row, 'callback_hash'))
          changes.callback_hash = crypto.randomBytes(32).toString('hex');
        if (Object.keys(changes).length) await update(name, row, changes);
      }
  if (exists('admin_email_recoveries'))
    for (const row of await rows('admin_email_recoveries'))
      if (row.used_at === null) await update('admin_email_recoveries', row, { used_at: now });
  if (exists('max_event_inbox'))
    for (const row of await rows('max_event_inbox'))
      await update('max_event_inbox', row, {
        status: 'failed',
        lease_until: 0,
        lease_id: null,
        next_at: 0,
      });
  for (const name of [
    'telegram_links',
    'max_client_links',
    'staff_telegram_links',
    'staff_max_links',
  ])
    if (exists(name))
      for (const row of await rows(name)) {
        const value = c.open(row.value);
        if (name === 'telegram_links')
          value.consentToken = crypto.randomBytes(20).toString('base64url');
        else if (name === 'max_client_links') {
          value.bindingId = crypto.randomUUID();
          value.restoredPaused = true;
        } else {
          value.enabled = false;
          if (name === 'staff_max_links') value.bindingId = crypto.randomUUID();
        }
        await update(name, row, {}, value);
      }
  const settings = new Map(
    (await rows('telegram_settings')).map((row) => [row.organization_id, row]),
  );
  for (const organization of await rows('organizations')) {
    const old = settings.get(organization.id),
      value = {
        ...(old ? c.open(old.value) : { leadMinutes: 1440, showServices: true }),
        enabled: false,
        restoredPaused: true,
      };
    await client.query(
      'INSERT INTO cartoteca_platform.telegram_settings(_store_id,organization_id,value) VALUES($1,$2,$3) ON CONFLICT(_store_id,organization_id) DO UPDATE SET value=excluded.value',
      [platform.storeId, organization.id, c.seal(value)],
    );
  }
  for (const name of [
    'notification_schedule',
    'notification_schedule_dirty',
    'notification_schedule_intents',
  ])
    if (exists(name)) await run(name);
  if (exists('notification_schedule_dirty'))
    for (const row of (
      await client.query(
        'SELECT organization_id FROM cartoteca_platform.telegram_links WHERE _store_id=$1 UNION SELECT organization_id FROM cartoteca_platform.max_client_links WHERE _store_id=$1',
        [platform.storeId],
      )
    ).rows)
      await client.query(
        "INSERT INTO cartoteca_platform.notification_schedule_dirty(_store_id,kind,organization_id,subject) VALUES($1,'client',$2,'') ON CONFLICT DO NOTHING",
        [platform.storeId, row.organization_id],
      );
  if (exists('billing_settings'))
    for (const row of await rows('billing_settings'))
      await update('billing_settings', row, {
        configured: 0,
        revision: BigInt(row.revision) + 1n,
        changed_at: now,
      });
  if (exists('billing_service_connections'))
    for (const row of await rows('billing_service_connections'))
      await update(
        'billing_service_connections',
        row,
        {
          enabled: 0,
          key_id: null,
          credential_hash: null,
          revision: BigInt(row.revision) + 1n,
          changed_at: now,
        },
        { ...c.open(row.value), credential: null, restoredPaused: true },
      );
  if (exists('billing_payment_settings'))
    for (const row of await rows('billing_payment_settings'))
      await update(
        'billing_payment_settings',
        row,
        { configured: 0, revision: BigInt(row.revision) + 1n, changed_at: now },
        { ...c.open(row.value), secretKey: null, restoredPaused: true },
      );
  if (exists('billing_payment_orders'))
    for (const row of await rows('billing_payment_orders')) {
      const value = c.open(row.value),
        pending = ['creating', 'pending', 'uncertain'].includes(row.state);
      value.restoredReview = true;
      if (pending) {
        value.receiptEmail = null;
        value.confirmationUrl = null;
      }
      if (value.seller && typeof value.seller === 'object')
        value.seller = { ...value.seller, secretKey: null };
      await update(
        'billing_payment_orders',
        row,
        { state: pending ? 'review' : row.state, changed_at: now, lease_until: 0, lease_id: null },
        value,
      );
    }
  if (exists('billing_financial_actions'))
    for (const row of await rows('billing_financial_actions'))
      await update(
        'billing_financial_actions',
        row,
        {
          state: ['creating', 'pending', 'uncertain', 'review'].includes(row.state)
            ? 'review'
            : row.state,
          lease_until: 0,
          changed_at: now,
        },
        { ...c.open(row.value), receiptEmail: null },
      );
  if (exists('assistant_state_schema')) {
    const registration = (await rows('assistant_state_schema'))[0];
    if (!registration) throw Error('Assistant rows registration is missing.');
    for (const row of await rows('assistant_reservations')) {
      const decoded = rowCodec.decode(
        c,
        registration,
        'assistant_reservations',
        [row.id],
        row.value,
      );
      if (!decoded.reservation || decoded.reservation.month !== row.month)
        throw Error('Restored assistant reservation binding mismatch.');
      await client.query(
        'UPDATE cartoteca_platform.assistant_usage_months SET spent_microrub=spent_microrub+$1,reserved_microrub=reserved_microrub-$1,calls=calls+1,uncertain_calls=uncertain_calls+1 WHERE _store_id=$2 AND month=$3',
        [row.amount_microrub, platform.storeId, row.month],
      );
      await run('assistant_reservations', 'id=$2', [row.id]);
    }
    const setting = (await rows('assistant_settings'))[0],
      value = rowCodec.decode(c, registration, 'assistant_settings', [1], setting.value);
    value.revision++;
    value.policy.mode = 'off';
    value.credentials = {};
    value.behavior = { version: value.behavior.version + 1, current: null };
    await client.query(
      'UPDATE cartoteca_platform.assistant_settings SET revision=$1,mode=$2,changed_at=$3,value=$4 WHERE _store_id=$5 AND id=1',
      [
        value.revision,
        'off',
        now,
        rowCodec.encode(c, registration, 'assistant_settings', [1], value),
        platform.storeId,
      ],
    );
    await client.query(
      'UPDATE cartoteca_platform.assistant_admin_history SET value=$1 WHERE _store_id=$2 AND id=1',
      [
        rowCodec.encode(c, registration, 'assistant_admin_history', [1], {
          history: [],
          audit: [],
          behaviorHistory: [],
        }),
        platform.storeId,
      ],
    );
    for (const row of await rows('assistant_grants')) {
      const value = rowCodec.decode(
          c,
          registration,
          'assistant_grants',
          [row.organization_id, row.account_id],
          row.value,
        ),
        version = Number(BigInt(row.grant_version) + 1n);
      await client.query(
        'UPDATE cartoteca_platform.assistant_grants SET enabled=0,grant_version=$1,value=$2 WHERE _store_id=$3 AND organization_id=$4 AND account_id=$5',
        [
          version,
          rowCodec.encode(
            c,
            registration,
            'assistant_grants',
            [row.organization_id, row.account_id],
            { grant: value.grant, enabled: false, version },
          ),
          platform.storeId,
          row.organization_id,
          row.account_id,
        ],
      );
    }
    await run('assistant_admin_operations');
  } else
    require('../../modules/assistant/access/store.cjs').resetRestoredAssistant({
      directory: path.join(directory, 'platform'),
      seal: c.seal,
      open: c.open,
    });
  for (const store of manifest.stores.filter((row) => row.kind === 'cabinet')) {
    await scope(client, 'cabinet', store.storeId);
    for (const name of ['sessions', 'limits'])
      await client.query('DELETE FROM ' + qualify('cabinet', name) + ' WHERE _store_id=$1', [
        store.storeId,
      ]);
    await client.query(
      "DELETE FROM cartoteca_cabinet.meta WHERE _store_id=$1 AND key IN ('reset','mfaPending')",
      [store.storeId],
    );
  }
  await scope(client, 'platform', platform.storeId);
  await client.query(
    "INSERT INTO cartoteca_platform.platform_audit(time,event,detail) VALUES($1,'backup_restored',$2)",
    [now, JSON.stringify({ format: 2, backend: 'postgres', notificationsPaused: true })],
  );
  return { sessionsRevoked: true, notificationsPaused: true };
}
module.exports = { revokePostgresCredentials, codec };
