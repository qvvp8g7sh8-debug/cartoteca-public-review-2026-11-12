const test = require('node:test');
const assert = require('node:assert/strict');
const {
  localSpeechHints,
} = require('../src/server/modules/assistant/providers/local-speech/local-speech-hints.cjs');

function immutable(value) {
  if (value && typeof value === 'object') {
    for (const next of Object.values(value)) immutable(next);
    Object.freeze(value);
  }
  return value;
}
function fixture(provider, dictionary = '') {
  let contextReads = 0;
  const forbidden = new Proxy(
    {},
    {
      get() {
        contextReads++;
        assert.fail('An initial/general STT hint cannot access a dialogue, actor or cabinet');
      },
    },
  );
  const state = immutable({ policy: { dictionary }, providers: { stt: { provider } } });
  const before = JSON.stringify(state);
  return {
    state,
    hint: (body = {}) => localSpeechHints(forbidden, forbidden, body, state, forbidden),
    unchanged() {
      assert.equal(JSON.stringify(state), before);
      assert.equal(contextReads, 0);
    },
  };
}

for (const provider of ['local', 'timeweb']) {
  test(
    provider + ' initial prompt offers only general literal command starts with zero context reads',
    () => {
      const f = fixture(provider, 'Пилинг PRX-T133; RF-лифтинг.');
      const prompt = f.hint();
      assert.match(
        prompt,
        /Открой карту клиента\. Открой карточку клиента\. Запиши клиента\. Перенеси запись клиента\. Отмени запись клиента\./u,
      );
      assert.match(prompt, /Распознавай речь дословно/u);
      assert.match(prompt, /не дописывай клиента, имя, фамилию, телефон/u);
      assert.ok(prompt.endsWith(f.state.policy.dictionary));
      assert.doesNotMatch(prompt, /Артур|Артём|Мороз|Семёнов|\+?\d{7,}/u);
      assert.ok(prompt.length <= 4000);
      f.unchanged();
    },
  );

  test(provider + ' empty first dictionary still yields a bounded generic prompt', () => {
    const f = fixture(provider);
    assert.match(f.hint(), /Открой карту клиента/u);
    assert.equal(f.hint(), f.hint({ dialogueId: undefined, dialogueVersion: undefined }));
    assert.ok(!f.hint().includes('\n'));
    f.unchanged();
  });

  for (const dictionary of ['а'.repeat(4000), '😀'.repeat(2000), 'а' + '😀'.repeat(1999) + 'б'])
    test(
      provider +
        ' retains the complete initial hint and trims only dictionary tail at the UTF-16 boundary ' +
        dictionary.slice(0, 2),
      () => {
        const f = fixture(provider, dictionary);
        const prompt = f.hint(),
          split = prompt.indexOf('\n');
        assert.ok(prompt.length <= 4000);
        assert.ok(split > 0);
        const initial = prompt.slice(0, split),
          base = prompt.slice(split + 1);
        assert.match(initial, /неуслышанные слова\.$/u);
        assert.ok(dictionary.startsWith(base));
        assert.ok(base.length < dictionary.length);
        assert.equal(prompt.isWellFormed(), true);
        assert.equal(f.state.policy.dictionary.length, 4000);
        f.unchanged();
      },
    );
}

test('pending Timeweb adds only a fixed step hint and leaves the administrator dictionary unchanged', () => {
  for (const dictionary of ['', '  Общий словарь.  ', '😀'.repeat(2000)]) {
    const f = fixture('timeweb', dictionary);
    const c = {
      assertCurrent() {},
      current: { organizationId: 'synthetic-org', accountId: 'synthetic-owner', role: 'owner' },
      tenantStore: () => assert.fail('Timeweb hints must not access clinical data'),
    };
    const entry = { step: 'time', version: 0 };
    for (const key of ['data', 'options'])
      Object.defineProperty(entry, key, { get: () => assert.fail('Timeweb must not read ' + key) });
    const prompt = localSpeechHints(
      c,
      { get: () => entry },
      { dialogueId: 'opaque-current', dialogueVersion: 0 },
      f.state,
      {},
    );
    assert.match(prompt, /Время: в девять утра/u);
    assert.doesNotMatch(prompt, /Открой карту|synthetic|opaque-current/u);
    assert.ok(prompt.length <= 4000);
    assert.equal(prompt.isWellFormed(), true);
    f.unchanged();
  }
});

for (const provider of ['local', 'timeweb'])
  test(
    provider + ' pending input requires both current dialogue fields before context access',
    () => {
      const f = fixture(provider, 'Общий словарь.');
      for (const body of [
        { dialogueId: 'current' },
        { dialogueVersion: 0 },
        { dialogueId: null, dialogueVersion: null },
      ])
        assert.throws(() => f.hint(body), { status: 400 });
      f.unchanged();
    },
  );

test('demo keeps its dictionary-only path and never starts inspecting dialogue metadata', () => {
  const f = fixture('demo', '  Демословарь без изменений.  ');
  const body = new Proxy({}, { get: () => assert.fail('Demo body metadata must stay unread') });
  assert.equal(f.hint(body), f.state.policy.dictionary);
  assert.equal(f.hint({}), f.state.policy.dictionary);
  f.unchanged();
});
