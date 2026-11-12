const test = require('node:test');
const assert = require('node:assert/strict');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const { directoryPage } = require('../src/server/modules/cabinet/directory.cjs');
const {
  createContinuationRuntime,
} = require('../src/server/modules/assistant/dialogue/continuation/continuation-runtime.cjs');

function localContinuation(start, fixtureOptions = { ambiguous: true }) {
  const f = dialogueFixture(fixtureOptions);
  const initial = f.start(start);
  const storage = f.c.tenantStore('org');
  const calls = { summaries: 0, directory: 0, appointmentContext: 0 };
  const directoryQueries = new Set();
  let active = true;
  let onSummaries = () => {};
  f.c.assertCurrent = () => {
    if (!active) throw Object.assign(new Error('Synthetic scope revoked'), { status: 403 });
  };
  f.c.assistantReads = {
    snapshot: async (operation) => operation(),
    timeZone: async () => 'Europe/Moscow',
    appointmentContext: async () => {
      calls.appointmentContext++;
      return { members: f.members, services: f.services };
    },
    summaries: async (ids) => {
      calls.summaries++;
      await onSummaries();
      return f.patients.filter((row) => ids.includes(row.id));
    },
    directory: async (query, limit) => {
      calls.directory++;
      directoryQueries.add(query);
      const url = new URL('http://synthetic.invalid/');
      url.searchParams.set('q', query);
      url.searchParams.set('limit', String(limit));
      return directoryPage(storage, f.c.current, url, undefined, 'Europe/Moscow');
    },
    serviceGroups: async () => ({ groups: [] }),
  };
  f.state.providers = { llm: { provider: 'codex' } };
  const runtime = createContinuationRuntime({
    dialogues: f.flow,
    scope(c) {
      c.assertCurrent();
      return { state: f.state, member: f.member };
    },
    invoke() {
      assert.fail('A deterministic answer must stay local');
    },
    now: () => Date.parse(day + 'T08:00:00+03:00'),
  });
  const request = (text) => ({
    policyVersion: f.state.revision,
    dialogueId: initial.dialogue.id,
    dialogueVersion: initial.dialogue.version,
    text,
  });
  return {
    f,
    initial,
    request,
    calls,
    directoryQueries,
    entry: () => f.flow.get(f.c, f.member, f.state, initial.dialogue.id),
    turn: (body) => runtime.run(f.c, body, f.state, f.member),
    revokeOnSummary() {
      onSummaries = () => {
        active = false;
      };
    },
  };
}

test('a locally recognized client choice reads its ACL summaries only once before applying', async () => {
  const f = localContinuation({ query: 'Семёнова' });
  const body = f.request('Анна');
  const reply = await f.turn(body);
  assert.equal(reply.dialogue.step, 'service');
  assert.equal(f.entry().data.patient.id, f.f.patients[0].id);
  assert.equal(f.calls.summaries, 1, 'summary calls during a single local answer');
  assert.equal((await f.turn(body)).dialogue.version, reply.dialogue.version);
  assert.equal(f.calls.summaries, 1, 'replay must not reapply the local answer');
});

test('scope revocation during the async summary read leaves the client unselected', async () => {
  const f = localContinuation({ query: 'Семёнова' });
  f.revokeOnSummary();
  await assert.rejects(f.turn(f.request('Анна')), { status: 403 });
  assert.equal(f.entry().version, f.initial.dialogue.version);
  assert.equal(f.entry().data.patient, null);
});

test('an ambiguous client reply builds the options from its single exact directory search', async () => {
  const f = localContinuation({ query: 'Семёнова' });
  const reply = await f.turn(f.request('Семёнова'));
  assert.equal(reply.dialogue.step, 'client');
  assert.deepEqual(
    reply.dialogue.options.map((option) => option.label),
    f.initial.dialogue.options.map((option) => option.label),
  );
  assert.equal(f.entry().data.patient, null);
  assert.ok(f.directoryQueries.size > 0);
  assert.equal(f.calls.directory, f.directoryQueries.size, 'each exact search variant runs once');
});
