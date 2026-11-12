const { createHash } = require('node:crypto');
const kinds = Object.freeze(['platform', 'cabinet', 'budget']);
function identifier(value) {
  if (typeof value !== 'string' || !/^[a-z_][a-z0-9_]*$/i.test(value) || value.length > 120)
    throw Error('Unsupported database identifier.');
  return '"' + value + '"';
}
function namespace(kind) {
  if (!kinds.includes(kind)) throw Error('Unsupported PostgreSQL store kind.');
  return 'cartoteca_' + kind;
}
function objectName(value) {
  identifier(value);
  return value.length <= 63
    ? value
    : value.slice(0, 44) + '_' + createHash('sha256').update(value).digest('hex').slice(0, 18);
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  return value;
}
function digest(value) {
  return createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
}
// This is compatibility metadata, never proof that PostgreSQL enforces a constraint.
function describeSqliteSchema(db) {
  const objects = db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' OR type='index' ORDER BY type,name",
    )
    .all();
  if (objects.some((row) => !['table', 'index', 'trigger'].includes(row.type)))
    throw Error('Unsupported source schema object.');
  const tables = {};
  for (const row of objects.filter((entry) => entry.type === 'table')) {
    identifier(row.name);
    const quoted = identifier(row.name);
    const columns = db.prepare('PRAGMA table_info(' + quoted + ')').all();
    if (
      !columns.length ||
      columns.some(
        (column) => !['INTEGER', 'TEXT', 'BLOB', 'REAL'].includes(column.type.toUpperCase()),
      )
    )
      throw Error('Unsupported source column type.');
    for (const column of columns) identifier(column.name);
    const primary = columns
      .filter((column) => column.pk)
      .sort((a, b) => a.pk - b.pk)
      .map((column) => column.name);
    const indexes = db
      .prepare('PRAGMA index_list(' + quoted + ')')
      .all()
      .map((index) => ({
        ...index,
        columns: db.prepare('PRAGMA index_xinfo(' + identifier(index.name) + ')').all(),
      }));
    const rowid = !/\bWITHOUT\s+ROWID\b/i.test(row.sql);
    const integerPrimaryKey =
      rowid &&
      primary.length === 1 &&
      columns.find((column) => column.name === primary[0]).type.toUpperCase() === 'INTEGER'
        ? primary[0]
        : null;
    tables[row.name] = {
      name: row.name,
      sql: row.sql,
      columns,
      primary,
      unique: indexes
        .filter((index) => index.unique && index.origin !== 'pk' && !index.partial)
        .map((index) => index.columns.filter((column) => column.key).map((column) => column.name)),
      integerPrimaryKey,
      rowid,
      indexes,
      foreignKeys: db.prepare('PRAGMA foreign_key_list(' + quoted + ')').all(),
    };
  }
  const version = db.prepare('PRAGMA user_version').get().user_version;
  return { version, objects, tables };
}
module.exports = { kinds, identifier, namespace, objectName, digest, describeSqliteSchema };
