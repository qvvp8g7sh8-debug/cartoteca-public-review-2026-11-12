const { identifier: q, namespace, objectName, digest } = require('./catalog-sqlite.cjs');
const qualify = (kind, name) => q(namespace(kind)) + '.' + q(name);
function balanced(source, opening) {
  let level = 0,
    quoted = false;
  for (let i = opening; i < source.length; i++) {
    if (source[i] === "'") {
      if (quoted && source[i + 1] === "'") {
        i++;
        continue;
      }
      quoted = !quoted;
    }
    if (quoted) continue;
    if (source[i] === '(') level++;
    if (source[i] === ')' && --level === 0) return i;
  }
  throw Error('Unbalanced canonical SQL.');
}
function checks(sql) {
  const result = [],
    pattern = /\bCHECK\s*\(/gi;
  let match;
  while ((match = pattern.exec(sql))) {
    const open = sql.indexOf('(', match.index),
      end = balanced(sql, open);
    result.push(sql.slice(open + 1, end));
    pattern.lastIndex = end + 1;
  }
  return result;
}
function expression(sql) {
  const value = sql
    .replace(
      /\btypeof\(\s*([a-z_][a-z0-9_]*)\s*\)\s*=\s*'(integer|text|blob|real)'/gi,
      '($1 IS NOT NULL)',
    )
    .replace(
      /\blength\(CAST\(([a-z_][a-z0-9_]*) AS BLOB\)\)/gi,
      "octet_length(convert_to($1,'UTF8'))",
    )
    .replace(/\b([a-z_][a-z0-9_]*)\s+NOT\s+GLOB\s+'\*\[\^a-z0-9\]\*'/gi, "$1 !~ '[^a-z0-9]'")
    .replace(/\bjson_valid\(/gi, 'cartoteca_catalog.json_valid(')
    .replace(
      /\b(NEW\.[a-z_][a-z0-9_]*)\s+IS\s+NOT\s+(OLD\.[a-z_][a-z0-9_]*)/gi,
      '$1 IS DISTINCT FROM $2',
    )
    .replace(
      /\b(NEW\.[a-z_][a-z0-9_]*)\s+IS\s+(OLD\.[a-z_][a-z0-9_]*)/gi,
      '$1 IS NOT DISTINCT FROM $2',
    );
  if (/\b(?:typeof|GLOB|COLLATE|RAISE)\b/i.test(value))
    throw Error('Unsupported canonical SQL expression.');
  return value;
}
function checkExpression(sql) {
  // SQLite accepts a numeric predicate; the compatibility helper deliberately
  // keeps its integer result for runtime SELECTs. Only this closed canonical
  // CHECK form needs a boolean conversion (NULL still passes the constraint).
  const valid = /^\s*json_valid\(\s*([a-z_][a-z0-9_]*)\s*\)\s*$/i.exec(sql);
  return valid ? 'cartoteca_catalog.json_valid(' + q(valid[1]) + ')<>0' : expression(sql);
}
function type(column) {
  const types = {
    INTEGER: 'BIGINT',
    TEXT: 'TEXT COLLATE "C"',
    BLOB: 'BYTEA',
    REAL: 'DOUBLE PRECISION',
  };
  if (!types[column.type.toUpperCase()]) throw Error('Unsupported canonical column type.');
  return types[column.type.toUpperCase()];
}
function defaultValue(value) {
  if (value === null) return '';
  if (!/^(?:-?\d+(?:\.\d+)?|NULL|'(?:[^']|'')*'|\(\s*-?\d+\s*\))$/i.test(value))
    throw Error('Unsupported canonical default.');
  return ' DEFAULT ' + value;
}
function nativeTrigger(kind, object, catalog) {
  const match =
    /^CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s+(BEFORE|AFTER)\s+(INSERT|DELETE|UPDATE(?:\s+OF\s+[a-z_][a-z0-9_,\s]*)?)\s+ON\s+([a-z_][a-z0-9_]*)\s*(?:WHEN\s+([\s\S]*?))?\s+BEGIN\s+([\s\S]*?)\s*END\s*;?$/i.exec(
      object.sql,
    );
  if (!match || !catalog.tables[match[4]])
    throw Error('Unsupported canonical trigger: ' + object.name);
  const [, name, timing, event, table, condition, originalBody] = match;
  let body;
  const denied = /^SELECT\s+RAISE\(ABORT,\s*('(?:[^']|'')*')\s*\)\s*;?$/i.exec(originalBody.trim());
  if (denied) body = "RAISE EXCEPTION USING ERRCODE='23514', MESSAGE=" + denied[1] + ';';
  else {
    if (
      !/^INSERT\s+INTO\s+notification_schedule_dirty\b/i.test(originalBody.trim()) ||
      originalBody
        .split(';')
        .filter((part) => part.trim())
        .some((part) => !/^\s*INSERT\s+INTO\s+notification_schedule_dirty\b/i.test(part))
    )
      throw Error('Unsupported mutating canonical trigger: ' + name);
    body = originalBody
      .replace(
        /INSERT\s+INTO\s+notification_schedule_dirty\s*\(/gi,
        'INSERT INTO ' + qualify(kind, 'notification_schedule_dirty') + ' AS target(',
      )
      .replace(/ON\s+CONFLICT\s*\(/gi, 'ON CONFLICT(_store_id,')
      .replace(/SET\s+version\s*=\s*version\s*\+\s*1/gi, 'SET version=target.version+1');
  }
  let guard = condition ? expression(condition) : '';
  for (const tableName of Object.keys(catalog.tables).sort((a, b) => b.length - a.length)) {
    const pattern = new RegExp('\\b(FROM|JOIN)\\s+' + tableName + '\\b', 'gi');
    guard = guard.replace(pattern, (_, keyword) => keyword + ' ' + qualify(kind, tableName));
    body = body.replace(pattern, (_, keyword) => keyword + ' ' + qualify(kind, tableName));
  }
  const fn = objectName('trigger_' + name);
  return [
    {
      type: 'function',
      name: fn,
      table,
      sql: `CREATE FUNCTION ${qualify(kind, fn)}() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN
${guard ? 'IF ' + guard + ' THEN\n' + body + '\nEND IF;' : body}
IF TG_OP='DELETE' THEN RETURN OLD; END IF;
RETURN NEW;
END
$function$`,
    },
    {
      type: 'trigger',
      name: objectName(name),
      table,
      sql: `CREATE TRIGGER ${q(objectName(name))} ${timing} ${event} ON ${qualify(kind, table)} FOR EACH ROW EXECUTE FUNCTION ${qualify(kind, fn)}()`,
    },
  ];
}
function nativeSchemaPlan(kind, catalog) {
  namespace(kind);
  if (
    !catalog ||
    !Number.isSafeInteger(catalog.version) ||
    !catalog.tables ||
    !Array.isArray(catalog.objects)
  )
    throw Error('Invalid source schema catalog.');
  const tables = [],
    constraints = [],
    indexes = [],
    triggers = [];
  for (const table of Object.values(catalog.tables)) {
    const columns = [
      '_store_id TEXT COLLATE "C" NOT NULL DEFAULT current_setting(\'cartoteca.store_id\',true)',
    ];
    if (!table.integerPrimaryKey) columns.push('_rowid BIGINT GENERATED BY DEFAULT AS IDENTITY');
    for (const column of table.columns) {
      let definition = q(column.name) + ' ' + type(column);
      if (column.name === table.integerPrimaryKey)
        definition += ' GENERATED BY DEFAULT AS IDENTITY';
      else definition += defaultValue(column.dflt_value);
      if (column.notnull || column.pk) definition += ' NOT NULL';
      columns.push(definition);
    }
    if (table.primary.length)
      columns.push('PRIMARY KEY(_store_id,' + table.primary.map(q).join(',') + ')');
    const ordinal = table.integerPrimaryKey || '_rowid';
    if (!table.primary.includes(ordinal)) columns.push('UNIQUE(_store_id,' + q(ordinal) + ')');
    checks(table.sql).forEach((check) => columns.push('CHECK(' + checkExpression(check) + ')'));
    tables.push({
      type: 'table',
      name: table.name,
      table: table.name,
      sql: 'CREATE TABLE ' + qualify(kind, table.name) + '(\n' + columns.join(',\n') + ')',
    });
    const groups = new Map();
    for (const key of table.foreignKeys) {
      if (!groups.has(key.id)) groups.set(key.id, []);
      groups.get(key.id).push(key);
    }
    for (const [id, rows] of groups) {
      rows.sort((a, b) => a.seq - b.seq);
      const target = catalog.tables[rows[0].table];
      if (
        !target ||
        rows.some(
          (row) =>
            !row.to ||
            !['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'].includes(
              row.on_delete,
            ) ||
            !['NO ACTION', 'RESTRICT', 'CASCADE'].includes(row.on_update),
        )
      )
        throw Error('Unsupported canonical foreign key.');
      const name = objectName('fk_' + table.name + '_' + id);
      const onDelete =
        rows[0].on_delete === 'SET NULL'
          ? 'SET NULL (' + rows.map((row) => q(row.from)).join(',') + ')'
          : rows[0].on_delete;
      constraints.push({
        type: 'constraint',
        name,
        table: table.name,
        sql: `ALTER TABLE ${qualify(kind, table.name)} ADD CONSTRAINT ${q(name)} FOREIGN KEY(_store_id,${rows.map((row) => q(row.from)).join(',')}) REFERENCES ${qualify(kind, target.name)}(_store_id,${rows.map((row) => q(row.to)).join(',')}) ON UPDATE ${rows[0].on_update} ON DELETE ${onDelete} DEFERRABLE INITIALLY IMMEDIATE`,
      });
    }
    for (const index of table.indexes) {
      if (index.origin === 'pk') continue;
      const keys = index.columns.filter((column) => column.key);
      if (
        keys.some(
          (column) => !column.name || column.cid < 0 || !['BINARY', null].includes(column.coll),
        )
      )
        throw Error('Unsupported canonical expression/collation index: ' + index.name);
      const source = catalog.objects.find(
        (object) => object.type === 'index' && object.name === index.name,
      );
      const predicate = index.partial ? /\bWHERE\s+([\s\S]*)$/i.exec(source?.sql || '')?.[1] : '';
      if (index.partial && !predicate) throw Error('Missing canonical partial-index predicate.');
      indexes.push({
        type: 'index',
        name: objectName(index.name),
        table: table.name,
        sql: `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${q(objectName(index.name))} ON ${qualify(kind, table.name)}(_store_id,${keys.map((column) => q(column.name) + (column.desc ? ' DESC' : '')).join(',')})${predicate ? ' WHERE ' + expression(predicate) : ''}`,
      });
    }
    const policy =
      "_store_id=current_setting('cartoteca.store_id',true) AND current_setting('cartoteca.kind',true)='" +
      kind +
      "'";
    triggers.push({
      type: 'rls',
      name: 'store_scope',
      table: table.name,
      sql: `ALTER TABLE ${qualify(kind, table.name)} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${qualify(kind, table.name)} FORCE ROW LEVEL SECURITY; CREATE POLICY store_scope ON ${qualify(kind, table.name)} USING(${policy}) WITH CHECK(${policy})`,
    });
    triggers.push({
      type: 'trigger',
      name: 'native_store_revision',
      table: table.name,
      sql: `CREATE TRIGGER native_store_revision AFTER INSERT OR UPDATE OR DELETE ON ${qualify(kind, table.name)} FOR EACH ROW EXECUTE FUNCTION cartoteca_catalog.bump_store_revision('${kind}')`,
    });
  }
  for (const object of catalog.objects.filter((object) => object.type === 'trigger'))
    triggers.push(...nativeTrigger(kind, object, catalog));
  const objects = [...tables, ...indexes, ...constraints, ...triggers];
  return { kind, sourceHash: digest(catalog), objects, hash: digest(objects) };
}
module.exports = { nativeSchemaPlan, expression, qualify, balanced };
