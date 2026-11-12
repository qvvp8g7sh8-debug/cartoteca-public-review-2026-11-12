const {
  lex,
  identifier,
  word,
  symbol,
  render,
  raw,
  split,
  closing,
  quote,
  unsupported,
} = require('./dialect-lexer.cjs');
function bind(tokens, args) {
  if (!Array.isArray(args)) throw unsupported('Only positional SQL values are supported');
  let next = 0;
  for (const token of tokens) {
    if (token.type === 'bound') throw unsupported('Native placeholders are not SQLite input');
    if (token.type !== 'parameter') continue;
    const index = token.value ? Number(token.value) : next + 1;
    if (!Number.isSafeInteger(index) || index < 1 || index > args.length)
      throw unsupported('SQL parameter count mismatch');
    next = Math.max(next, index);
    token.type = 'bound';
    token.value = index;
    token.raw = '$' + index;
  }
  if (next !== args.length) throw unsupported('SQL parameter count mismatch');
  return tokens;
}
const planParameterIndexes = new WeakMap();
function nativePlan(text, args, effect, extra = {}) {
  const tokens = lex(text),
    values = [],
    indexes = new Map();
  for (const token of tokens) {
    if (token.type !== 'bound') continue;
    const index = token.value;
    if (index < 1 || index > args.length) throw unsupported('SQL parameter reference mismatch');
    if (!indexes.has(index)) {
      values.push(args[index - 1]);
      indexes.set(index, values.length);
    }
    token.raw = '$' + indexes.get(index);
  }
  const plan = { text: render(tokens), values, effect, ...extra };
  planParameterIndexes.set(
    plan,
    [...indexes.keys()].map((index) => index - 1),
  );
  return plan;
}
function leftAtom(tokens, end) {
  if (end < 0) throw unsupported('Missing SQL operand');
  let start = end;
  if (symbol(tokens[end], ')')) {
    let depth = 1;
    start--;
    while (start >= 0) {
      if (symbol(tokens[start], ')')) depth++;
      if (symbol(tokens[start], '(') && --depth === 0) break;
      start--;
    }
    if (start < 0) throw unsupported('Unbalanced SQL operand');
    if (
      identifier(tokens[start - 1]) &&
      !['AND', 'OR', 'WHERE', 'NOT', 'ON', 'WHEN', 'THEN', 'ELSE', 'SELECT', 'FROM'].includes(
        tokens[start - 1].value.toUpperCase(),
      )
    )
      start--;
  }
  while (symbol(tokens[start - 1], '.') && identifier(tokens[start - 2])) start -= 2;
  return start;
}
function rightAtom(tokens, start) {
  if (!tokens[start]) throw unsupported('Missing SQL operand');
  let end = start;
  if (symbol(tokens[start], '(')) return closing(tokens, start);
  while (symbol(tokens[end + 1], '.') && identifier(tokens[end + 2])) end += 2;
  if (symbol(tokens[end + 1], '(')) end = closing(tokens, end + 1);
  return end;
}
function scalarType(parts, context) {
  const types = new Set();
  const columns = new Map();
  const sourceTables = context.tables?.length
    ? context.tables.map((entry) => entry.definition)
    : Object.values(context.catalog?.tables || {});
  for (const table of sourceTables)
    for (const column of table.columns) {
      const type = /INT/i.test(column.type)
        ? 'bigint'
        : /REAL|FLOA|DOUB|NUMERIC/i.test(column.type)
          ? 'double precision'
          : /BLOB/i.test(column.type)
            ? 'bytea'
            : 'text';
      if (!columns.has(column.name)) columns.set(column.name, type);
      else if (columns.get(column.name) !== type) columns.set(column.name, null);
    }
  for (const tokens of parts)
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.type === 'number')
        types.add(Number.isInteger(Number(token.value)) ? 'bigint' : 'double precision');
      else if (token.type === 'string') types.add('text');
      else if (token.type === 'bound') {
        const value = context.args?.[token.value - 1];
        if (value == null) continue;
        types.add(
          typeof value === 'bigint' || (typeof value === 'number' && Number.isInteger(value))
            ? 'bigint'
            : typeof value === 'number'
              ? 'double precision'
              : Buffer.isBuffer(value)
                ? 'bytea'
                : 'text',
        );
      } else if (
        identifier(token) &&
        !symbol(tokens[i + 1], '.') &&
        !symbol(tokens[i + 1], '(') &&
        columns.has(token.value)
      ) {
        const type = columns.get(token.value);
        if (!type) throw unsupported('Ambiguous scalar column type');
        types.add(type);
      }
    }
  if (types.has('double precision')) types.delete('bigint');
  if (types.size > 1)
    throw unsupported('Mixed SQLite scalar storage classes require an explicit query contract');
  return [...types][0] || 'text';
}
function expressions(input, context = {}) {
  const tokens = input.map((token) => ({ ...token }));
  const functions = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (
      word(token, 'WHERE') &&
      tokens[i + 1]?.type === 'number' &&
      ['0', '1'].includes(tokens[i + 1].value) &&
      (!tokens[i + 2] ||
        symbol(tokens[i + 2], ')') ||
        ['ON', 'GROUP', 'ORDER', 'LIMIT', 'UNION', 'RETURNING'].some((keyword) =>
          word(tokens[i + 2], keyword),
        ))
    )
      tokens[i + 1] = raw(tokens[i + 1].value === '1' ? 'TRUE' : 'FALSE');
    if (symbol(token, '(')) functions.push(identifier(tokens[i - 1])?.toUpperCase() || '');
    else if (symbol(token, ')')) functions.pop();
    if (word(token, 'AS') && identifier(tokens[i + 1]) && functions.at(-1) !== 'CAST')
      tokens[i + 1].raw = quote(tokens[i + 1].value);
    if (token.raw === '==') token.raw = '=';
    if (word(token, 'COLLATE')) {
      if (!word(tokens[i + 1], 'BINARY')) throw unsupported('Unsupported SQLite collation');
      tokens[i + 1] = raw('"C"');
    }
    if (
      word(token, 'IS') &&
      !word(tokens[i + 1], 'NULL') &&
      !word(tokens[i + 1], 'TRUE') &&
      !word(tokens[i + 1], 'FALSE')
    ) {
      const not = word(tokens[i + 1], 'NOT');
      if (not && word(tokens[i + 2], 'NULL')) continue;
      tokens.splice(i, not ? 2 : 1, raw(not ? 'IS DISTINCT FROM' : 'IS NOT DISTINCT FROM'));
      continue;
    }
    if (!identifier(token) || !symbol(tokens[i + 1], '(')) continue;
    const name = token.value.toLowerCase();
    if (['lower', 'upper'].includes(name)) {
      token.raw = 'cartoteca_catalog.ascii_' + name;
      continue;
    }
    if (['json_each', 'json_extract', 'json_valid'].includes(name)) {
      token.raw = 'cartoteca_catalog.' + name;
      continue;
    }
    if (name === 'typeof') {
      token.raw = 'cartoteca_catalog.sqlite_typeof';
      continue;
    }
    if (name === 'instr') {
      token.raw = 'pg_catalog.strpos';
      continue;
    }
    if (name === 'cast') {
      const end = closing(tokens, i + 1);
      let depth = 0,
        as = -1;
      for (let at = i + 2; at < end; at++) {
        if (symbol(tokens[at], '(')) depth++;
        else if (symbol(tokens[at], ')')) depth--;
        else if (!depth && word(tokens[at], 'AS')) as = at;
      }
      if (as > i + 2 && as === end - 2 && word(tokens[as + 1], 'BLOB')) {
        const source = tokens.slice(i + 2, as),
          type = scalarType([source], context);
        if (!['text', 'bytea'].includes(type))
          throw unsupported('Numeric-to-BLOB casts require an explicit storage contract');
        const value = render(expressions(source, context));
        // A native text::bytea cast parses escape sequences; SQLite copies UTF-8.
        tokens.splice(
          i,
          end - i + 1,
          raw(
            type === 'bytea' ? '(' + value + ')' : `pg_catalog.convert_to((${value})::text,'UTF8')`,
          ),
        );
      }
      continue;
    }
    if (['randomblob', 'last_insert_rowid', 'changes'].includes(name))
      throw unsupported('Unsupported SQLite scalar function: ' + name);
    if (!['min', 'max'].includes(name)) continue;
    const end = closing(tokens, i + 1),
      args = split(tokens.slice(i + 2, end), ',');
    if (args.length < 2) continue; // Aggregate MIN/MAX retain their native meaning.
    const type = scalarType(args, context);
    const values = args.map((part) => '(' + render(expressions(part, context)) + ')::' + type);
    tokens.splice(
      i,
      end - i + 1,
      raw(`(CASE WHEN ${values.map((v) => `(${v}) IS NULL`).join(' OR ')}
      THEN NULL ELSE ${name === 'min' ? 'LEAST' : 'GREATEST'}(${values.join(',')}) END)`),
    );
  }
  // WHERE expressions only use atomic GLOB/LIKE operands in the registered SQL.
  // Parse operands rather than replacing text inside literals or adding WHEREs.
  for (let i = 0; i < tokens.length; i++) {
    if (!word(tokens[i], 'GLOB') && !word(tokens[i], 'LIKE')) continue;
    const name = tokens[i].value.toLowerCase(),
      not = word(tokens[i - 1], 'NOT');
    const left = leftAtom(tokens, i - (not ? 2 : 1)),
      right = rightAtom(tokens, i + 1);
    if (word(tokens[right + 1], 'ESCAPE'))
      throw unsupported('Explicit LIKE ESCAPE requires a registered query');
    const lhs = render(tokens.slice(left, i - (not ? 1 : 0))),
      rhs = render(tokens.slice(i + 1, right + 1));
    tokens.splice(
      left,
      right - left + 1,
      raw(`(${not ? 'NOT ' : ''}cartoteca_catalog.${name}_match(${lhs},${rhs}))`),
    );
    i = left;
  }
  return tokens;
}
const parameterIndexes = (plan) => planParameterIndexes.get(plan)?.slice();
module.exports = { parameterIndexes, bind, nativePlan, expressions, leftAtom, rightAtom };
