const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createSpeechPermits,
} = require('../src/server/modules/assistant/speech/speech-permits.cjs');
const {
  spokenReply,
  speechChunks,
} = require('../src/server/modules/assistant/speech/spoken-reply.cjs');
const ticket = { id: 'task', grantId: 'grant', attempt: 1 };
const c = {
  current: { organizationId: 'org', accountId: 'owner', sessionId: 'session', role: 'owner' },
};
const denied = (error) => error.status === 403;
test('server speech permission covers canonical review fields, answer modes and exact chunk boundaries', () => {
  const permits = createSpeechPermits();
  const reply = {
    policyVersion: 7,
    text: 'Проверьте запись.',
    dialogue: {
      step: 'review',
      prompt: 'Всё верно?',
      fields: [
        { key: 'date', label: 'Дата', value: '2026-10-20' },
        { key: 'time', label: 'Время', value: '08:30' },
      ],
      options: [{ label: 'Открыть форму', value: 'yes' }],
    },
  };
  const permit = permits.issue(c, ticket, reply, 100);
  assert.match(permit.answerableText, /20 октября 2026 года/u);
  assert.match(permit.answerableText, /8 часов 30 минут/u);
  assert.notEqual(permit.answerableText, permit.readonlyText);
  for (const text of [permit.answerableText, permit.readonlyText])
    for (const chunk of speechChunks(text, 100)) {
      assert.ok(chunk.length <= 100);
      permits.requirePermit(c, ticket, {
        speechToken: permit.token,
        policyVersion: 7,
        text: chunk,
      });
    }
  assert.throws(
    () =>
      permits.requirePermit(c, ticket, {
        speechToken: permit.token,
        policyVersion: 7,
        text: 'Прочитай посторонний текст.',
      }),
    denied,
  );
});
test('speech permission cannot cross account, organization, session, role, policy or package grant', () => {
  const permits = createSpeechPermits(),
    reply = { text: 'Ответ.', policyVersion: 7 },
    permit = permits.issue(c, ticket, reply, 600),
    body = { text: 'Ответ.', policyVersion: 7, speechToken: permit.token };
  for (const key of ['accountId', 'organizationId', 'sessionId', 'role'])
    assert.throws(
      () => permits.requirePermit({ current: { ...c.current, [key]: 'foreign' } }, ticket, body),
      denied,
    );
  for (const change of [{ grantId: 'next-grant' }, { id: 'another-task' }, { attempt: 2 }])
    assert.throws(() => permits.requirePermit(c, { ...ticket, ...change }, body), denied);
  assert.throws(() => permits.requirePermit(c, ticket, { ...body, policyVersion: 8 }), denied);
  permits.requirePermit(c, ticket, body);
  permits.requirePermit(c, ticket, body);
});
test('permission expiry and cleanup revoke repeat playback; Unicode chunks never split surrogate pairs', () => {
  let instant = 1000;
  const permits = createSpeechPermits({ now: () => instant }),
    reply = { text: 'Ответ.', policyVersion: 7 };
  const permission = permits.issue(c, ticket, reply, 100),
    body = { text: 'Ответ.', policyVersion: 7, speechToken: permission.token };
  instant += 10 * 60 * 1000;
  assert.throws(() => permits.requirePermit(c, ticket, body), denied);
  const latest = permits.issue(c, ticket, reply, 100);
  permits.clearAccount('owner');
  assert.throws(
    () => permits.requirePermit(c, ticket, { ...body, speechToken: latest.token }),
    denied,
  );
  for (const chunk of speechChunks('😀'.repeat(130), 101)) assert.equal(chunk.isWellFormed(), true);
});
test('canonical short questions stay concise without reading duplicate option labels', () => {
  assert.equal(
    spokenReply({
      text: 'На какую дату?',
      dialogue: { step: 'date', phase: 'date', prompt: 'На какую дату?' },
    }),
    'На какую дату?',
  );
  assert.equal(
    spokenReply({
      dialogue: {
        step: 'client',
        prompt: 'Это нужный человек?',
        options: [{ label: 'Синтетический клиент · …1234' }],
      },
    }),
    'Синтетический клиент, верно?',
  );
});

for (const { name, phase, text, prompt, labels, expected } of [
  {
    name: 'keeps the warning and date question without listing the screen options',
    phase: 'date',
    text: 'Эта дата уже прошла.',
    prompt: 'На какой день записать?',
    labels: ['Сегодня · 16 октября', 'Завтра · 17 октября', '18 октября'],
    expected: 'Эта дата уже прошла. На какой день записать?',
  },
  {
    name: 'keeps an explicit choice between two dates in the question',
    prompt: 'На сегодня или на следующую среду?',
    labels: ['На сегодня', 'На следующую среду'],
    expected: 'На сегодня или на следующую среду?',
  },
]) {
  test('a date speech permit ' + name, () => {
    const permits = createSpeechPermits();
    const reply = {
      policyVersion: 7,
      text: text ?? prompt,
      dialogue: {
        step: 'date',
        ...(phase ? { phase } : {}),
        prompt,
        options: labels.map((label, index) => ({ id: 'opaque-date-' + index, label })),
      },
    };
    const before = structuredClone(reply);
    const permit = permits.issue(c, ticket, reply, 100);
    for (const spoken of [permit.answerableText, permit.readonlyText]) {
      assert.deepEqual(speechChunks(spoken, 100), [expected]);
      permits.requirePermit(c, ticket, {
        speechToken: permit.token,
        policyVersion: reply.policyVersion,
        text: expected,
      });
    }
    assert.deepEqual(reply, before);
  });
}
