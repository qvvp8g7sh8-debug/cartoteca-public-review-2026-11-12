const {
  lex,
  word,
  symbol,
  identifier,
  render,
  split,
  quote,
  unsupported,
} = require('./dialect-lexer.cjs');
const { assertScope, pragmaOperation, compileCatalog } = require('./dialect-catalog.cjs');
const { bind, nativePlan, expressions, parameterIndexes } = require('./dialect-expressions.cjs');
const { references, knownCreate, withNames } = require('./dialect-tables.cjs');
const { insertInfo, upsert, returning, replacement } = require('./dialect-writes.cjs');
function splitStatements(sql) {
  const tokens = lex(sql);
  // SQLite trigger bodies have their own BEGIN/END grammar. Runtime creation of
  // triggers belongs to the explicit PostgreSQL schema installer, never exec.
  if (tokens.some((token, i) => word(token, 'CREATE') && word(tokens[i + 1], 'TRIGGER')))
    throw unsupported('Trigger DDL requires explicit PostgreSQL schema preparation');
  return split(tokens).map(render);
}
function command(tokens) {
  let depth = 0;
  for (const token of tokens) {
    if (symbol(token, '(')) depth++;
    else if (symbol(token, ')')) depth--;
    else if (
      !depth &&
      token.type === 'word' &&
      ['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(token.value.toUpperCase())
    )
      return token.value.toUpperCase();
  }
  return null;
}
function assertFunctions(tokens, catalog) {
  const allowed = new Set([
    'COUNT',
    'SUM',
    'AVG',
    'MIN',
    'MAX',
    'COALESCE',
    'NULLIF',
    'SUBSTR',
    'SUBSTRING',
    'LENGTH',
    'INSTR',
    'LOWER',
    'UPPER',
    'TRIM',
    'LTRIM',
    'RTRIM',
    'ABS',
    'ROUND',
    'CAST',
    'JSON_EACH',
    'JSON_EXTRACT',
    'JSON_VALID',
    'TYPEOF',
  ]);
  // An opening expression/subquery after a SQL keyword is not a function call.
  // Keep this list separate from the closed scalar-function allowlist.
  const syntax = new Set([
    'IN',
    'EXISTS',
    'VALUES',
    'AS',
    'NOT',
    'CONFLICT',
    'SELECT',
    'DISTINCT',
    'FROM',
    'JOIN',
    'ON',
    'WHERE',
    'AND',
    'OR',
    'WHEN',
    'THEN',
    'ELSE',
    'HAVING',
    'BY',
    'SET',
    'RETURNING',
    'UNION',
    'ALL',
  ]);
  const ctes = withNames(tokens);
  for (let i = 0; i < tokens.length; i++) {
    const name = identifier(tokens[i]);
    if (!name || !symbol(tokens[i + 1], '(')) continue;
    if (symbol(tokens[i - 1], '.'))
      throw unsupported('Caller-qualified SQL functions are outside the closed logical dialect');
    if (
      syntax.has(name.toUpperCase()) ||
      allowed.has(name.toUpperCase()) ||
      ctes.has(name.toLowerCase()) ||
      catalog?.tables?.[name]
    )
      continue;
    throw unsupported('SQL function is outside the PostgreSQL compatibility contract');
  }
}
function compileUncached(sql, scope, args = [], method = 'all', catalog) {
  assertScope(scope);
  if (!['all', 'get', 'run', 'iterate', 'exec'].includes(method))
    throw unsupported('Unknown SQL result method');
  const statements = splitStatements(sql);
  if (!statements.length) throw unsupported('Empty SQL');
  if (statements.length > 1) {
    if (args.length) throw unsupported('Bound multi-statement SQL is not supported');
    return {
      steps: statements.map((statement) => compileUncached(statement, scope, [], method, catalog)),
      effect: 'control',
    };
  }
  const tokens = lex(statements[0]),
    first = tokens[0]?.value?.toUpperCase();
  if (['BEGIN', 'COMMIT', 'ROLLBACK', 'END'].includes(first)) {
    if (
      args.length ||
      tokens.length > (first === 'BEGIN' ? 2 : 1) ||
      (tokens[1] &&
        ![
          'IMMEDIATE',
          'DEFERRED',
          'SHARED',
          'QUEUE',
          'READONLY',
          'EXCLUSIVE',
          'TRANSACTION',
        ].includes(tokens[1].value.toUpperCase()))
    )
      throw unsupported('Unsupported transaction control');
    return {
      control:
        first === 'END' ? 'COMMIT' : first + (tokens[1] ? ' ' + tokens[1].value.toUpperCase() : ''),
      effect: 'control',
    };
  }
  const pragma = pragmaOperation(tokens);
  if (pragma) return compileCatalog(pragma, scope, args, method, catalog);
  const create = knownCreate(tokens, scope, catalog);
  if (create) {
    if (args.length) throw unsupported('Bound DDL is unsupported');
    return create;
  }
  if (
    word(tokens[0], 'SELECT') &&
    word(tokens[1], 'TOTAL_CHANGES') &&
    symbol(tokens[2], '(') &&
    symbol(tokens[3], ')')
  ) {
    if (
      args.length ||
      tokens.length > 6 ||
      (tokens.length === 6 && !word(tokens[4], 'AS')) ||
      (tokens.length > 4 && !identifier(tokens[word(tokens[4], 'AS') ? 5 : 4]))
    )
      throw unsupported('Unsupported local change-counter query');
    const alias = identifier(tokens[word(tokens[4], 'AS') ? 5 : 4]) || 'total_changes()';
    return {
      text: require('./revision-sql132.cjs').revisionSelect(quote(alias), scope),
      values: [scope.kind, scope.storeId],
      effect: 'read',
    };
  }
  const operation = command(tokens);
  if (!operation)
    throw unsupported('SQL operation is outside the PostgreSQL compatibility contract');
  if (tokens.some((t) => identifier(t)?.startsWith('_store_') || identifier(t) === '_rowid'))
    throw unsupported('Logical SQL cannot override hidden store identity');
  if (first === 'WITH' && operation !== 'SELECT')
    throw unsupported('Write CTE requires an explicitly registered command');
  assertFunctions(tokens, catalog);
  bind(tokens, args);
  const values = [...args],
    info = insertInfo(tokens, catalog);
  if (info) upsert(tokens, info);
  const mapped = references(tokens, scope, catalog, values);
  const expressionContext = { args: values, catalog, tables: mapped.tables };
  const translated = expressions(mapped.tokens, expressionContext);
  if (info?.conflict === 'REPLACE')
    return replacement(translated, info, scope, values, method, (text) =>
      render(expressions(lex(text), expressionContext)),
    );
  const id = returning(translated, info, method);
  return nativePlan(render(translated), values, operation === 'SELECT' ? 'read' : 'write', {
    ...(id ? { returningId: id } : {}),
    ...(mapped.columns.length ? { columns: mapped.columns } : {}),
  });
}
// Share only immutable SQL structure across cold tenant handles. The catalog
// has already been attested on open; this cache never substitutes that check.
const templates = new Map();
const catalogIds = new WeakMap();
const frozenCatalogs = new WeakSet();
const maximumTemplateBytes = 256 * 1024;
const maximumTemplates = 128;
let templateBytes = 0,
  nextCatalogId = 0,
  templateHits = 0,
  templateMisses = 0;
function deeplyFrozen(value, active = new WeakSet()) {
  if (!value || typeof value !== 'object') return typeof value !== 'function';
  if (!Object.isFrozen(value) || active.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  active.add(value);
  const valid = Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => Object.hasOwn(descriptor, 'value') && deeplyFrozen(descriptor.value, active),
  );
  active.delete(value);
  return valid;
}
function catalogId(catalog) {
  if (!catalog || typeof catalog !== 'object') return null;
  if (!frozenCatalogs.has(catalog)) {
    if (!deeplyFrozen(catalog)) return null;
    frozenCatalogs.add(catalog);
  }
  if (!catalogIds.has(catalog)) catalogIds.set(catalog, ++nextCatalogId);
  return catalogIds.get(catalog);
}
function argumentClass(value) {
  return value == null
    ? 'n'
    : typeof value === 'bigint' || (typeof value === 'number' && Number.isInteger(value))
      ? 'i'
      : typeof value === 'number'
        ? 'r'
        : Buffer.isBuffer(value)
          ? 'b'
          : 't';
}
function structuralTemplate(plan, argumentCount, scope) {
  const { values, steps, ...fields } = plan;
  const shape = { ...fields };
  if (shape.columns) shape.columns = Object.freeze([...shape.columns]);
  Object.freeze(shape);
  if (steps) {
    const children = steps.map((step) => structuralTemplate(step, argumentCount, scope));
    return children.every(Boolean) ? { shape, steps: children } : null;
  }
  const indexes = parameterIndexes(plan);
  if (!indexes || !Array.isArray(values) || indexes.length !== values.length) return null;
  const bindings = [];
  for (let position = 0; position < indexes.length; position++) {
    const index = indexes[position];
    if (index < argumentCount) bindings.push(index);
    else {
      // The logical compiler appends only (kind,storeId) pairs for catalog
      // sources. Record their origin, never a previous tenant's store value.
      const kind = (index - argumentCount) % 2 === 0;
      if (values[position] !== (kind ? scope.kind : scope.storeId)) return null;
      bindings.push(kind ? 'kind' : 'store');
    }
  }
  return { shape, bindings };
}
function rebind(template, args, scope) {
  const plan = { ...template.shape };
  if (plan.columns) plan.columns = [...plan.columns];
  if (template.steps) plan.steps = template.steps.map((step) => rebind(step, args, scope));
  else
    plan.values = template.bindings.map((binding) =>
      binding === 'kind' ? scope.kind : binding === 'store' ? scope.storeId : args[binding],
    );
  return plan;
}
function compile(sql, scope, args = [], method = 'all', catalog) {
  assertScope(scope);
  // Keep unsupported controls/catalog operations and mutable custom catalogs
  // on the established compiler path. No cached SQL can grant an intent.
  const identity = catalogId(catalog);
  if (identity === null || !Array.isArray(args) || typeof sql !== 'string')
    return compileUncached(sql, scope, args, method, catalog);
  const signature = Array.from(args, argumentClass).join('');
  const key = JSON.stringify([
    identity,
    scope.kind,
    scope.revisionProfile || 1,
    method,
    signature,
    sql,
  ]);
  const previous = templates.get(key);
  if (previous) {
    templateHits++;
    templates.delete(key);
    templates.set(key, previous);
    return rebind(previous.template, args, scope);
  }
  templateMisses++;
  const plan = compileUncached(sql, scope, args, method, catalog);
  const template = structuralTemplate(plan, args.length, scope);
  if (template) {
    const bytes = 2 * (key.length + JSON.stringify(template).length);
    if (bytes <= maximumTemplateBytes) {
      while (templates.size >= maximumTemplates || templateBytes + bytes > maximumTemplateBytes) {
        const oldest = templates.keys().next().value;
        templateBytes -= templates.get(oldest).bytes;
        templates.delete(oldest);
      }
      templates.set(key, { template, bytes });
      templateBytes += bytes;
    }
  }
  return plan;
}
function compileCacheStats() {
  return {
    hits: templateHits,
    misses: templateMisses,
    entries: templates.size,
    bytes: templateBytes,
    maximumBytes: maximumTemplateBytes,
    maximumEntries: maximumTemplates,
  };
}
module.exports = { compile, compileUncached, compileCacheStats, compileCatalog, splitStatements };
