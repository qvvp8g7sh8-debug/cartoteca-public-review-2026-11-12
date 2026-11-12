const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, deferred, flush } = require('./helpers/assistant-voice-booking-fixture.cjs');

function cardFixture(t, configuration = {}) {
  const f = fixture(t, configuration);
  f.w.document.body.insertAdjacentHTML('beforeend', '<input id="search">');
  f.state.selectedId = 'previous-patient';
  const loads = [],
    views = [];
  f.actions.ensurePatient = async (id, options) => {
    loads.push({ id, options });
    return { id, name: 'Артур Синтетический', appointments: [], visits: [] };
  };
  f.actions.setView = async (view) => {
    views.push(view);
    f.state.currentView = view;
    // Ordinary navigation mounts the actual assistant lifecycle on the new view.
    f.api.mountVoiceAssistant();
  };
  f.control.turn = async () => ({
    policyVersion: 1,
    intent: 'findClient',
    demo: false,
    text: 'Открываю карточку клиента.',
    dialogue: null,
    action: { type: 'clientCard', patientId: 'arthur-patient' },
  });
  return { ...f, loads, views };
}

for (const streaming of [false, true])
  test(
    'voice opens the exact fresh card and speaks one short completion after navigation; streaming=' +
      streaming,
    async (t) => {
      const f = cardFixture(t, {
        scope: { capabilities: { stt: { ready: true }, tts: { ready: true, streaming } } },
      });
      await f.hold();
      const pending = f.transcript('Открой карточку Артура Синтетического');
      await flush();
      assert.equal(f.loads.length, 1);
      assert.equal(f.loads[0].id, 'arthur-patient');
      assert.equal(f.loads[0].options.force, true);
      assert.deepEqual(f.views, ['card']);
      assert.equal(f.state.selectedId, 'arthur-patient');
      assert.equal(f.state.currentView, 'card');
      assert.equal(f.$('.voice-assistant-session').hidden, true);
      assert.equal(f.$('.voice-assistant-dialog').open, false);
      const speech = f.calls.filter((row) => row.route === '/api/assistant/speak');
      assert.equal(speech.length, 1);
      assert.equal(speech[0].body.text, 'Открыл карточку клиента.');
      assert.equal(speech[0].body.stream, streaming ? true : undefined);
      await f.finishSpeech();
      await pending;
      assert.equal(
        f.captures.length,
        1,
        'a completed open command does not restart the microphone',
      );
      assert.equal(f.$('.voice-assistant-session').hidden, true);
      assert.deepEqual(f.toasts, []);
    },
  );

test('a client clarification remains answerable and a manual choice continues to the card handoff', async (t) => {
  const f = cardFixture(t);
  f.control.turn = async (body) =>
    body.dialogueId
      ? {
          policyVersion: 1,
          dialogue: null,
          text: 'Открываю карточку клиента.',
          action: { type: 'clientCard', patientId: 'arthur-patient' },
        }
      : {
          policyVersion: 1,
          action: null,
          text: 'Артур Мкртчян или Артём Макартычян?',
          dialogue: {
            id: 'client-dialogue',
            version: 0,
            step: 'client',
            phase: 'clientChoice',
            prompt: 'Артур Мкртчян или Артём Макартычян?',
            input: { type: 'text', field: 'client' },
            options: [
              { id: 'arthur-choice', label: 'Артур Мкртчян' },
              { id: 'artem-choice', label: 'Артём Макартычян' },
            ],
            fields: [],
            canEdit: [],
          },
        };
  await f.hold();
  const pending = f.transcript('Открой карточку Артур');
  await flush();
  assert.equal(f.$('[data-assistant-picker="client"]').open, true);
  assert.equal(f.loads.length, 0);
  f.$('[data-assistant-picker="client"] [data-assistant-choice="arthur-choice"]').click();
  await flush();
  assert.equal(f.loads.length, 1);
  assert.equal(f.state.selectedId, 'arthur-patient');
  assert.equal(f.state.currentView, 'card');
  assert.equal(Boolean(f.$('[data-assistant-picker="client"]')?.open), false);
  assert.deepEqual(
    f.calls.filter((row) => row.route.endsWith('/speak')).map((row) => row.body.text),
    ['Артур Мкртчян или Артём Макартычян?', 'Открыл карточку клиента.'],
  );
  await f.finishSpeech();
  await pending;
  assert.equal(f.$('.voice-assistant-session').hidden, true);
});

test('a denied card load restores an actionable result instead of leaving a pending spinner or fallback card', async (t) => {
  const f = cardFixture(t);
  f.actions.ensurePatient = async () => {
    throw Object.assign(Error('Карточка недоступна.'), { status: 403 });
  };
  await f.hold();
  await f.transcript('Открой карточку Артура');
  await flush();
  assert.equal(f.state.currentView, 'calendar');
  assert.equal(f.state.selectedId, 'previous-patient');
  assert.deepEqual(f.views, []);
  assert.equal(f.$('.voice-assistant-session').hidden, false);
  assert.notEqual(f.$('.voice-assistant-session').dataset.assistantPhase, 'pending');
  assert.equal(f.$('[data-assistant-session-resume]').hidden, false);
  assert.match(f.$('[data-assistant-session-message]').textContent, /Карточка недоступна/);
  assert.equal(f.calls.filter((row) => row.route.endsWith('/speak')).length, 0);
});

test('a late card load cannot open or speak over manual navigation to another view', async (t) => {
  const f = cardFixture(t),
    load = deferred();
  f.actions.ensurePatient = () => load.promise;
  await f.hold();
  const pending = f.transcript('Открой карточку Артура');
  await flush();
  f.state.currentView = 'clients';
  f.api.mountVoiceAssistant();
  load.resolve({ id: 'arthur-patient' });
  await pending;
  await flush();
  assert.equal(f.state.currentView, 'clients');
  assert.equal(f.state.selectedId, 'previous-patient');
  assert.deepEqual(f.views, []);
  assert.equal(f.$('.voice-assistant-session').hidden, true);
  assert.equal(f.calls.filter((row) => row.route.endsWith('/speak')).length, 0);
});

test('handoff speech failure keeps the card opened and reports the audio error without a microphone loop', async (t) => {
  const f = cardFixture(t);
  f.control.speak = async () => {
    throw Error('Synthetic audio unavailable');
  };
  await f.hold();
  await f.transcript('Открой карточку Артура');
  await flush();
  assert.equal(f.state.currentView, 'card');
  assert.equal(f.state.selectedId, 'arthur-patient');
  assert.equal(f.$('.voice-assistant-session').hidden, true);
  assert.deepEqual(f.toasts, ['Действие выполнено, но не удалось озвучить результат.']);
  assert.equal(f.captures.length, 1);
});
