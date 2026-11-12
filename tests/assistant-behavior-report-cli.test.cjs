const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const script = path.join(__dirname, '../scripts/assistant-behavior-report.cjs');
const id = (number) => 'case-00000000-0000-4000-8000-' + String(number).padStart(12, '0');
const hash = (letter = 'a') => letter.repeat(64);
function run(value, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], {
    input: typeof value === 'string' ? value : JSON.stringify(value),
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 65536,
    windowsHide: true,
  });
  assert.equal(result.error, undefined);
  return result;
}
function json(value) {
  const result = run(value);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}
function create(
  signal = {
    capabilityId: 'moveAppointment',
    phase: 'date',
    fields: { before: ['client', 'time'], after: ['client'] },
  },
) {
  return json({ create: { id: id(1), signal } });
}
test('local CLI roundtrips a saved JSON record through reproduction, cause, matching repair and three regression groups', () => {
  const report = create();
  assert.equal(report.status, 'reported');
  const repro = json({
    record: report,
    command: { action: 'reproduce', caseId: id(2), fixtureStamp: hash() },
  });
  const diagnosed = json({
    record: repro,
    command: { action: 'diagnose', gapCode: 'context_lost', evidenceStamp: hash('b') },
  });
  const patched = json({
    record: diagnosed,
    command: { action: 'patch', kind: 'context', sourceStamp: hash('c') },
  });
  const verified = json({
    record: patched,
    command: {
      action: 'verify',
      sourceStamp: hash('c'),
      regressions: [
        { caseId: id(2), relation: 'reported', passed: true },
        { caseId: id(3), relation: 'neighbor', passed: true },
        { caseId: id(4), relation: 'boundary', passed: true },
      ],
    },
  });
  assert.equal(verified.status, 'verified');
  assert.equal(verified.patch.sourceStamp, hash('c'));
  assert.equal(verified.signal.capabilityId, 'moveAppointment');
  assert.equal(verified.verification.regressions.length, 3);
  const human = run(
    {
      record: patched,
      command: {
        action: 'verify',
        sourceStamp: hash('c'),
        regressions: verified.verification.regressions,
      },
    },
    ['--human'],
  );
  assert.equal(human.status, 0);
  assert.match(human.stdout, /Обязательные метки и три группы проверок приложены/u);
  assert.doesNotMatch(human.stdout, /Не хватает:/u);
  assert.equal(report.status, 'reported', 'prior stdout record remains a separate immutable value');
});
test('irrelevant examples remain unconfirmed until diagnosis and keep defect classification through verified CLI roundtrip', () => {
  const report = create({
    capabilityId: 'clients',
    phase: 'initial',
    checks: { exampleSelection: 'irrelevant' },
  });
  assert.equal(report.disposition, 'review_required');
  const reproduced = json({
    record: report,
    command: { action: 'reproduce', caseId: id(2), fixtureStamp: hash() },
  });
  assert.equal(reproduced.disposition, 'review_required');
  const diagnosed = json({
    record: reproduced,
    command: { action: 'diagnose', gapCode: 'example_selection', evidenceStamp: hash('b') },
  });
  assert.equal(diagnosed.disposition, 'defect');
  const patched = json({
    record: diagnosed,
    command: { action: 'patch', kind: 'examples', sourceStamp: hash('c') },
  });
  const verified = json({
    record: patched,
    command: {
      action: 'verify',
      sourceStamp: hash('c'),
      regressions: [
        { caseId: id(2), relation: 'reported', passed: true },
        { caseId: id(3), relation: 'neighbor', passed: true },
        { caseId: id(4), relation: 'boundary', passed: true },
      ],
    },
  });
  assert.equal(verified.status, 'verified');
  assert.equal(verified.disposition, 'defect');
  assert.equal(report.disposition, 'review_required');
});

test('human output distinguishes unknown evidence, a suspected context loss and a recorded cause without printing code or client data', () => {
  const unknown = run({ create: { id: id(1), signal: { capabilityId: 'calendar' } } }, ['--human']);
  assert.equal(unknown.status, 0);
  assert.match(unknown.stdout, /Подтверждённая причина пока не установлена/u);
  assert.match(unknown.stdout, /данных недостаточно/u);
  assert.match(unknown.stdout, /Слой исправления: пока не выбран/u);
  const report = create();
  const suspected = run(
    { record: report, command: { action: 'reproduce', caseId: id(2), fixtureStamp: hash() } },
    ['--human'],
  );
  assert.match(suspected.stdout, /Признаки для проверки: Потеряны ранее выбранные данные/u);
  assert.match(suspected.stdout, /ещё не установленная причина/u);
  const repro = json({
    record: report,
    command: { action: 'reproduce', caseId: id(2), fixtureStamp: hash() },
  });
  const cause = run(
    {
      record: repro,
      command: { action: 'diagnose', gapCode: 'context_lost', evidenceStamp: hash('b') },
    },
    ['--human'],
  );
  assert.equal(cause.status, 0);
  assert.match(cause.stdout, /Подтверждённое в карточке разбора/u);
  assert.match(cause.stdout, /Слой исправления: сохранение контекста/u);
  assert.match(cause.stdout, /Не хватает: исправление/u);
  assert.match(cause.stdout, /сам тесты не запускает/u);
  assert.doesNotMatch(cause.stdout, /schemaVersion|sourceStamp|case-0000|\{"/u);
});
test('unsafe fields, mixed operations and skipped lifecycle steps fail without echoing input, errors or secrets', () => {
  const report = create();
  for (const input of [
    '{PRIVATE_BROKEN_JSON',
    { create: { id: id(1), signal: { rawText: 'PRIVATE_UTTERANCE', phone: '79990000001' } } },
    { create: { id: id(1), signal: { stamps: { apiKey: 'PRIVATE_KEY' } } } },
    { create: { id: id(1), signal: {} }, record: report, command: { action: 'reproduce' } },
    { record: report, command: { action: 'patch', kind: 'context', sourceStamp: hash() } },
    {
      record: { ...report, modelText: 'PRIVATE_MODEL_TEXT' },
      command: { action: 'reproduce', caseId: id(2), fixtureStamp: hash() },
    },
  ]) {
    const result = run(input);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Не удалось принять диагностический случай/u);
    assert.doesNotMatch(result.stderr, /PRIVATE|7999000|Error:|at .*\.cjs/u);
  }
  assert.equal(run({ create: { id: id(1), signal: {} } }, ['--file', 'PRIVATE_FILE']).status, 2);
});
test('stdin accepts the exact32KiB limit and rejects an otherwise valid larger document before metadata processing', () => {
  const input = JSON.stringify({ create: { id: id(1), signal: { capabilityId: 'calendar' } } });
  const bounded = input + ' '.repeat(32768 - Buffer.byteLength(input));
  assert.equal(run(bounded).status, 0);
  const tooLarge = run(bounded + ' ');
  assert.equal(tooLarge.status, 2);
  assert.equal(tooLarge.stdout, '');
});
