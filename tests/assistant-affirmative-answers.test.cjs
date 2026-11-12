const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fastBookingOperation,
} = require('../src/server/modules/assistant/dialogue/dialogue-fast-booking.cjs');
const {
  serviceChoiceOperation,
} = require('../src/server/modules/assistant/language/services/service-suggestions.cjs');
const {
  clientSuggestionOperation,
  isFastContinuation,
} = require('../src/server/modules/assistant/dialogue/dialogue-input.cjs');
const { speechOperation } = require('../src/server/modules/assistant/dialogue/dialogue-speech.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const {
  isAffirmativeAnswer,
} = require('../src/server/modules/assistant/dialogue/affirmative-answer.cjs');
const repeats = [
  'да',
  'да-да',
  'да да',
  'да, да',
  'ага',
  'угу',
  'верно',
  'правильно',
  'точно',
  'подтверждаю',
  'конечно',
  'согласен',
  'согласна',
  'всё верно',
  'все правильно',
  'да, верно',
  'да всё правильно',
  'ага, точно',
  'да-верно-точно',
  'да?',
  'да-да?',
  'ага?',
  'правильно?',
  'да, верно?',
];
const uncertain = [
  'да, наверное',
  'да, верно нет',
  'ага, точно, но не надо',
  'ага нет',
  'угу, но не надо',
  'верно, но отмена',
  'правильно или нет',
  'точно не этот клиент',
  'конечно, если завтра',
  'подтверждаю, но перенеси',
  'всё верно, кроме времени',
  'да нет',
  'да-да, но не надо',
  'да-да на завтра',
  'да-да в 12:30',
  'да, наверное',
  'да или нет',
  'да-да…',
  'просто да-да',
];
const entry = (step, phase, choices) => ({
  step,
  data: {},
  response: { dialogue: { phase } },
  options: new Map(choices.map((row, index) => ['opaque-' + index, row])),
});
const closed = () =>
  entry('time', 'closedDay', [{ kind: 'closedDayContinue', value: day + '|owner' }]);
const service = () =>
  entry('service', 'serviceChoice', [
    { kind: 'service', approximateService: true, serviceName: 'Миндальный пилинг' },
  ]);
const client = () =>
  entry('client', 'clientChoice', [{ kind: 'client', approximate: true, value: 'person' }]);
const review = () => entry('review', undefined, [{ kind: 'ready' }]);
const slots = () => entry('time', 'slots', [{ kind: 'slot', value: { date: day, time: '12:00' } }]);

test('repeated yes confirms the current closed-day question and single offered slot locally', () => {
  for (const raw of repeats) {
    assert.deepEqual(
      fastBookingOperation(closed(), raw),
      { kind: 'choice', choice: 'opaque-0' },
      raw,
    );
    assert.deepEqual(
      fastBookingOperation(slots(), raw),
      { kind: 'choice', choice: 'opaque-0' },
      raw,
    );
  }
  const many = slots();
  many.options.set('second', { kind: 'slot', value: { date: day, time: '13:00' } });
  for (const raw of repeats) assert.notEqual(fastBookingOperation(many, raw)?.kind, 'choice');
});

test('repeated yes confirms only one current approximate service or client, never an arbitrary member of several', () => {
  for (const raw of repeats) {
    assert.equal(serviceChoiceOperation(service(), raw)?.kind, 'choice', raw);
    assert.equal(clientSuggestionOperation(client(), raw)?.kind, 'choice', raw);
  }
  const many = service();
  many.options.set('second', {
    kind: 'service',
    approximateService: true,
    serviceName: 'Молочный пилинг',
  });
  for (const raw of repeats) assert.equal(serviceChoiceOperation(many, raw)?.kind, 'localHelp');
  const manyClients = client();
  manyClients.options.set('second', { kind: 'client', approximate: true, value: 'other' });
  for (const raw of repeats)
    assert.equal(clientSuggestionOperation(manyClients, raw)?.kind, 'localHelp');
});

test('repeated yes at review remains a local request to prepare the ordinary form', () => {
  for (const raw of repeats) {
    assert.equal(isFastContinuation(raw, review()), true, raw);
    assert.deepEqual(speechOperation(review(), raw), { kind: 'choice', choice: 'opaque-0' }, raw);
  }
});

test('negative, hesitant, conditional and compound answers cannot act as unconditional confirmation', () => {
  for (const raw of uncertain) {
    assert.notEqual(fastBookingOperation(closed(), raw)?.kind, 'choice', raw);
    assert.notEqual(fastBookingOperation(slots(), raw)?.kind, 'choice', raw);
    assert.notEqual(serviceChoiceOperation(service(), raw)?.kind, 'choice', raw);
    assert.notEqual(clientSuggestionOperation(client(), raw)?.kind, 'choice', raw);
    assert.notEqual(speechOperation(review(), raw)?.kind, 'choice', raw);
  }
});

function fixture(t, role = 'owner', closedDay = false) {
  const f = dialogueFixture({ role });
  if (role === 'cosmetologist') f.members[0].role = role;
  if (closedDay) f.c.platform.workSchedules.view = () => ({ days: {}, closures: {} });
  let writes = 0;
  const store = f.c.tenantStore('org');
  for (const key of ['save', 'write'])
    store[key] = () => {
      writes++;
      throw Error('Forbidden appointment save');
    };
  f.start({
    query: 'Анна Семёнова',
    serviceQuery: 'Чистка',
    date: day,
    ...(closedDay ? {} : { time: '12:00' }),
  });
  t.after(() => {
    assert.equal(writes, 0);
    assert.ok(f.patients.every((row) => row.appointments.length === 0));
  });
  return f;
}

test('closed-day repeated confirmations remain bound to owner or administrator and then accept a future clock', async (t) => {
  for (const role of ['owner', 'salon_admin', 'cosmetologist'])
    for (const raw of repeats)
      await t.test(role + '/' + raw, (t) => {
        const f = fixture(t, role, true);
        const body = {
          policyVersion: f.state.revision,
          dialogueId: f.result.dialogue.id,
          dialogueVersion: f.result.dialogue.version,
          text: raw,
        };
        assert.equal(f.flow.prepareModelTurn(f.c, body, f.state, f.member, f.clock), null);
        f.answer({ text: raw });
        const e = f.flow.get(f.c, f.member, f.state, f.result.dialogue.id);
        if (role === 'cosmetologist') {
          assert.equal(f.result.dialogue.phase, 'closedDay');
          assert.equal(e.data.closedDayConfirmation, undefined);
          assert.equal(f.result.action, null);
        } else {
          assert.equal(e.data.closedDayConfirmation, day + '|owner');
          assert.equal(e.data.date, day);
          f.answer({ text: 'в 12:00' });
          assert.equal(f.result.dialogue.step, 'review');
        }
      });
});

test('every repeated review confirmation prepares only a form without a model request or appointment save', async (t) => {
  for (const raw of repeats)
    await t.test(raw, (t) => {
      const f = fixture(t);
      const body = {
        policyVersion: f.state.revision,
        dialogueId: f.result.dialogue.id,
        dialogueVersion: f.result.dialogue.version,
        text: raw,
      };
      assert.equal(f.flow.prepareModelTurn(f.c, body, f.state, f.member, f.clock), null);
      const result = f.answer({ text: raw }).result;
      assert.equal(result.action?.type, 'prepareAppointment');
      assert.equal(result.action.date, day);
      assert.equal(result.action.time, '12:00');
    });
});

test('the shared affirmative parser accepts only a bounded whole yes phrase', () => {
  for (const raw of [
    ...repeats,
    'ДА.',
    'Ага!',
    'Верно.',
    'Да-да!',
    'да — да',
    'да‑да',
    'да, да, да',
  ])
    assert.equal(isAffirmativeAnswer(raw), true, raw);
  for (const raw of [...uncertain, 'да...', 'да/да', 'да и да', 'да '.repeat(100), null, 1])
    assert.equal(isAffirmativeAnswer(raw), false, String(raw));
});

test('current approximate client and service confirmations retain known slots and stay local before review', async (t) => {
  for (const field of ['client', 'service'])
    for (const raw of repeats)
      await t.test(field + '/' + raw, (t) => {
        const f = dialogueFixture();
        let writes = 0;
        const store = f.c.tenantStore('org');
        for (const key of ['save', 'write'])
          store[key] = () => {
            writes++;
            throw Error('Forbidden appointment save');
          };
        if (field === 'service') {
          f.services[0].name = 'Миндальный пилинг';
          f.changed();
        }
        f.start({
          query: field === 'client' ? 'Анна Семенва' : 'Анна Семёнова',
          serviceQuery: field === 'service' ? 'миндалный пилинг' : 'Чистка',
          date: day,
          time: '12:00',
          duration: 45,
        });
        assert.equal(f.result.dialogue.step, field);
        const id = f.result.dialogue.id;
        const e = () => f.flow.get(f.c, f.member, f.state, id);
        const before = { date: e().data.date, time: e().data.time, duration: e().data.duration };
        const body = {
          policyVersion: f.state.revision,
          dialogueId: id,
          dialogueVersion: f.result.dialogue.version,
          text: raw,
        };
        assert.equal(f.flow.prepareModelTurn(f.c, body, f.state, f.member, f.clock), null);
        const result = f.answer({ text: raw }).result;
        assert.equal(result.dialogue.step, 'review');
        assert.deepEqual(
          { date: e().data.date, time: e().data.time, duration: e().data.duration },
          before,
        );
        assert.equal(writes, 0);
        assert.ok(f.patients.every((row) => row.appointments.length === 0));
      });
});

test('affirmative combinations contain only positive whole phrases and retain strict element bounds', () => {
  for (const raw of [
    'да, верно',
    'да всё правильно',
    'ага, точно',
    'да верно точно правильно',
    'да, верно?',
    'да, всё верно, согласен',
    'АГА — ТОЧНО!',
    'да, да, да, да, да, да, да, да',
  ])
    assert.equal(isAffirmativeAnswer(raw), true, raw);
  for (const raw of [
    'да верно точно правильно ага',
    'да да да да да да да да да',
    'да, нет',
    'не верно',
    'да наверное',
    'всё неправильно',
    'да, верно, наверное?',
    'ага, точно, на завтра',
    'да, верно, если свободно',
    'да,,верно',
    'да/верно',
    'да + верно',
  ])
    assert.equal(isAffirmativeAnswer(raw), false, raw);
});

test('action-bearing affirmatives are accepted only by the matching bound confirmation helper', () => {
  const {
    isConfirmationAnswer,
  } = require('../src/server/modules/assistant/dialogue/affirmative-answer.cjs');
  for (const raw of [
    'Верно, записывай',
    'Да, запиши эту запись',
    'Ага, продолжить',
    'Угу, записать',
  ]) {
    assert.equal(isConfirmationAnswer(raw, 'create'), true, raw);
    assert.equal(isAffirmativeAnswer(raw), false, raw);
    assert.equal(isConfirmationAnswer(raw, 'cancel'), false, raw);
    assert.equal(fastBookingOperation(closed(), raw)?.kind, 'choice', raw);
    assert.equal(fastBookingOperation(slots(), raw), null, raw);
  }
  for (const raw of [
    'удали',
    'удалить запись',
    'Да, отменить',
    'Верно, отмени',
    'Ага, отменяй эту запись',
    'Да, удали',
    'Верно, удалить эту запись',
    'Ага, удаляй приём',
  ]) {
    assert.equal(isConfirmationAnswer(raw, 'cancel'), true, raw);
    assert.equal(isConfirmationAnswer(raw, 'create'), false, raw);
    assert.equal(isConfirmationAnswer(raw, 'move'), false, raw);
    assert.equal(isAffirmativeAnswer(raw), false, raw);
    assert.equal(fastBookingOperation(closed(), raw), null, raw);
  }
  for (const raw of [
    'нет, удали',
    'да, удали клиента',
    'да, удали карточку',
    'да, удали другую запись',
    'да, удали если свободно',
    'да, удали или перенеси',
    'да, удали и отправь сообщение',
  ])
    assert.equal(isConfirmationAnswer(raw, 'cancel'), false, raw);
  for (const raw of [
    'нет, записывай',
    'да, нет, запиши',
    'да, отменить другую запись',
    'да, запиши если свободно',
    'ага, запиши и отправь сообщение',
    'записывай',
    'да, перенеси',
  ])
    assert.equal(isConfirmationAnswer(raw, 'create'), false, raw);
});
test('a generic combined yes to several exact clients keeps the active choice without a model or first-client selection', () => {
  const f = dialogueFixture({ ambiguous: true });
  const result = f.start({ query: 'Семёнова', serviceQuery: 'Чистка', date: day, time: '10:00' });
  assert.equal(result.dialogue.step, 'client');
  assert.equal(result.dialogue.options.length, 2);
  const body = {
    dialogueId: result.dialogue.id,
    dialogueVersion: result.dialogue.version,
    text: 'Ага, правильно',
  };
  assert.equal(f.flow.prepareModelTurn(f.c, body, f.state, f.member, f.clock), null);
  const reply = f.flow.continueDialogue(f.c, body, f.state, f.member, f.clock);
  assert.equal(reply.action, null);
  assert.equal(reply.dialogue.step, 'client');
  assert.equal(reply.dialogue.options.length, 2);
  assert.equal(f.flow.get(f.c, f.member, f.state, reply.dialogue.id).data.patient, null);
});
