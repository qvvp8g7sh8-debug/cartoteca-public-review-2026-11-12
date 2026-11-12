const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const corpus = require('../fixtures/assistant-accuracy-holdout.json');
const { dialogueFixture } = require('./assistant-dialogue-fixture.cjs');
const base = '../../src/server/modules/assistant/';
const { calendarReadIntent } = require(base + 'actions/calendar-read-request.cjs');
const { availabilityReadIntent } = require(base + 'actions/availability-read-request.cjs');
const { clientReadIntent } = require(base + 'actions/client-read-request.cjs');
const { appointmentCreateIntent } = require(base + 'actions/appointment-create-request.cjs');
const { handoff } = require(base + 'actions/actions.cjs');
const { resolveClient } = require(base + 'language/names/name-directory.cjs');
const { matchesName } = require(base + 'language/names/name-matching.cjs');
const { loadCatalog } = require(base + 'behavior/behavior-library.cjs');
const { assessmentForCase, libraryCoverage } = require(
  base + 'behavior/behavior-library-coverage.cjs',
);

function accuracyFixture(role = 'owner') {
  const f = dialogueFixture({ role }),
    original = f.patients[0];
  f.patients.splice(
    0,
    f.patients.length,
    ...corpus.clients.map(({ hidden, ...row }) => ({
      ...original,
      ...row,
      name: [row.firstName, row.middleName, row.lastName].join(' '),
      createdBy: hidden ? 'other-specialist' : 'owner',
      appointments: [],
      visits: [],
    })),
  );
  f.members[0].role = role;
  f.services.push({ id: 'consult', name: 'Консультация', duration: 60, staffId: 'owner' });
  f.state.policy.commands = {
    calendar: true,
    availability: true,
    clients: true,
    prepareAppointment: true,
  };
  f.c.platform.workSchedules.view = () => ({
    days: Object.fromEntries(
      ['2099-01-05', '2099-01-06', '2099-01-07'].map((date) => [
        date,
        { status: 'working', intervals: [['09:00', '18:00']] },
      ]),
    ),
    closures: {},
  });
  f.changed();
  return f;
}

async function localIntent(text, f) {
  const calendar = calendarReadIntent(text, corpus.clock);
  if (calendar?.intent === 'calendar') return calendar;
  return (
    availabilityReadIntent(text, corpus.clock) ||
    clientReadIntent(text) ||
    (await appointmentCreateIntent(text, corpus.clock, async (query) => {
      const found = await resolveClient(f.c, query);
      return !found.overflow && found.matches.some((patient) => matchesName(patient, query));
    }))
  );
}

function clinicalSnapshot(f) {
  return structuredClone({ patients: f.patients, busy: f.busy, services: f.services });
}
function entry(f) {
  return f.flow.get(f.c, f.member, f.state, f.result.dialogue.id);
}

async function evaluateAccuracy() {
  const catalog = loadCatalog();
  const report = {
    schemaVersion: 1,
    synthetic: true,
    source: corpus.source,
    corpusSha256: createHash('sha256').update(JSON.stringify(corpus)).digest('hex'),
    scope:
      'Offline local parser + canonical action/dialogue execution; no STT, LLM, TTS, browser, network or clinical database',
    localRouting: {
      cases: 0,
      passed: 0,
      failed: 0,
      accepted: 0,
      abstained: 0,
      falsePositive: 0,
      falseNegative: 0,
    },
    actions: { cases: 0, passed: 0, failed: 0 },
    dialogues: { cases: 0, passed: 0, failed: 0, turns: 0 },
    manualSave: {
      checked: 0,
      passed: 0,
      changedClinicalData: 0,
      preparedForms: 0,
      executionTickets: 0,
    },
    invariants: { checked: 0, passed: 0, failed: 0 },
    failures: [],
    observations: [],
    library: {
      coverage: libraryCoverage(catalog.cases),
      unresolved: catalog.cases.flatMap((row) => {
        const a = assessmentForCase(row);
        return ['needs_review', 'not_implemented'].includes(a.support)
          ? [
              {
                id: row.id,
                support: a.support,
                capability: a.capabilityId,
                gaps: a.gaps.map((g) => g.code),
              },
            ]
          : [];
      }),
    },
  };
  function check(group, id, fn) {
    const metric = report[group];
    metric.cases = (metric.cases || 0) + 1;
    try {
      fn();
      metric.passed++;
      return true;
    } catch (error) {
      metric.failed++;
      report.failures.push({ id, group, message: error.message });
      return false;
    }
  }
  function invariant(id, fn) {
    report.invariants.checked++;
    try {
      fn();
      report.invariants.passed++;
    } catch (error) {
      report.invariants.failed++;
      report.failures.push({ id, group: 'invariants', message: error.message });
    }
  }
  function noSave(f, before, id, result) {
    report.manualSave.checked++;
    if (result?.action?.type === 'prepareAppointment') report.manualSave.preparedForms++;
    if (result?.action?.executionId) report.manualSave.executionTickets++;
    try {
      assert.deepEqual(clinicalSnapshot(f), before);
      assert.equal(result?.saved, undefined);
      assert.equal(result?.action?.executionId, undefined);
      report.manualSave.passed++;
    } catch (error) {
      report.manualSave.changedClinicalData++;
      report.failures.push({ id, group: 'manualSave', message: error.message });
    }
  }
  invariant('holdout-is-not-a-prompt-example', () => {
    const authored = new Set(catalog.cases.map((r) => r.text));
    assert.equal(corpus.synthetic, true);
    const ids = [...corpus.initial, ...corpus.dialogues].map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const row of corpus.initial) assert.equal(authored.has(row.text), false, row.id);
  });
  for (const row of corpus.initial) {
    const f = accuracyFixture(row.role),
      before = clinicalSnapshot(f);
    let parsed;
    try {
      parsed = await localIntent(row.text, f);
    } catch (error) {
      parsed = { error: error.message };
    }
    if (parsed) report.localRouting.accepted++;
    else report.localRouting.abstained++;
    if (!row.intent && parsed) report.localRouting.falsePositive++;
    if (row.intent && !parsed) report.localRouting.falseNegative++;
    check('localRouting', row.id, () => assert.deepEqual(parsed, row.intent));
    if (row.intent && parsed?.intent === row.intent.intent) {
      let result;
      try {
        result =
          parsed.intent === 'prepareAppointment'
            ? f.start(parsed)
            : await handoff(f.c, parsed, f.state, corpus.clock);
        check('actions', row.id, () => {
          if (parsed.intent === 'prepareAppointment') {
            assert.equal(result.action, null);
            assert.equal(
              result.dialogue.step,
              row.id === 'booking-duration' ? 'client' : 'service',
            );
            const data = entry(f).data;
            for (const key of ['date', 'time', 'duration'])
              if (Object.hasOwn(row.intent, key)) assert.equal(data[key], row.intent[key]);
          } else if (parsed.intent === 'clientCard') {
            assert.deepEqual(
              result.action,
              row.patientId ? { type: 'clientCard', patientId: row.patientId } : null,
            );
          } else if (parsed.intent === 'calendar') {
            assert.deepEqual(result.action, {
              type: 'calendar',
              date: row.intent.date,
              mode: row.intent.mode,
              staffId: 'owner',
            });
          } else if (parsed.intent === 'availability') {
            assert.equal(result.action, null);
            assert.ok(result.slots.length > 0);
            for (const slot of result.slots) {
              assert.equal(slot.date, row.intent.date);
              assert.equal(slot.duration, row.intent.duration);
              assert.ok(slot.time >= '09:00' && slot.endTime <= '18:00');
            }
          } else assert.equal(result.action.type, 'clients');
        });
      } catch (error) {
        check('actions', row.id, () => {
          throw error;
        });
      }
      noSave(f, before, row.id, result);
    } else noSave(f, before, row.id, null);
    report.observations.push({
      id: row.id,
      kind: 'initial',
      expected: row.intent?.intent || 'model_fallback',
      actual: parsed?.intent || 'model_fallback',
    });
  }
  for (const row of corpus.dialogues) {
    const f = accuracyFixture(),
      before = clinicalSnapshot(f);
    try {
      f.start({
        query: row.query,
        serviceQuery: 'Чистка',
        date: corpus.clock.date,
        time: '10:00',
        ...(row.duration ? { duration: row.duration } : {}),
      });
      for (const [index, turn] of row.turns.entries()) {
        const previous = structuredClone(entry(f).data),
          result = f.answer({ text: turn.text }).result;
        report.dialogues.turns++;
        check('dialogues', row.id + '/' + index, () => {
          assert.equal(result.action?.type || null, turn.action || null);
          if (turn.step) assert.equal(result.dialogue.step, turn.step);
          const data = result.action || entry(f).data;
          assert.equal(result.action ? data.patientId : data.patient?.id || null, turn.patientId);
          for (const key of ['date', 'time', 'duration'])
            if (Object.hasOwn(turn, key)) assert.equal(data[key], turn[key]);
          if (turn.serviceId)
            assert.equal(result.action ? data.serviceIds[0] : data.service.id, turn.serviceId);
          if (turn.unchanged) assert.deepEqual(data, previous);
          if (turn.options !== undefined)
            assert.equal(result.dialogue.options.length, turn.options);
          if (turn.optionsMin) assert.ok(result.dialogue.options.length >= turn.optionsMin);
          if (turn.slotFrom)
            for (const option of entry(f).options.values()) {
              if (option.kind !== 'slot') continue;
              assert.ok(option.value.time >= turn.slotFrom && option.value.endTime <= turn.slotTo);
            }
        });
        noSave(f, before, row.id + '/' + index, result);
      }
    } catch (error) {
      check('dialogues', row.id, () => {
        throw error;
      });
    }
  }
  const f = accuracyFixture('cosmetologist');
  invariant('directory-acl-hidden-name-and-phone', () => {
    for (const query of ['Ларису Незнакомову', '+79990000106'])
      assert.equal(resolveClient(f.c, query).matches.length, 0);
    assert.equal(resolveClient(f.c, 'Алёну Журавлёву').matches[0].id, 'holdout-alena');
  });
  const first = f.start({
    query: 'Алёну Журавлёву',
    serviceQuery: 'Чистка',
    date: corpus.clock.date,
    time: '10:00',
  });
  const oldBody = {
    policyVersion: f.state.revision,
    dialogueId: first.dialogue.id,
    dialogueVersion: first.dialogue.version,
    text: 'время на 11:45',
  };
  f.answer({ text: 'время на 11:15' });
  invariant('stale-dialogue-version', () =>
    assert.throws(() => f.flow.continueDialogue(f.c, oldBody, f.state, f.member, f.clock), {
      status: 409,
    }),
  );
  invariant('dialogue-account-isolation', () =>
    assert.throws(
      () =>
        f.flow.continueDialogue(
          { ...f.c, current: { ...f.c.current, accountId: 'other-account' } },
          oldBody,
          f.state,
          f.member,
          f.clock,
        ),
      { status: 409 },
    ),
  );
  report.passed = report.failures.length === 0;
  return report;
}
module.exports = { evaluateAccuracy, accuracyFixture, corpus };
