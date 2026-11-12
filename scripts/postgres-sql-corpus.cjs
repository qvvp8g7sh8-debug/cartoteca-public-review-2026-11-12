const fs = require('node:fs');
const path = require('node:path');
const { sourceModel, nodes } = require('./postgres-sql-source.cjs');

function collectRuntimeSQL(root) {
  const statements = [],
    unresolved = [],
    excluded = [];
  function directory(relative) {
    const absolute = path.join(root, relative);
    for (const item of fs.readdirSync(absolute, { withFileTypes: true })) {
      const file = relative + '/' + item.name;
      if (item.isDirectory()) {
        if (!['postgres', 'backup', 'migrations'].includes(item.name)) directory(file);
        continue;
      }
      if (!item.isFile() || !item.name.endsWith('.cjs')) continue;
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      const model = sourceModel(source);
      nodes(model.tree, (node) => {
        if (node.type !== 'CallExpression') return;
        const member = node.callee.type === 'MemberExpression';
        const name = member ? node.callee.property.name : node.callee.name;
        if (!['prepare', 'sql', 'exec', 'createBatchQuery'].includes(name)) return;
        if (
          member &&
          name === 'prepare' &&
          node.callee.object.type === 'Identifier' &&
          node.callee.object.name === 'preparedWrites'
        )
          return;
        const expression = node.arguments[name === 'createBatchQuery' ? 1 : 0];
        if (!expression) return;
        // RegExp.exec has the same method spelling and is not a database port.
        if (
          name === 'exec' &&
          (!member ||
            !/\b(db|budget|gate)$/.test(
              source.slice(node.callee.object.start, node.callee.object.end),
            ))
        )
          return;
        const location = {
          file,
          line: node.loc.start.line,
          endLine: node.loc.end.line,
          operation: name,
        };
        const variants = model.evaluate(expression);
        if (!variants || variants.some((value) => typeof value !== 'string')) {
          unresolved.push({
            ...location,
            expression: source.slice(expression.start, expression.end),
          });
          return;
        }
        for (let sql of [...new Set(variants)]) {
          if (name === 'createBatchQuery')
            sql = 'WITH request_scope(org,entries) AS (VALUES(?,?)) ' + sql;
          if (
            !/^\s*(SELECT|WITH|INSERT|UPDATE|DELETE|PRAGMA|BEGIN|COMMIT|ROLLBACK|CREATE)\b/i.test(
              sql,
            )
          ) {
            excluded.push({ ...location, reason: 'not-sql', sql });
            continue;
          }
          statements.push({ ...location, sql, method: name === 'exec' ? 'exec' : 'all' });
        }
      });
    }
  }
  for (const relative of [
    'src/server/application',
    'src/server/modules',
    'src/server/infrastructure',
  ])
    directory(relative);
  return { statements, unresolved, excluded };
}
function compileCorpus(corpus, catalogs) {
  const { compile } = require('../src/server/infrastructure/postgres/dialect.cjs');
  const { lex } = require('../src/server/infrastructure/postgres/dialect-lexer.cjs');
  const compiled = [],
    rejected = [],
    controls = [];
  for (const entry of corpus.statements) {
    if (/(assistant-executor-authority|platform-write-fence)\.cjs$/.test(entry.file)) {
      controls.push({
        ...entry,
        reason: 'sqlite-lock-implementation-replaced-by-native-pg-authority',
      });
      continue;
    }
    if (/^\s*PRAGMA\s+(busy_timeout|query_only)\b/i.test(entry.sql)) {
      controls.push({ ...entry, reason: 'explicit-coordinator-control' });
      continue;
    }
    if (
      /sqlite-configuration\.cjs$/.test(entry.file) ||
      /^\s*PRAGMA\s+foreign_keys\s*=\s*ON\s*;?$/i.test(entry.sql)
    ) {
      controls.push({ ...entry, reason: 'sqlite-configuration-pg-branch-is-separately-attested' });
      continue;
    }
    let count = 0;
    for (const token of lex(entry.sql))
      if (token.type === 'parameter')
        count = token.value ? Math.max(count, Number(token.value)) : count + 1;
    const candidates = [],
      errors = [];
    for (const [kind, catalog] of Object.entries(catalogs)) {
      const scope = { kind, storeId: '00000000-0000-4000-8000-000000000122' };
      try {
        const plan = compile(entry.sql, scope, Array(count).fill(null), entry.method, catalog);
        candidates.push({ kind, scope, plan });
      } catch (error) {
        errors.push({ kind, code: error.code, detail: error.detail || error.message });
      }
    }
    if (candidates.length) compiled.push({ ...entry, candidates });
    else rejected.push({ ...entry, errors });
  }
  return { compiled, rejected, controls, unresolved: corpus.unresolved, excluded: corpus.excluded };
}
module.exports = { collectRuntimeSQL, compileCorpus };
