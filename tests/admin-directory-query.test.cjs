const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  searchWords,
  directoryQuery,
  directoryCursor,
} = require('../src/server/modules/admin/directory-query.cjs');
const context = {
  fail: (status, message) => Object.assign(Error(message), { status }),
  limitKey: (kind, text) =>
    crypto
      .createHmac('sha256', 'synthetic-directory-key')
      .update(kind + text)
      .digest('hex'),
};
test('directory normalizes indexed and queried words identically and binds filter values', () => {
  assert.deepEqual(searchWords('  Ёлки +7 (918) 123-45-67 '), [
    'елки',
    '7',
    '918',
    '123',
    '45',
    '67',
  ]);
  const result = directoryQuery(
    'organization',
    { q: 'Ёлки', plan: 'paid', status: 'active' },
    context,
  );
  assert.deepEqual(result.parameters, [
    'active',
    'paid',
    context.limitKey('admin-search', 'елки'),
    context.limitKey('admin-search', 'елки'),
  ]);
  assert.ok(result.clauses.every((clause) => !clause.includes('Ёлки')));
});
test('directory cursor is scoped and signed; oversized or malformed input cannot reach SQL', () => {
  const search = { q: 'Юлия', status: 'active' };
  const first = directoryQuery('account', search, context);
  const cursor = directoryCursor(
    first.scope,
    { created_at: 123, id: 'synthetic-account' },
    context.limitKey,
  );
  assert.equal(directoryQuery('account', { ...search, cursor }, context).cursor.time, 123);
  for (const options of [
    { ...search, cursor: 'x'.repeat(2049) },
    { ...search, cursor: '{}' },
    { ...search, status: 'suspended', cursor },
    { q: 'Я'.repeat(121) },
    { q: '1 2 3 4 5 6 7 8 9' },
  ])
    assert.throws(() => directoryQuery('account', options, context), { status: 400 });
  const tampered = JSON.parse(Buffer.from(cursor, 'base64url'));
  tampered.id = 'different-account';
  assert.throws(
    () =>
      directoryQuery(
        'account',
        { ...search, cursor: Buffer.from(JSON.stringify(tampered)).toString('base64url') },
        context,
      ),
    { status: 400 },
  );
});
