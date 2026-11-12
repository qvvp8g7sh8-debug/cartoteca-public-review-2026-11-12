// Independently prepared component: platform19/20 and billing DDL remain unchanged.
const MAX = 9007199254740991;
const integer = (name, extra = '') =>
  `${name} INTEGER NOT NULL CHECK(typeof(${name})='integer' AND ${name}>=0 AND ${name}<=${MAX}${extra})`;
const key = (name) => `${name} TEXT COLLATE BINARY NOT NULL`;
const blob = "value BLOB NOT NULL CHECK(typeof(value)='blob' AND length(value)>=29)";
const definitions = [];
const table = (name, columns) =>
  definitions.push({ type: 'table', name, table: name, sql: `CREATE TABLE ${name}(${columns})` });
table(
  'assistant_state_schema',
  `id INTEGER PRIMARY KEY NOT NULL CHECK(id=1),
  version INTEGER NOT NULL CHECK(version=1),backend TEXT NOT NULL CHECK(backend='rows-v1'),
  registry_mode TEXT NOT NULL CHECK(registry_mode='memory'),${key('store_id')} CHECK(length(store_id)=36),
  ${key('import_sha256')} CHECK(length(import_sha256)=64),${integer('imported_revision')},${integer('created_at')}`,
);
table(
  'assistant_settings',
  `id INTEGER PRIMARY KEY NOT NULL CHECK(id=1),${integer('revision')},
  mode TEXT NOT NULL CHECK(mode IN ('off','selected')),${integer('changed_at')},${blob}`,
);
table('assistant_admin_history', `id INTEGER PRIMARY KEY NOT NULL CHECK(id=1),${blob}`);
table(
  'assistant_grants',
  `${key('organization_id')} REFERENCES organizations(id),
  ${key('account_id')} REFERENCES accounts(id),${key('membership_id')},
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),${integer('grant_version', ' AND grant_version>=1')},
  ${integer('position')},${blob},PRIMARY KEY(organization_id,account_id)`,
);
table(
  'assistant_usage_months',
  `${key('month')},${integer('spent_microrub')},
  ${integer('reserved_microrub')},${integer('calls')},${integer('uncertain_calls')},${blob},PRIMARY KEY(month)`,
);
table(
  'assistant_usage_days',
  `${key('day')},${key('membership_id')},${integer('requests')},PRIMARY KEY(day,membership_id)`,
);
table(
  'assistant_reservations',
  `${key('id')},scope_kind TEXT NOT NULL CHECK(scope_kind IN ('actor','legacy')),
  organization_id TEXT COLLATE BINARY REFERENCES organizations(id),account_id TEXT COLLATE BINARY REFERENCES accounts(id),
  membership_id TEXT COLLATE BINARY,policy_revision INTEGER,grant_version INTEGER,
  kind TEXT NOT NULL CHECK(kind IN ('stt','llm','tts')),provider TEXT NOT NULL,
  ${key('month')},${integer('amount_microrub')},state TEXT NOT NULL CHECK(state IN ('reserved','outbound','legacy-unknown')),
  ${integer('created_at')},${integer('expires_at')},${blob},PRIMARY KEY(id),
  CHECK((scope_kind='legacy' AND organization_id IS NULL AND account_id IS NULL AND membership_id IS NULL
    AND policy_revision IS NULL AND grant_version IS NULL AND state='legacy-unknown') OR
    (scope_kind='actor' AND organization_id IS NOT NULL AND account_id IS NOT NULL AND membership_id IS NOT NULL
    AND typeof(policy_revision)='integer' AND policy_revision>=0 AND policy_revision<=${MAX}
    AND typeof(grant_version)='integer' AND grant_version>=1 AND grant_version<=${MAX} AND state IN ('reserved','outbound'))),
  CHECK(expires_at>=created_at)`,
);
table(
  'assistant_admin_operations',
  `${key('actor_id')},${key('request_id')},${key('kind')},
  ${key('fingerprint')},${integer('revision')},${integer('position')},${blob},PRIMARY KEY(actor_id,request_id)`,
);
for (const [name, target, columns] of [
  ['assistant_grants_account', 'assistant_grants', ['account_id', 'organization_id']],
  ['assistant_days_day', 'assistant_usage_days', ['day']],
  ['assistant_reservations_expiry', 'assistant_reservations', ['expires_at', 'id']],
  ['assistant_reservations_month', 'assistant_reservations', ['month', 'id']],
  ['assistant_reservations_actor', 'assistant_reservations', ['organization_id', 'account_id']],
  ['assistant_operations_position', 'assistant_admin_operations', ['position']],
])
  definitions.push({
    type: 'index',
    name,
    table: target,
    columns,
    sql: `CREATE INDEX ${name} ON ${target}(${columns.join(',')})`,
  });
const tables = Object.freeze(
  definitions
    .filter((entry) => entry.type === 'table' && entry.name !== 'assistant_state_schema')
    .map((entry) => entry.name),
);
const blobs = Object.freeze(
  Object.fromEntries(
    tables.filter((name) => name !== 'assistant_usage_days').map((name) => [name, 'value']),
  ),
);
const schema = definitions.map(({ sql }) => sql + ';').join('\n');
const primary = {
  assistant_state_schema: ['id'],
  assistant_settings: ['id'],
  assistant_admin_history: ['id'],
  assistant_grants: ['organization_id', 'account_id'],
  assistant_usage_months: ['month'],
  assistant_usage_days: ['day', 'membership_id'],
  assistant_reservations: ['id'],
  assistant_admin_operations: ['actor_id', 'request_id'],
};
function tokens(sql) {
  const pattern =
    /\s+|'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|[a-z_][a-z_0-9]*|[0-9]+|<>|<=|>=|!=|[(),=;<>+*-]/giy;
  const parts = [];
  while (pattern.lastIndex < sql.length) {
    const match = pattern.exec(sql);
    if (!match) return null;
    const part = match[0];
    if (/^\s/u.test(part)) continue;
    parts.push(
      part[0] === "'"
        ? part
        : /^["`\[]/u.test(part)
          ? part.slice(1, -1).toLowerCase()
          : part.toLowerCase(),
    );
  }
  return JSON.stringify(parts.filter((part) => part !== ';'));
}
function validate(db, { required = false } = {}) {
  const objects = db
    .prepare(
      `SELECT type,name,tbl_name,sql FROM sqlite_schema
    WHERE (lower(name) GLOB 'assistant_*' OR lower(tbl_name) GLOB 'assistant_*') AND sql IS NOT NULL`,
    )
    .all();
  if (!objects.length && !required) return null;
  const invalid = () => {
    throw Error('Assistant rows component schema mismatch');
  };
  if (
    ![19, 20].includes(db.prepare('PRAGMA user_version').get().user_version) ||
    objects.length !== definitions.length
  )
    invalid();
  for (const expected of definitions) {
    const actual = objects.find(({ name }) => name === expected.name);
    if (
      !actual ||
      actual.type !== expected.type ||
      actual.tbl_name !== expected.table ||
      tokens(actual.sql || '') !== tokens(expected.sql)
    )
      invalid();
    if (expected.type === 'table') {
      const keys = db
        .prepare(`PRAGMA table_info(${expected.table})`)
        .all()
        .filter(({ pk }) => pk)
        .sort((a, b) => a.pk - b.pk);
      if (
        JSON.stringify(keys.map(({ name }) => name)) !== JSON.stringify(primary[expected.table]) ||
        keys.some(({ notnull }) => notnull !== 1)
      )
        invalid();
      const indexes = db
        .prepare(`PRAGMA index_list(${expected.table})`)
        .all()
        .filter(({ origin }) => origin === 'pk');
      if (primary[expected.table][0] === 'id' && keys[0].type === 'INTEGER') {
        if (indexes.length) invalid();
      } else {
        const index = indexes[0];
        if (indexes.length !== 1 || index.unique !== 1 || index.partial !== 0) invalid();
        const columns = db
          .prepare(`PRAGMA index_xinfo(${index.name})`)
          .all()
          .filter(({ key }) => key === 1);
        if (
          columns.length !== keys.length ||
          columns.some(
            (column, offset) =>
              column.name !== keys[offset].name ||
              column.cid < 0 ||
              column.desc !== 0 ||
              column.coll !== 'BINARY',
          )
        )
          invalid();
      }
    }
    if (expected.type === 'index') {
      const entry = db
        .prepare(`PRAGMA index_list(${expected.table})`)
        .all()
        .find(({ name }) => name === expected.name);
      const columns = db
        .prepare(`PRAGMA index_xinfo(${expected.name})`)
        .all()
        .filter(({ key }) => key === 1);
      if (
        !entry ||
        entry.unique !== 0 ||
        entry.origin !== 'c' ||
        entry.partial !== 0 ||
        columns.length !== expected.columns.length ||
        columns.some(
          (column, index) =>
            column.name !== expected.columns[index] ||
            column.cid < 0 ||
            column.desc !== 0 ||
            column.coll !== 'BINARY',
        )
      )
        invalid();
    }
  }
  const rows = db.prepare('SELECT * FROM assistant_state_schema').all(),
    registration = rows[0];
  if (
    rows.length !== 1 ||
    registration.id !== 1 ||
    registration.version !== 1 ||
    registration.backend !== 'rows-v1' ||
    registration.registry_mode !== 'memory' ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(registration.store_id) ||
    !/^[a-f0-9]{64}$/.test(registration.import_sha256)
  )
    invalid();
  return registration;
}
module.exports = { schema, definitions, tables, blobs, validate };
