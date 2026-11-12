// Additive, offline-prepared indexes. No startup DDL or platform-version change.
const registration = 'notification_queue_maintenance_schema';
const registrationSql = `CREATE TABLE ${registration}(id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1))`;
const indexes = [
  [
    'client_ready',
    'notification_channel_jobs',
    ['channel', 'next_at', 'id', 'expires_at'],
    "status='pending'",
  ],
  [
    'client_reserved',
    'notification_channel_jobs',
    ['channel', 'lease_until', 'id'],
    "status='reserved'",
  ],
  [
    'client_sending',
    'notification_channel_jobs',
    ['channel', 'lease_until', 'id'],
    "status='sending'",
  ],
  [
    'client_expiry',
    'notification_channel_jobs',
    ['channel', 'expires_at', 'id'],
    "status='pending'",
  ],
];
for (const [prefix, table, uncertain] of [
  ['telegram', 'staff_notification_jobs', false],
  ['max', 'staff_max_jobs', true],
  ['push', 'staff_push_jobs', false],
]) {
  indexes.push(
    [
      prefix + '_ready',
      table,
      ['next_at', 'id', 'expires_at', 'status', 'lease_until'],
      "status IN ('pending','sending')",
    ],
    [prefix + '_expiry', table, ['expires_at', 'id'], "status IN ('pending','sending')"],
    [
      prefix + '_retention',
      table,
      ['expires_at', 'id'],
      "status IN ('sent','failed','cancelled'" + (uncertain ? ",'uncertain'" : '') + ')',
    ],
  );
  if (uncertain)
    indexes.push([prefix + '_sending', table, ['lease_until', 'id'], "status='sending'"]);
}
const definitions = indexes.map(([suffix, table, columns, predicate]) => ({
  name: 'nqm_v1_' + suffix,
  table,
  columns,
  predicate,
  sql: `CREATE INDEX nqm_v1_${suffix} ON ${table}(${columns.join(',')}) WHERE ${predicate}`,
}));
const schema =
  [
    registrationSql,
    ...definitions.map(({ sql }) => sql),
    `INSERT INTO ${registration} VALUES(1,1)`,
  ].join(';\n') + ';';
// Strings retain their exact case. Whitespace, keyword case and identifier quoting
// can differ; predicates, collations, direction and uniqueness cannot.
function tokens(sql) {
  const pattern =
    /\s+|'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|[a-z_][a-z_0-9]*|[0-9]+|[(),=;]/giy;
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
  return JSON.stringify(parts);
}
function validate(db, { required = false } = {}) {
  const objects = db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name=? OR substr(name,1,7)='nqm_v1_'",
    )
    .all(registration);
  if (!objects.length && !required) return null;
  const invalid = () => {
    throw Error('Notification maintenance component schema mismatch');
  };
  if (
    ![19, 20].includes(db.prepare('PRAGMA user_version').get().user_version) ||
    objects.length !== definitions.length + 1
  )
    invalid();
  const table = objects.find(({ name }) => name === registration);
  if (table?.type !== 'table' || tokens(table.sql || '') !== tokens(registrationSql)) invalid();
  const columns = db.prepare(`PRAGMA table_info(${registration})`).all();
  if (
    columns.length !== 2 ||
    columns[0].name !== 'id' ||
    columns[0].type !== 'INTEGER' ||
    columns[0].pk !== 1 ||
    columns[1].name !== 'version' ||
    columns[1].notnull !== 1 ||
    columns[1].pk !== 0
  )
    invalid();
  const rows = db.prepare(`SELECT id,version FROM ${registration}`).all();
  if (rows.length !== 1 || rows[0].id !== 1 || rows[0].version !== 1) invalid();
  for (const definition of definitions) {
    const actual = objects.find(({ name }) => name === definition.name);
    const entry = db
      .prepare(`PRAGMA index_list(${definition.table})`)
      .all()
      .find(({ name }) => name === definition.name);
    const key = db
      .prepare(`PRAGMA index_xinfo(${definition.name})`)
      .all()
      .filter(({ key }) => key === 1);
    if (
      actual?.type !== 'index' ||
      actual.tbl_name !== definition.table ||
      !entry ||
      entry.unique !== 0 ||
      entry.origin !== 'c' ||
      entry.partial !== 1 ||
      key.length !== definition.columns.length ||
      key.some(
        (column, index) =>
          column.cid < 0 ||
          column.name !== definition.columns[index] ||
          column.desc !== 0 ||
          column.coll !== 'BINARY',
      ) ||
      tokens(actual.sql || '') !== tokens(definition.sql)
    )
      invalid();
  }
  return { version: 1 };
}
module.exports = { schema, validate, definitions };
