const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  checkDocumentation,
  fileNames,
  references,
  generatedReportReference,
  localEvidenceReference,
} = require('../scripts/check-docs.cjs');
const root = path.resolve(__dirname, '..');

function documentationFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-docs-'));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('cartoteca-docs-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const write = (file, content) => {
    const target = path.resolve(directory, file);
    assert.ok(target.startsWith(directory + path.sep));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  const rows = [];
  const writeMap = () =>
    write(
      'docs/MODULES.md',
      [
        '| Функция | Исходники | Правила | Тесты |',
        '| --- | --- | --- | --- |',
        ...rows.map((cells) => '| ' + cells.join(' | ') + ' |'),
        '',
      ].join('\n'),
    );
  const addModule = () => {
    const number = rows.length + 1;
    const source = `src/feature-${number}.js`;
    const focusedTest = `tests/feature-${number}.test.cjs`;
    write(source, '// Synthetic documentation fixture.\n');
    write(focusedTest, '// Synthetic focused-test reference.\n');
    rows.push([`Feature ${number}`, source, 'docs/CONTRACT.md', focusedTest]);
  };
  write(
    'AGENTS.md',
    'Разработка только локально.\nКарта: docs/MODULES.md; история: docs/RELEASES.md.\n',
  );
  write('docs/RELEASES.md', 'История — не разрешение на публикацию.\n');
  write('docs/CONTRACT.md', 'Synthetic feature contract.\n');
  write('docs/TESTS.md', 'tests/feature-1.test.cjs\n');
  for (let number = 0; number < 30; number += 1) addModule();
  writeMap();
  return { root: directory, rows, write, writeMap, addModule };
}

test('cold snapshot excludes generated evidence but never exempts missing source or unsafe paths', () => {
  for (const file of [
    '.release/candidates/lab-01/reports/windows/report.json',
    '.release/candidates/lab-01/deployment/independent-proof.json',
    '.release/candidates/lab-01/stand-isolation-continuation/aggregate.json',
    '.release/candidates/lab-01/stand-isolation-continuation-original.json',
    '.release/candidates/lab-01/image-123/image.json',
  ])
    assert.equal(generatedReportReference(file), true, file);
  for (const file of [
    '../outside.json',
    '.release/candidates/../report.json',
    '.release/candidates/lab-01/reports/../../src/contract.json',
    '.release/candidates/lab-01/source/package.json',
    '.release/candidates/lab-01/private/settings.json',
    'src/server/missing.json',
    '.release/unknown/report.json',
  ])
    assert.equal(generatedReportReference(file), false, file);
});

test('module map accepts a new complete feature without fixing the repository row count', (t) => {
  const fixture = documentationFixture(t);
  const initial = checkDocumentation(fixture.root);
  assert.equal(initial.moduleCount, fixture.rows.length);
  fixture.addModule();
  fixture.writeMap();
  const expanded = checkDocumentation(fixture.root);
  assert.equal(expanded.moduleCount, initial.moduleCount + 1);
  assert.equal(expanded.moduleCount, fixture.rows.length);
});

test('module map rejects broken routes without depending on repository contents', async (t) => {
  const fixture = documentationFixture(t);
  const originalRows = fixture.rows.map((cells) => [...cells]);
  checkDocumentation(fixture.root);
  const cases = [
    [
      'missing source',
      (fixture) => {
        fixture.rows[0][1] = 'src/missing.js';
      },
      /missing or unsafe file/,
    ],
    [
      'missing rule',
      (fixture) => {
        fixture.rows[0][2] = 'docs/MISSING.md';
      },
      /missing or unsafe file/,
    ],
    [
      'missing focused test',
      (fixture) => {
        fixture.rows[0][3] = 'tests/missing.test.cjs';
      },
      /missing or unsafe file/,
    ],
    [
      'source outside root',
      (fixture) => {
        fixture.rows[0][1] = '../outside.js';
      },
      /missing or unsafe file/,
    ],
    [
      'duplicate feature',
      (fixture) => {
        fixture.rows.push([...fixture.rows[0]]);
      },
      /Invalid or duplicate/,
    ],
    [
      'empty rule cell',
      (fixture) => {
        fixture.rows[0][2] = '';
      },
      /Invalid or duplicate/,
    ],
    [
      'extra column',
      (fixture) => {
        fixture.rows[0].push('extra');
      },
      /Invalid or duplicate/,
    ],
    [
      'source cell without file',
      (fixture) => {
        fixture.rows[0][1] = 'some source';
      },
      /no concrete file/,
    ],
    [
      'test cell without focused test',
      (fixture) => {
        fixture.rows[0][3] = fixture.rows[0][1];
      },
      /no focused test/,
    ],
    [
      'major feature groups omitted',
      (fixture) => {
        fixture.rows.pop();
      },
      /omits major feature groups/,
    ],
  ];
  for (const [name, mutate, expected] of cases) {
    await t.test(name, () => {
      fixture.rows.splice(0, fixture.rows.length, ...originalRows.map((cells) => [...cells]));
      mutate(fixture);
      fixture.writeMap();
      assert.throws(() => checkDocumentation(fixture.root), expected);
    });
  }
});

test('generated report exemption applies only to historical test evidence', (t) => {
  const fixture = documentationFixture(t);
  const report = '.release/candidates/lab-01/reports/windows/report.json';
  fixture.write('docs/TESTS.md', report + '\n');
  assert.equal(checkDocumentation(fixture.root).moduleCount, fixture.rows.length);
  fixture.rows[0][1] = report;
  fixture.writeMap();
  assert.throws(() => checkDocumentation(fixture.root), /missing or unsafe file/);
  fixture.rows[0][1] = 'src/feature-1.js';
  fixture.writeMap();
  for (const file of [
    'src/server/missing.json',
    '.release/candidates/lab-01/source/package.json',
    '../outside.json',
  ]) {
    fixture.write('docs/TESTS.md', file + '\n');
    assert.throws(() => checkDocumentation(fixture.root), /missing or unsafe file/, file);
  }
});

test('compact source paths and rule aliases expand to individual checked files', () => {
  assert.deepEqual(
    fileNames('src/client/modules/{profile,team}.js; tests/{profile,team}.test.cjs'),
    [
      'src/client/modules/profile.js',
      'src/client/modules/team.js',
      'tests/profile.test.cjs',
      'tests/team.test.cjs',
    ],
  );
  assert.deepEqual(references(root, 'DATABASE; docs/ACCESS.md; STYLES', true), [
    'docs/ACCESS.md',
    'docs/DATABASE.md',
    'docs/STYLES.md',
  ]);
  assert.deepEqual(references(root, 'src/client/modules/profile.js; profile-overview.js'), [
    'src/client/modules/profile.js',
    'src/client/modules/profile-overview.js',
  ]);
  assert.deepEqual(fileNames('../outside.md'), ['../outside.md']);
});

test('short instructions route every feature to existing sources, rules and focused tests', () => {
  const result = checkDocumentation(root);
  assert.ok(result.agentLines <= 55);
  assert.ok(result.moduleCount >= 30);
  const archive = fs.readFileSync(path.join(root, 'docs/RELEASES.md'), 'utf8');
  for (const release of [
    'async-workflows',
    'calendar-invitation',
    'patient-names',
    'video-consent',
    'cabinet-time',
  ])
    assert.ok(archive.includes('cartoteca:v2-2026-10-05-' + release), release);
  assert.ok(archive.includes('227 passed'));
  assert.ok(archive.includes('307 локальных'));
});

test('documentation gate rejects stale paths and history reintroduced into the short guide', (t) => {
  const fixture = documentationFixture(t);
  checkDocumentation(fixture.root);
  const guide = fs.readFileSync(path.join(fixture.root, 'AGENTS.md'), 'utf8');
  fixture.write('AGENTS.md', guide + '\ncartoteca:v2-old-release\n');
  assert.throws(() => checkDocumentation(fixture.root), /Release history/);
  fixture.write('AGENTS.md', guide);
  fixture.rows[0][1] = 'src/stale-reference.js';
  fixture.writeMap();
  assert.throws(() => checkDocumentation(fixture.root), /missing or unsafe file/);
});

test('historical local JSON evidence stays excluded from cold checks while source references remain strict', (t) => {
  const fixture = documentationFixture(t);
  const report = 'work/assistant-synthetic-20261016/final/report.json';
  assert.equal(localEvidenceReference(report), true);
  assert.equal(generatedReportReference(report), true);
  fixture.write('docs/TESTS.md', report + '\n');
  assert.equal(checkDocumentation(fixture.root).moduleCount, 30);
  fixture.rows[0][1] = report;
  fixture.writeMap();
  assert.throws(() => checkDocumentation(fixture.root), /missing or unsafe file/);
  fixture.rows[0][1] = 'src/feature-1.js';
  fixture.writeMap();
  for (const file of [
    'work/../outside.json',
    'work/x/../../outside.json',
    'work/x/private/report.json',
    'work/x/run.cjs',
    'src/missing.json',
  ]) {
    assert.equal(localEvidenceReference(file), false, file);
    assert.equal(generatedReportReference(file), false, file);
    fixture.write('docs/TESTS.md', file + '\n');
    assert.throws(() => checkDocumentation(fixture.root), /missing or unsafe file/, file);
  }
});

test('151 docs-relative generated reports retain the root work boundary', () => {
  assert.equal(generatedReportReference('../work/load-20261028-149/result149.json'), true);
  for (const file of [
    '../../work/run/result.json',
    '../work/../secret.json',
    '../src/server/missing.json',
    '../work/private/a.json',
  ])
    assert.equal(generatedReportReference(file), false, file);
});
