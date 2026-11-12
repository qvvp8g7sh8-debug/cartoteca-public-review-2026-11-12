const path = require('node:path');
const crypto = require('node:crypto');
const { writeTypedRows } = require('./backup-rows.cjs');
const { rows, seal } = require('./organization-policy.cjs');
const { atomicJson } = require('../backup/durable.cjs');
function defaults(table) {
  const row = { __ordinal: 0n };
  for (const column of table.columns) {
    const value = column.dflt_value;
    if (value === null || /^NULL$/i.test(value)) row[column.name] = null;
    else if (/^\(?-?\d+\)?$/.test(value)) row[column.name] = BigInt(value.replace(/[()]/g, ''));
    else if (/^'(?:[^']|'')*'$/.test(value))
      row[column.name] = value.slice(1, -1).replaceAll("''", "'");
    else throw Error('Unsupported selective recovery default.');
  }
  return row;
}
async function buildCandidate({
  before,
  historical,
  directory,
  currentPlatform,
  currentCabinet,
  historicalPlatform,
  historicalCabinet,
  organizationId,
  context,
}) {
  const output = {
    format: 1,
    platform: { ...currentPlatform, tables: [] },
    cabinet: { ...currentCabinet, tables: [] },
  };
  const modes = new Map(context.policy.map((row) => [row.name, row.mode]));
  for (const name of Object.keys(currentPlatform.metadata.tables).sort()) {
    const table = currentPlatform.metadata.tables[name],
      file = 'postgres/platform/' + currentPlatform.storeId + '/' + name + '.jsonl';
    async function* transformed() {
      if (name === 'telegram_runtime') return;
      if (modes.get(name) === 'revoke') {
        if (name === 'notification_schedule_dirty')
          for (const [kind, index] of [
            ['client', 0n],
            ['workday', 1n],
          ])
            yield {
              ...defaults(table),
              __ordinal: index,
              kind,
              organization_id: organizationId,
              subject: '',
            };
        return;
      }
      const from = modes.get(name) === 'restore' ? historical : before,
        store = modes.get(name) === 'restore' ? historicalPlatform : currentPlatform;
      let emitted = 0;
      for await (const original of rows(from, store, name)) {
        if (
          name === 'organizations'
            ? original.id !== organizationId
            : table.columns.some((column) => column.name === 'organization_id')
              ? original.organization_id !== organizationId
              : false
        )
          continue;
        const row = { ...original };
        if (
          ['telegram_links', 'max_client_links', 'notification_preferences'].includes(name) &&
          !context.patients.has(row.patient_id)
        )
          continue;
        if (name === 'organizations') row.value = seal(context.key, context.profile);
        if (name === 'booking_requests' && ['pending', 'requested'].includes(row.status)) {
          row.status = 'expired';
          row.revision = BigInt(row.revision) + 1n;
        }
        if (['telegram_jobs', 'notification_jobs', 'notification_channel_jobs'].includes(name)) {
          row.status = 'failed';
          row.lease_until = 0n;
          row.callback_hash = crypto.randomBytes(32).toString('hex');
        }
        if (
          [
            'telegram_settings',
            'telegram_links',
            'max_client_links',
            'staff_telegram_links',
            'staff_max_links',
            'work_schedule_profiles',
          ].includes(name)
        ) {
          const value = require('./organization-policy.cjs').decode(context.key, row.value);
          if (name === 'telegram_settings')
            Object.assign(value, { enabled: false, restoredPaused: true });
          if (name === 'telegram_links')
            value.consentToken = crypto.randomBytes(20).toString('base64url');
          if (name === 'max_client_links')
            Object.assign(value, { bindingId: crypto.randomUUID(), restoredPaused: true });
          if (['staff_telegram_links', 'staff_max_links'].includes(name))
            Object.assign(value, {
              enabled: false,
              restoredPaused: true,
              bindingId: crypto.randomUUID(),
            });
          if (name === 'work_schedule_profiles') {
            value.revision = (value.revision || 0) + 1;
            if (!Number.isSafeInteger(value.revision)) throw Error('Schedule revision overflow.');
          }
          row.value = seal(context.key, value);
        }
        emitted++;
        yield row;
      }
      if (name === 'telegram_settings' && !emitted)
        yield {
          ...defaults(table),
          organization_id: organizationId,
          value: seal(context.key, {
            enabled: false,
            restoredPaused: true,
            leadMinutes: 1440,
            showServices: true,
          }),
        };
    }
    output.platform.tables.push({
      name,
      file,
      ...(await writeTypedRows(path.join(directory, file), table, transformed())),
    });
  }
  for (const name of Object.keys(currentCabinet.metadata.tables).sort()) {
    const table = currentCabinet.metadata.tables[name],
      file = 'postgres/cabinet/' + currentCabinet.storeId + '/' + name + '.jsonl';
    async function* transformed() {
      if (['sessions', 'limits'].includes(name)) return;
      for await (const row of rows(historical, historicalCabinet, name))
        if (name !== 'meta' || !['reset', 'mfaPending'].includes(row.key)) yield row;
    }
    output.cabinet.tables.push({
      name,
      file,
      ...(await writeTypedRows(path.join(directory, file), table, transformed())),
    });
  }
  atomicJson(path.join(directory, 'inventory.json'), output);
  return output;
}
module.exports = { buildCandidate };
