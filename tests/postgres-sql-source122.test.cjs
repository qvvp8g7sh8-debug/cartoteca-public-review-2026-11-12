const test = require('node:test');
const assert = require('node:assert/strict');
const { sourceModel, nodes } = require('../scripts/postgres-sql-source.cjs');

test('SQL source enumeration keeps literal/map branches and explicitly refuses mutated or external builders', () => {
  const source = `const table=flag?'accounts':'organizations';
    db.prepare('SELECT id FROM '+table+' WHERE id=?');
    [['account','accounts'],['organization','organizations']].map(([kind,name])=>db.prepare('SELECT value FROM '+name));
    const clauses=['1=1']; if(active)clauses.push('status=?');
    db.prepare('SELECT id FROM accounts WHERE '+clauses.join(' AND '));
    function forwarded(sql){db.prepare(sql)};`;
  const model = sourceModel(source),
    entries = [];
  nodes(model.tree, (node) => {
    if (
      node.type === 'CallExpression' &&
      node.callee.type === 'MemberExpression' &&
      node.callee.property.name === 'prepare'
    )
      entries.push(model.evaluate(node.arguments[0]));
  });
  assert.deepEqual(entries, [
    ['SELECT id FROM accounts WHERE id=?', 'SELECT id FROM organizations WHERE id=?'],
    ['SELECT value FROM accounts', 'SELECT value FROM organizations'],
    null,
    null,
  ]);
});
test('repeated conditions remain correlated and dependent function tuples require actual builder capture', () => {
  const source = `const feature=flag;
    db.prepare('INSERT INTO t(a'+(feature?',b':'')+') VALUES(?'+(feature?',?':'')+')');
    function phase(table,assignment){db.prepare('UPDATE '+table+' SET '+assignment)}
    phase('one','a=?');phase('two','b=?');`;
  const model = sourceModel(source),
    values = [];
  nodes(model.tree, (node) => {
    if (
      node.type === 'CallExpression' &&
      node.callee.type === 'MemberExpression' &&
      node.callee.property.name === 'prepare'
    )
      values.push(model.evaluate(node.arguments[0]));
  });
  assert.deepEqual(values, [
    ['INSERT INTO t(a,b) VALUES(?,?)', 'INSERT INTO t(a) VALUES(?)'],
    null,
  ]);
});
