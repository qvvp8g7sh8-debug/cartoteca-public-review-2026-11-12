const { identifier, literal, quote, word, render, unsupported } = require('./dialect-lexer.cjs');
const schemas = Object.freeze({
  platform: 'cartoteca_platform',
  cabinet: 'cartoteca_cabinet',
  budget: 'cartoteca_budget',
});
function assertScope(scope) {
  if (
    !scope ||
    !Object.hasOwn(schemas, scope.kind) ||
    typeof scope.storeId !== 'string' ||
    !scope.storeId ||
    scope.storeId.length > 256 ||
    /[\u0000-\u001f]/u.test(scope.storeId)
  )
    throw unsupported('Missing trusted PostgreSQL store scope');
  return scope;
}
function tableDefinition(catalog, name) {
  const value = catalog?.tables?.[name];
  if (
    !value ||
    !Array.isArray(value.columns) ||
    value.columns.some((c) => typeof c.name !== 'string') ||
    !Array.isArray(value.primary) ||
    !Array.isArray(value.unique)
  )
    throw unsupported('Table is not registered in this store catalog');
  return value;
}
function nativeTable(scope, name, catalog) {
  assertScope(scope);
  tableDefinition(catalog, name);
  return quote(schemas[scope.kind]) + '.' + quote(name);
}
function catalogSource(scope, values) {
  const kind = '$' + values.push(scope.kind),
    store = '$' + values.push(scope.storeId);
  return `(SELECT type,name,tbl_name,sql FROM cartoteca_catalog.objects WHERE kind=${kind} AND store_id=${store})`;
}
function pragmaOperation(tokens) {
  if (!word(tokens[0], 'PRAGMA')) return null;
  const name = identifier(tokens[1])?.toLowerCase();
  if (!name || tokens[2]?.value === '.') throw unsupported('Qualified PRAGMA is unsupported');
  let argument = null,
    setting = false;
  if (tokens.length > 2) {
    if (tokens[2].value === '=' && tokens.length === 4) {
      argument = tokens[3].value;
      setting = true;
    } else if (
      tokens[2].value === '(' &&
      tokens[4]?.value === ')' &&
      tokens.length === 5 &&
      ['word', 'identifier', 'string'].includes(tokens[3].type)
    )
      argument = tokens[3].value;
    else throw unsupported('Unsupported PRAGMA arguments');
  }
  return { name, argument, setting };
}
function compileCatalog(operation, scope, args = [], method = 'all', catalog) {
  assertScope(scope);
  if (!operation || args.length) throw unsupported('Invalid catalog request');
  const { name, argument, setting } = operation;
  if (setting)
    throw unsupported('SQLite settings require an explicit PostgreSQL runtime capability');
  const values = [scope.kind, scope.storeId],
    where = 'kind=$1 AND store_id=$2';
  const plan = (text) => ({ text, values, effect: 'read' });
  if (name === 'user_version')
    return plan(`SELECT version AS user_version FROM cartoteca_catalog.stores WHERE ${where}`);
  if (name === 'data_version')
    return plan(require('./revision-sql132.cjs').revisionSelect('data_version', scope));
  if (name === 'table_info' || name === 'table_xinfo') {
    tableDefinition(catalog, argument);
    values.push(argument);
    return plan(`SELECT cid,name,type,"notnull",dflt_value,pk${name === 'table_xinfo' ? ',0 AS hidden' : ''}
      FROM cartoteca_catalog.columns WHERE ${where} AND table_name=$3 ORDER BY cid`);
  }
  if (name === 'index_list') {
    tableDefinition(catalog, argument);
    values.push(argument);
    return plan(`SELECT seq,name,"unique",origin,partial FROM cartoteca_catalog.indexes
      WHERE ${where} AND table_name=$3 ORDER BY seq`);
  }
  if (name === 'index_xinfo' || name === 'index_info') {
    if (
      !Object.values(catalog?.tables || {}).some((t) => t.indexes?.some((i) => i.name === argument))
    )
      throw unsupported('Index is not registered in this store catalog');
    values.push(argument);
    return plan(`SELECT seqno,cid,name${name === 'index_xinfo' ? ',"desc",coll,"key"' : ''}
      FROM cartoteca_catalog.index_columns WHERE ${where} AND index_name=$3
      ${name === 'index_info' ? 'AND "key"=1' : ''} ORDER BY seqno`);
  }
  if (name === 'foreign_key_list') {
    tableDefinition(catalog, argument);
    values.push(argument);
    return plan(`SELECT f.id,f.seq,f."table",f."from",f."to",f.on_update,f.on_delete,f.match
      FROM cartoteca_catalog.stores s CROSS JOIN LATERAL jsonb_to_recordset(
        s.metadata->'tables'->$3->'foreignKeys')
        AS f(id integer,seq integer,"table" text,"from" text,"to" text,on_update text,on_delete text,match text)
      WHERE s.kind=$1 AND s.store_id=$2 ORDER BY f.id,f.seq`);
  }
  // In particular, integrity_check/quick_check, WAL mode and user_version writes
  // must never be represented by invented SQLite success rows.
  throw unsupported('Unsupported PostgreSQL catalog capability: ' + name);
}
module.exports = {
  schemas,
  assertScope,
  tableDefinition,
  nativeTable,
  catalogSource,
  pragmaOperation,
  compileCatalog,
};
