const {
  quote,
  word,
  symbol,
  identifier,
  render,
  raw,
  split,
  closing,
  unsupported,
} = require('./dialect-lexer.cjs');
const { tableDefinition, nativeTable } = require('./dialect-catalog.cjs');
const { nativePlan } = require('./dialect-expressions.cjs');
function insertInfo(tokens, catalog) {
  if (!word(tokens[0], 'INSERT')) return null;
  let position = 1,
    conflict = '';
  if (word(tokens[position], 'OR')) {
    conflict = tokens[position + 1]?.value?.toUpperCase();
    position += 2;
  }
  if (conflict && !['REPLACE', 'IGNORE'].includes(conflict))
    throw unsupported('Unsupported INSERT conflict policy');
  if (!word(tokens[position++], 'INTO')) throw unsupported('INSERT requires a registered target');
  const at = position,
    table = identifier(tokens[position++])?.toLowerCase();
  const definition = tableDefinition(catalog, table);
  let columns;
  if (symbol(tokens[position], '(')) {
    const end = closing(tokens, position);
    columns = split(tokens.slice(position + 1, end), ',').map((part) =>
      part.length === 1 ? identifier(part[0]) : null,
    );
    if (columns.some((name) => !name || !definition.columns.some((c) => c.name === name)))
      throw unsupported('INSERT column is outside the registered logical table');
    position = end + 1;
  } else {
    columns = definition.columns.map((c) => c.name);
    tokens.splice(position, 0, raw('(' + columns.map(quote).join(',') + ')'));
    position++;
  }
  if (new Set(columns).size !== columns.length) throw unsupported('Duplicate INSERT columns');
  if (conflict) tokens.splice(1, 2);
  return {
    table,
    definition,
    columns,
    position: position - (conflict ? 2 : 0),
    conflict,
    at: at - (conflict ? 2 : 0),
  };
}
function upsert(tokens, info) {
  const conflict = tokens.findIndex((t, i) => word(t, 'ON') && word(tokens[i + 1], 'CONFLICT'));
  if (info.conflict === 'IGNORE') {
    if (conflict >= 0) throw unsupported('Two INSERT conflict policies');
    tokens.push(raw('ON CONFLICT DO NOTHING'));
    return;
  }
  if (conflict < 0) return;
  if (symbol(tokens[conflict + 2], '(')) {
    const end = closing(tokens, conflict + 2),
      keys = split(tokens.slice(conflict + 3, end), ',').map((part) =>
        part.length === 1 ? identifier(part[0]) : null,
      );
    if (
      keys.some((k) => !k) ||
      ![info.definition.primary, ...info.definition.unique].some(
        (key) => key.length === keys.length && key.every((k, i) => k === keys[i]),
      )
    )
      throw unsupported('Conflict target is not a registered unique key');
    tokens.splice(conflict + 3, 0, raw('"_store_id",'));
  }
  const set = tokens.findIndex((t, i) => i > conflict && word(t, 'SET'));
  if (set < 0) return;
  const columns = new Set(info.definition.columns.map((c) => c.name));
  let lhs = true,
    depth = 0;
  for (let i = set + 1; i < tokens.length; i++) {
    if (symbol(tokens[i], '(')) depth++;
    if (symbol(tokens[i], ')')) depth--;
    if (!depth && symbol(tokens[i], ',')) {
      lhs = true;
      continue;
    }
    if (!depth && symbol(tokens[i], '=')) {
      lhs = false;
      continue;
    }
    if (word(tokens[i], 'WHERE')) {
      lhs = false;
      continue;
    }
    if (lhs) continue;
    const name = identifier(tokens[i]);
    if (
      columns.has(name) &&
      !symbol(tokens[i - 1], '.') &&
      !symbol(tokens[i + 1], '.') &&
      !symbol(tokens[i + 1], '(')
    )
      tokens[i].raw = quote(info.table) + '.' + quote(name);
  }
}
function returning(tokens, info, method) {
  if (!info || method !== 'run' || tokens.some((t) => word(t, 'RETURNING'))) return null;
  const column = info.definition.integerPrimaryKey || (info.definition.rowid ? '_rowid' : null);
  if (!column) return null;
  tokens.push(raw('RETURNING ' + quote(column)));
  return column;
}
function replacement(tokens, info, scope, values, method, translate) {
  if (info.conflict !== 'REPLACE') return null;
  if (!word(tokens[info.position], 'VALUES') || !symbol(tokens[info.position + 1], '('))
    throw unsupported('REPLACE requires one registered VALUES row');
  const end = closing(tokens, info.position + 1);
  if (tokens[end + 1]) throw unsupported('REPLACE requires one registered VALUES row');
  const entries = split(tokens.slice(info.position + 2, end), ',');
  if (entries.length !== info.columns.length) throw unsupported('REPLACE column/value mismatch');
  const expression = new Map(info.columns.map((name, i) => [name, entries[i]]));
  // Never turn REPLACE into UPDATE: delete cascades, fresh insertion order and
  // omitted-column defaults belong to the established SQLite contract.
  const clauses = [];
  for (const keys of [info.definition.primary, ...info.definition.unique]) {
    if (!keys.length || keys.some((name) => !expression.has(name))) continue;
    clauses.push(
      '(' +
        keys.map((name) => quote(name) + '=(' + render(expression.get(name)) + ')').join(' AND ') +
        ')',
    );
  }
  if (!clauses.length) throw unsupported('REPLACE has no complete registered conflict key');
  const remove = translate(
    `DELETE FROM ${nativeTable(scope, info.table, { tables: { [info.table]: info.definition } })} WHERE ${clauses.join(' OR ')}`,
  );
  const id = returning(tokens, info, method);
  return {
    effect: 'write',
    atomic: true,
    returningId: id,
    steps: [
      nativePlan(remove, values, 'write'),
      nativePlan(render(tokens), values, 'write', { returningId: id }),
    ],
  };
}
module.exports = { insertInfo, upsert, returning, replacement };
