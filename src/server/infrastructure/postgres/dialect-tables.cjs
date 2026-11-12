const {
  lex,
  quote,
  word,
  symbol,
  identifier,
  render,
  raw,
  closing,
  unsupported,
} = require('./dialect-lexer.cjs');
const { schemas, tableDefinition, nativeTable, catalogSource } = require('./dialect-catalog.cjs');
const { nativePlan } = require('./dialect-expressions.cjs');
const ending = new Set([
  'WHERE',
  'GROUP',
  'ORDER',
  'LIMIT',
  'OFFSET',
  'UNION',
  'EXCEPT',
  'INTERSECT',
  'RETURNING',
  'HAVING',
  'SET',
  'VALUES',
]);
const notAlias = new Set([
  ...ending,
  'ON',
  'JOIN',
  'INNER',
  'LEFT',
  'RIGHT',
  'FULL',
  'OUTER',
  'CROSS',
  'AS',
  'DO',
  'SELECT',
  'FROM',
  'INDEXED',
  'NOT',
]);
function withNames(tokens) {
  const names = new Set();
  if (!word(tokens[0], 'WITH')) return names;
  if (word(tokens[1], 'RECURSIVE'))
    throw unsupported('Recursive SQL requires an explicit registered query');
  let i = 1;
  for (;;) {
    const name = identifier(tokens[i++]);
    if (!name) throw unsupported('Invalid CTE name');
    names.add(name.toLowerCase());
    if (symbol(tokens[i], '(')) i = closing(tokens, i) + 1;
    if (!word(tokens[i++], 'AS') || !symbol(tokens[i], '('))
      throw unsupported('Unsupported CTE declaration');
    i = closing(tokens, i) + 1;
    if (!symbol(tokens[i], ',')) break;
    i++;
  }
  return names;
}
function references(input, scope, catalog, values) {
  const tokens = input.map((token) => ({ ...token })),
    ctes = withNames(tokens),
    from = new Set();
  const tables = [],
    aliases = new Map();
  // SQLite accepts CROSS JOIN ... ON; PostgreSQL reserves CROSS for a Cartesian
  // join. An ON-qualified inner join returns the exact same rows and nulls.
  for (let i = 0; i < tokens.length; i++) {
    if (!word(tokens[i], 'CROSS') || !word(tokens[i + 1], 'JOIN')) continue;
    let nesting = 0;
    for (let at = i + 2; at < tokens.length; at++) {
      if (symbol(tokens[at], '(')) nesting++;
      else if (symbol(tokens[at], ')')) {
        if (!nesting) break;
        nesting--;
      } else if (!nesting && word(tokens[at], 'ON')) {
        tokens[i].raw = 'INNER';
        break;
      } else if (
        !nesting &&
        (word(tokens[at], 'JOIN') || ending.has(tokens[at].value?.toUpperCase()))
      )
        break;
    }
  }
  let depth = 0,
    expect = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (symbol(token, '(')) {
      depth++;
      expect = false;
      continue;
    }
    if (symbol(token, ')')) {
      from.delete(depth);
      depth--;
      expect = false;
      continue;
    }
    if (token.type === 'word' && ending.has(token.value.toUpperCase())) from.delete(depth);
    if (
      word(token, 'FROM') ||
      word(token, 'JOIN') ||
      word(token, 'INTO') ||
      (word(token, 'UPDATE') && !word(tokens[i - 1], 'DO'))
    ) {
      if (word(token, 'FROM') || word(token, 'JOIN')) from.add(depth);
      expect = true;
      continue;
    }
    if (symbol(token, ',') && from.has(depth)) {
      expect = true;
      continue;
    }
    if (!expect) continue;
    expect = false;
    const name = identifier(token)?.toLowerCase();
    if (!name || symbol(tokens[i + 1], '.'))
      throw unsupported('Qualified or missing logical table');
    if (symbol(tokens[i + 1], '(') && name === 'json_each') continue;
    if (ctes.has(name)) continue;
    if (['sqlite_master', 'sqlite_schema'].includes(name)) {
      token.raw = catalogSource(scope, values);
      if (
        !word(tokens[i + 1], 'AS') &&
        !(identifier(tokens[i + 1]) && !notAlias.has(tokens[i + 1].value.toUpperCase()))
      )
        token.raw += ' AS ' + quote(name);
      continue;
    }
    const definition = tableDefinition(catalog, name);
    token.raw = nativeTable(scope, name, catalog);
    tables.push({ name, definition });
    aliases.set(name, definition);
    const offset = word(tokens[i + 1], 'AS') ? 2 : 1,
      alias = identifier(tokens[i + offset]);
    const hasAlias = alias && !notAlias.has(alias.toUpperCase());
    if (hasAlias) aliases.set(alias.toLowerCase(), definition);
    const after = i + (hasAlias ? offset + 1 : 1);
    if (word(tokens[after], 'INDEXED') && word(tokens[after + 1], 'BY')) {
      const index = identifier(tokens[after + 2]);
      if (
        !index ||
        !definition.indexes?.some((entry) => entry.name === index) ||
        !catalog.objects?.some(
          (object) => object.type === 'index' && object.name === index && object.tbl_name === name,
        )
      )
        throw unsupported('Forced source index is not registered on the selected table');
      // The store is opened only after native index/constraint attestation. PG
      // chooses its own plan over that real index; it has no INDEXED BY grammar.
      tokens.splice(after, 3);
    }
  }
  const selected = new Set();
  for (let i = 0; i < tokens.length; i++) {
    if (identifier(tokens[i])?.toLowerCase() !== 'rowid') continue;
    const definition = symbol(tokens[i - 1], '.')
      ? aliases.get(identifier(tokens[i - 2])?.toLowerCase())
      : tables.length === 1
        ? tables[0].definition
        : null;
    if (!definition?.rowid && !definition?.integerPrimaryKey)
      throw unsupported('Unresolved SQLite rowid');
    tokens[i].raw = quote(definition.integerPrimaryKey || '_rowid');
    // The implicit expression label of SELECT rowid must remain rowid.
    const next = tokens[i + 1];
    if (
      (symbol(next, ',') || word(next, 'FROM') || !next) &&
      tokens.slice(0, i).some((t) => word(t, 'SELECT')) &&
      !tokens.slice(0, i).some((t) => word(t, 'ORDER'))
    ) {
      tokens[i].raw += ' AS rowid';
      selected.add('rowid');
    }
  }
  return { tokens, tables, columns: [...selected] };
}
function normalizedDDL(sql) {
  const tokens = lex(sql);
  for (let i = 0; i < tokens.length - 2; i++)
    if (word(tokens[i], 'IF') && word(tokens[i + 1], 'NOT') && word(tokens[i + 2], 'EXISTS'))
      tokens.splice(i, 3);
  return tokens
    .filter((t) => !symbol(t, ';'))
    .map((t) => (['word', 'identifier'].includes(t.type) ? t.value.toUpperCase() : t.raw))
    .join(' ');
}
function knownCreate(tokens, scope, catalog) {
  if (!word(tokens[0], 'CREATE')) return null;
  let at = 1;
  if (word(tokens[at], 'UNIQUE')) at++;
  const type = word(tokens[at], 'TABLE') ? 'table' : word(tokens[at], 'INDEX') ? 'index' : null;
  if (
    !type ||
    !word(tokens[at + 1], 'IF') ||
    !word(tokens[at + 2], 'NOT') ||
    !word(tokens[at + 3], 'EXISTS')
  )
    throw unsupported('DDL requires explicit PostgreSQL schema preparation');
  const name = identifier(tokens[at + 4]);
  const object = catalog?.objects?.find((o) => o.type === type && o.name === name);
  if (!object?.sql || normalizedDDL(object.sql) !== normalizedDDL(render(tokens)))
    throw unsupported('Idempotent DDL differs from registered canonical schema');
  const text = `SELECT 1 / CASE WHEN EXISTS(SELECT 1 FROM cartoteca_catalog.objects o
    JOIN pg_catalog.pg_namespace n ON n.nspname=$3
    JOIN pg_catalog.pg_class c ON c.relnamespace=n.oid AND c.relname=o.name
    WHERE o.kind=$1 AND o.store_id=$2 AND o.type=$4 AND o.name=$5
      AND c.relkind IN (${type === 'table' ? "'r','p'" : "'i','I'"})) THEN 1 ELSE 0 END AS validated`;
  return {
    text,
    values: [scope.kind, scope.storeId, schemas[scope.kind], type, name],
    effect: 'read',
  };
}
module.exports = { references, withNames, knownCreate, normalizedDDL };
