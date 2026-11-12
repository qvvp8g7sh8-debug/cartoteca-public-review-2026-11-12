const test = require('node:test'),
  assert = require('node:assert/strict');
const {
  prepareManagementIntent,
} = require('../src/server/modules/assistant/actions/appointments/appointment-management-intent.cjs');
const {
  parseModelIntent,
  modelPayload,
} = require('../src/server/modules/assistant/interpretation/intents.cjs');
const {
  commandCategory,
} = require('../src/server/modules/assistant/interpretation/intent-schema.cjs');
const clock = { date: '2026-10-16', hour: 10, minute: 0 };
for (const [intent, verb] of [
  ['moveAppointment', 'Перенеси'],
  ['cancelAppointment', 'Отмени'],
  ['editAppointment', 'Открой'],
]) {
  test(intent + ' preserves raw full client source and existing-record semantics', () => {
    const raw = verb + ' запись Гульнары Мухомидиановой завтра в 14:30.';
    const result = prepareManagementIntent(
      { intent, query: 'Гульнара Мухамедьянова', date: '2026-10-17', time: '14:30' },
      raw,
      clock,
    );
    assert.equal(result.intent.intent, intent);
    assert.match(result.intent.query, /Мухомидиановой/u);
    assert.equal(result.constraints.date, '2026-10-17');
    assert.equal(result.constraints.time, '14:30');
    assert.equal(commandCategory(intent), 'prepareAppointment');
  });
}
test('management cannot accept model-invented date or time absent from raw command', () => {
  const result = prepareManagementIntent(
    { intent: 'moveAppointment', query: 'Гульнара', date: '2026-10-20', time: '12:00' },
    'Перенеси запись Гульнары.',
    clock,
  );
  assert.equal(result.intent.date, undefined);
  assert.equal(result.intent.time, undefined);
  assert.equal(result.intent.query, 'Гульнары');
});
test('management keeps explicit uncertain target fields required rather than borrowing old fields', () => {
  const result = prepareManagementIntent(
    { intent: 'moveAppointment', query: 'Марина', date: '2026-10-17', time: '12:00' },
    'Перенеси запись Марины завтра в 12:00 или в 14:00.',
    clock,
  );
  assert.equal(result.constraints.date, '2026-10-17');
  assert.equal(result.constraints.time, null);
});
test('a negated or different operation cannot run under a model-proposed management action', () => {
  assert.throws(
    () =>
      prepareManagementIntent(
        { intent: 'cancelAppointment', query: 'Гульнара' },
        'Не отменяй запись Гульнары.',
        clock,
      ),
    (e) => e.status === 400,
  );
  assert.throws(
    () =>
      prepareManagementIntent(
        { intent: 'cancelAppointment', query: 'Гульнара' },
        'Перенеси запись Гульнары.',
        clock,
      ),
    (e) => e.status === 400,
  );
  assert.throws(
    () =>
      prepareManagementIntent(
        { intent: 'moveAppointment', query: 'Гульнара' },
        'Перенеси запись Гульнары и отмени другую.',
        clock,
      ),
    (e) => e.status === 400,
  );
});
test('model schema supports cancellation source filters but rejects silently ignored service changes', () => {
  assert.equal(
    parseModelIntent(
      JSON.stringify({ intent: 'cancelAppointment', query: 'Гульнара', date: '2026-10-17' }),
    ).intent,
    'cancelAppointment',
  );
  assert.throws(
    () =>
      parseModelIntent(
        JSON.stringify({ intent: 'editAppointment', query: 'Гульнара', duration: 60 }),
      ),
    (e) => e.status === 502,
  );
});

const {
  assertIntentAction,
} = require('../src/server/modules/assistant/interpretation/intent-action-grounding.cjs');
for (const [raw, intent] of [
  ['Перенеси запись Гульнары.', 'moveAppointment'],
  ['Отмени запись Гульнары.', 'cancelAppointment'],
  ['Измени запись Гульнары.', 'moveAppointment'],
  ['Открой карточку Поповой.', 'clientCard'],
  ['Открой список клиентов.', 'clients'],
  ['Запиши Гульнару.', 'prepareAppointment'],
])
  test('raw operation must agree with model dispatch: ' + raw, () => {
    assert.doesNotThrow(() => assertIntentAction(raw, intent));
    for (const other of ['prepareAppointment', 'clientCard', 'clients', 'cancelAppointment'])
      if (other !== intent)
        assert.throws(
          () => assertIntentAction(raw, other),
          (e) => e.status === 502,
        );
  });
test('negated and conflicting requested actions cannot start a different workflow', () => {
  for (const raw of [
    'Не отменяй запись Гульнары.',
    'Не переноси запись Гульнары.',
    'Не записывай Гульнару.',
  ])
    assert.throws(
      () => assertIntentAction(raw, 'prepareAppointment'),
      (e) => e.status === 400,
    );
  assert.throws(
    () => assertIntentAction('Перенеси запись Гульнары и отмени запись Марины.', 'moveAppointment'),
    (e) => e.status === 400,
  );
  assert.doesNotThrow(() =>
    assertIntentAction('Запиши Перенесину Галину на консультацию.', 'prepareAppointment'),
  );
  assert.doesNotThrow(() => assertIntentAction('Не отменяй запись.', 'help'));
});

test('new date/time may precede the operation without joining name tokens or losing proof', () => {
  const r = prepareManagementIntent(
    { intent: 'moveAppointment', query: 'Гульнара', date: '2026-10-17', time: '14:30' },
    'Завтра в14:30 перенеси запись Гульнары.',
    clock,
  );
  assert.equal(r.intent.query, 'Гульнары');
  assert.equal(r.constraints.date, '2026-10-17');
  assert.equal(r.constraints.time, '14:30');
});

// Shared finite operation grammar regressions.
const detector = require('../src/server/modules/assistant/interpretation/requested-operation.cjs');
for (const [raw, intent] of [
  ['Перенос записи Анны Семёновой', 'moveAppointment'],
  ['Отмена записи Анны Семёновой', 'cancelAppointment'],
  ['Изменение записи Анны Семёновой', 'moveAppointment'],
  ['Открой запись Анны Семёновой', 'editAppointment'],
  ['Откройте мне приём Анны Семёновой', 'editAppointment'],
  ['Найти карточку Анны Семёновой', 'clientCard'],
])
  test('guard and management use the same finite operation: ' + raw, () => {
    assert.doesNotThrow(() => assertIntentAction(raw, intent));
    assert.throws(
      () => assertIntentAction(raw, 'prepareAppointment'),
      (e) => e.status === 502,
    );
    if (['moveAppointment', 'cancelAppointment', 'editAppointment'].includes(intent)) {
      const result = prepareManagementIntent({ intent, query: 'Анна Семёнова' }, raw, clock);
      assert.equal(result.intent.query, 'Анны Семёновой');
    }
  });
for (const raw of [
  'Завтра в14:30 перенеси запись Гульнары.',
  'Пожалуйста, завтра в14:30 перенесите запись Гульнары.',
  'В14:30 завтра мне нужно перенести запись Гульнары.',
])
  test('source outside exact operation span stays intact: ' + raw, () => {
    const found = detector.detectRequestedOperation(raw);
    assert.equal(found.intent, 'moveAppointment');
    assert.equal(
      found.sourceWithoutCommand,
      raw.slice(0, found.operation.start) + ' ' + raw.slice(found.operation.end),
    );
    assert.match(found.sourceWithoutCommand, /14:30/u);
    assert.match(found.sourceWithoutCommand, /завтра/iu);
    const result = prepareManagementIntent(
      { intent: 'moveAppointment', query: 'Гульнара', date: '2026-10-17', time: '14:30' },
      raw,
      clock,
    );
    assert.equal(result.intent.query, 'Гульнары');
    assert.equal(result.constraints.date, '2026-10-17');
    assert.equal(result.constraints.time, '14:30');
  });
for (const name of ['Перенесина', 'Отменова', 'Изменилова', 'Клиентова', 'Клиенткина'])
  test('finite command grammar does not consume name components: ' + name, () => {
    const raw = 'Перенеси запись ' + name + ' Анны на завтра в14:30.';
    const result = prepareManagementIntent(
      { intent: 'moveAppointment', query: name + ' Анна' },
      raw,
      clock,
    );
    assert.equal(result.intent.query, name + ' Анны');
    const card = detector.detectRequestedOperation('Открой карточку ' + name + ' Анны.');
    assert.equal(card.intent, 'clientCard');
    assert.match(card.sourceWithoutCommand, new RegExp(name + ' Анны', 'u'));
  });
for (const raw of [
  'Не перенесите запись Анны.',
  'Не отмените запись Анны.',
  'Не изменяйте запись Анны.',
  'Не открывай запись Анны.',
  'Не открой карточку Анны.',
  'Не показывайте список клиентов.',
  'Не записывайте Анну.',
])
  test('negative forms always stop before action mismatch: ' + raw, () => {
    assert.throws(
      () => assertIntentAction(raw, 'prepareAppointment'),
      (e) => e.status === 400,
    );
    assert.throws(
      () => prepareManagementIntent({ intent: 'editAppointment', query: 'Анна' }, raw, clock),
      (e) => e.status === 400,
    );
    assert.doesNotThrow(() => assertIntentAction(raw, 'help'));
  });
test('multiple occurrences cannot lose a secondary task', () => {
  const raw = 'Перенеси запись Анны и перенеси запись Иры.';
  assert.equal(detector.detectRequestedOperation(raw).ambiguous, true);
  assert.throws(
    () => assertIntentAction(raw, 'moveAppointment'),
    (e) => e.status === 400,
  );
  assert.throws(
    () => prepareManagementIntent({ intent: 'moveAppointment', query: 'Анна' }, raw, clock),
    (e) => e.status === 400,
  );
});

test('old generic negative opening and secondary unsupported actions remain blocked', () => {
  assert.throws(
    () => assertIntentAction('Не открывай.', 'prepareAppointment'),
    (e) => e.status === 400,
  );
  for (const verb of ['удали', 'создай', 'сохрани']) {
    const raw = 'Перенеси запись Анны завтра и ' + verb + ' другую.';
    assert.throws(
      () => prepareManagementIntent({ intent: 'moveAppointment', query: 'Анна' }, raw, clock),
      (e) => e.status === 400,
    );
  }
});

test('finite negative habitual edit forms cannot become new bookings', () => {
  for (const verb of ['поправляй', 'поправляйте']) {
    const raw = 'Не ' + verb + ' запись Анны Семёновой.';
    for (const intent of ['editAppointment', 'prepareAppointment'])
      assert.throws(
        () => assertIntentAction(raw, intent),
        (e) => e.status === 400,
      );
    assert.throws(
      () =>
        prepareManagementIntent({ intent: 'editAppointment', query: 'Анна Семёнова' }, raw, clock),
      (e) => e.status === 400,
    );
    assert.doesNotThrow(() => assertIntentAction(raw, 'help'));
  }
});
for (const raw of [
  'Пожалуйста, перенеси запись Анны Семёновой на завтра в14:30.',
  'Мне нужно перенести запись Анны Семёновой на завтра в14:30.',
])
  test('polite management wrapper retains exact client and temporal proof: ' + raw, () => {
    const result = prepareManagementIntent(
      { intent: 'moveAppointment', query: 'Анна Семёнова', date: '2026-10-17', time: '14:30' },
      raw,
      clock,
    );
    assert.equal(result.intent.query, 'Анны Семёновой');
    assert.equal(result.constraints.date, '2026-10-17');
    assert.equal(result.constraints.time, '14:30');
  });

for (const [raw, intent] of [
  ['Открою карточку Алексея Петрова.', 'clientCard'],
  ['Открою запись Алексея Петрова.', 'editAppointment'],
])
  test('finite ASR future opening keeps explicit object dispatch: ' + raw, () => {
    const found = detector.detectRequestedOperation(raw);
    assert.equal(found.intent, intent);
    assert.match(found.sourceWithoutCommand, /Алексея Петрова/u);
    assert.doesNotThrow(() => assertIntentAction(raw, intent));
    assert.throws(
      () => assertIntentAction(raw, 'prepareAppointment'),
      (e) => e.status === 502,
    );
    assert.throws(
      () => assertIntentAction('Не ' + raw, intent),
      (e) => e.status === 400,
    );
    if (intent === 'editAppointment') {
      const result = prepareManagementIntent({ intent, query: 'Алексей Петров' }, raw, clock);
      assert.equal(result.intent.query, 'Алексея Петрова');
    }
  });
test('finite ASR future opening still requires an explicit object', () => {
  assert.equal(detector.detectRequestedOperation('Открою Алексея Петрова.').intent, null);
  assert.equal(detector.detectRequestedOperation('Открою список клиентов.').intent, null);
});
