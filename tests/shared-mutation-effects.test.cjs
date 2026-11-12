const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { hasNoPlatformEffects } = require('../src/server/modules/cabinet/shared-mutation.cjs');
const { writeCabinetMutation } = require('../src/server/modules/cabinet/mutation-write.cjs');
const {
  createAppointmentConfirmations,
} = require('../src/server/modules/cabinet/confirmations.cjs');
function fixture() {
  let writes = 0;
  const confirmations = createAppointmentConfirmations({
    crypto,
    db: {
      prepare: () => ({
        run: () => {
          writes++;
        },
      }),
    },
  });
  const platform = {
    organizationTimeZone: () => 'Europe/Moscow',
    appointmentConfirmations: confirmations,
    telegram: {
      settings: () => ({ enabled: true, events: ['reminder'] }),
      cancelPending: () => {
        writes++;
      },
    },
    staffPush: {
      enqueue: () => {
        writes++;
      },
    },
  };
  const before = {
    revision: 0,
    services: [],
    patients: [
      {
        id: 'synthetic-patient',
        appointments: [
          {
            id: 'synthetic-appointment',
            date: '2035-01-01',
            time: '10:00',
            duration: 60,
            staffId: 'synthetic-staff',
            roomId: 'main',
            status: 'scheduled',
            service: { name: 'Synthetic', duration: 60 },
          },
        ],
        visits: [],
      },
    ],
  };
  return { platform, before, effects: () => writes };
}
test('no-effect eligibility matches existing confirmation/cancel/push semantics, including notes', () => {
  for (const change of [
    (p) => {
      p.name = 'Synthetic renamed';
    },
    (p) => {
      p.phone = '+79990000000';
    },
    (p) => {
      p.notes = 'Synthetic notes';
    },
    (p) => {
      p.appointments[0].notes = 'Synthetic appointment note';
    },
  ]) {
    const f = fixture(),
      next = structuredClone(f.before);
    change(next.patients[0]);
    assert.equal(hasNoPlatformEffects(f.platform, 'synthetic-org', f.before, next), true);
    writeCabinetMutation(
      f.platform,
      'synthetic-org',
      { write: () => ({ revision: 1 }) },
      f.before,
      next,
    );
    assert.equal(f.effects(), 0);
  }
});
test('appointment moves, changes, deletes, reassignments, completed states and dirty scheduling use legacy atomic path', () => {
  for (const change of [
    (p) => {
      p.appointments[0].time = '11:00';
    },
    (p) => {
      p.appointments[0].duration = 5;
    },
    (p) => {
      p.appointments[0].staffId = 'other';
    },
    (p) => {
      p.appointments[0].roomId = 'other';
    },
    (p) => {
      p.appointments[0].status = 'completed';
    },
    (p) => {
      p.appointments = [];
    },
    (p) => {
      p.appointments.push({ ...p.appointments[0], id: 'new' });
    },
    (p) => {
      p.id = 'other-patient';
    },
  ]) {
    const f = fixture(),
      next = structuredClone(f.before);
    change(next.patients[0]);
    assert.equal(hasNoPlatformEffects(f.platform, 'synthetic-org', f.before, next), false);
  }
  const f = fixture();
  f.platform.notificationSchedule = { enabled: true };
  assert.equal(hasNoPlatformEffects(f.platform, 'synthetic-org', f.before, f.before), false);
});

test('prepared but disabled scheduling preserves note-only eligibility; unknown and enabled modes remain conservative', () => {
  for (const mode of [false, true, undefined, 'false']) {
    const f = fixture(),
      next = structuredClone(f.before);
    next.patients[0].notes = 'Synthetic note without appointment change';
    f.platform.notificationSchedule = { enabled: mode };
    assert.equal(hasNoPlatformEffects(f.platform, 'synthetic-org', f.before, next), mode === false);
    next.patients[0].appointments[0].time = '11:00';
    assert.equal(hasNoPlatformEffects(f.platform, 'synthetic-org', f.before, next), false);
  }
});

test('only revalidated shared notes skip a disabled schedule projection; ordinary commits and enabled modes retain it', () => {
  for (const [mode, sharedNoEffects, expected] of [
    [false, true, 0],
    [false, false, 1],
    [true, true, 1],
    [undefined, true, 1],
    ['false', true, 1],
  ]) {
    const f = fixture(),
      next = structuredClone(f.before),
      dirty = [];
    next.patients[0].notes = 'Synthetic unchanged appointment';
    f.platform.notificationSchedule = { enabled: mode, markDirty: (...args) => dirty.push(args) };
    writeCabinetMutation(
      f.platform,
      'synthetic-org',
      { write: () => ({ revision: 1 }) },
      f.before,
      next,
      undefined,
      undefined,
      undefined,
      { sharedNoEffects },
    );
    assert.equal(dirty.length, expected);
    assert.equal(f.effects(), 0);
    if (expected) assert.deepEqual(dirty[0], ['synthetic-org']);
  }
});
