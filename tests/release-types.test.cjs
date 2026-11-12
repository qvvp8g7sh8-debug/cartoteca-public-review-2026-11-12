const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { checkTypes } = require('../scripts/check-types.cjs');

test('type receipt reuses only success and invalidates on source, negative fixtures and lockfile', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-type-receipt-'));
  const before = process.env.CARTOTECA_RELEASE_TYPES_CACHE;
  process.env.CARTOTECA_RELEASE_TYPES_CACHE = '1';
  t.after(() => {
    if (before === undefined) delete process.env.CARTOTECA_RELEASE_TYPES_CACHE;
    else process.env.CARTOTECA_RELEASE_TYPES_CACHE = before;
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const write = (name, value) => {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), value);
  };
  write('src/client/example.js', '// valid');
  write('tests/contracts/negative.ts', '// negative fixture');
  write('tsconfig.contracts.json', '{}');
  write('package-lock.json', '{}');
  write('scripts/check-types.cjs', '// fixture checker');
  write('node_modules/typescript/package.json', '{"version":"synthetic"}');
  write(
    'node_modules/typescript/bin/tsc',
    `const fs=require('fs');
fs.appendFileSync('calls.txt','1');
if(fs.readFileSync('src/client/example.js','utf8').includes('invalid'))process.exit(1);`,
  );
  const count = () => fs.readFileSync(path.join(root, 'calls.txt'), 'utf8').length;
  checkTypes(root);
  checkTypes(root);
  assert.equal(count(), 1);
  write('tests/contracts/negative.ts', '// changed negative fixture');
  checkTypes(root);
  assert.equal(count(), 2);
  write('package-lock.json', '{"lockfileVersion":3}');
  checkTypes(root);
  assert.equal(count(), 3);
  write('src/client/example.js', '// invalid');
  assert.throws(() => checkTypes(root), /Typed client/);
  assert.throws(() => checkTypes(root), /Typed client/);
  assert.equal(count(), 5);
  write('src/client/example.js', '// fixed');
  checkTypes(root);
  assert.equal(count(), 6);
  delete process.env.CARTOTECA_RELEASE_TYPES_CACHE;
  checkTypes(root);
  checkTypes(root);
  assert.equal(count(), 8);
});
