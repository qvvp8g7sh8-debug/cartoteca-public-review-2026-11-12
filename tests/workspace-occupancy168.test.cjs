// Proposal only; not executed by its author.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createCabinetIndexReads,
} = require('../src/server/infrastructure/cabinet-index-reads145.cjs');
const { createWorkspace } = require('../src/server/modules/workspace/service.cjs');

const settings = () => ({
  revision: 0,
  enabled: true,
  rooms: ['r1', 'r2'].map((id) => ({
    id,
    name: 'Synthetic ' + id,
    active: true,
    staffIds: ['one', 'two'],
    preventOverlap: true,
  })),
  staffRules: [],
});
const appointment = (id, extra = {}) => ({
  id,
  patientId: 'neighbor',
  date: '2035-01-02',
  time: '10:00',
  duration: 30,
  staffId: 'two',
  roomId: 'r1',
  status: 'scheduled',
  patientName: 'SYNTHETIC NAME NOT USED BY RULE',
  notes: 'SYNTHETIC NOTES NOT USED BY RULE',
  ...extra,
});
const identities = [
  { accountId: 'one', role: 'owner', status: 'active' },
  { accountId: 'two', role: 'cosmetologist', status: 'active' },
];
function reader(rows) {
  const calls = [],
    decoded = [];
  const reads = createCabinetIndexReads({
    hash: (s) => 'synthetic:' + s,
    decode(value) {
      decoded.push(value);
      return value;
    },
    db: {},
    prepare(sql) {
      return {
        all(...args) {
          calls.push({ sql, args });
          if (sql.includes('FROM cabinet_days'))
            return rows.map((value) => ({ id: value.id, patient_id: value.patientId, value }));
          assert.match(sql, /FROM cabinet_summaries/);
          return [...new Set(rows.map((a) => a.patientId))].map((patient_id) => ({
            patient_id,
            value: { id: patient_id, name: 'Synthetic Contact', phone: 'Synthetic Phone' },
          }));
        },
      };
    },
  });
  return { reads, calls, decoded };
}
function outcome(fn) {
  try {
    fn();
    return { status: 200 };
  } catch (error) {
    return { status: error.status, message: error.message };
  }
}
function check(config, next, rows, legacy) {
  const f = reader(rows),
    workspace = createWorkspace({
      organization: () => ({ workspace: config }),
      organizationTimeZone: () => 'Europe/Moscow',
    });
  const result = outcome(() =>
    workspace.assertWorkspaceSelection(
      'synthetic-org',
      next,
      {
        indexes: {
          appointmentOccupancy: legacy ? f.reads.appointments : f.reads.appointmentOccupancy,
        },
      },
      identities,
    ),
  );
  return { ...f, result };
}
test('private occupancy retains policy inputs and patient exclusion without contact reads', () => {
  const rows = [appointment('a'), appointment('done', { status: 'completed' })],
    f = reader(rows),
    result = f.reads.appointmentOccupancy('2035-01-01', '2035-01-03');
  assert.deepEqual(
    result.map((a) => a.id),
    ['a', 'done'],
  );
  assert.deepEqual(Object.keys(result[0]).sort(), [
    'date',
    'duration',
    'id',
    'patientId',
    'roomId',
    'staffId',
    'status',
    'time',
  ]);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].sql, /SELECT DISTINCT a.id,a.patient_id,a.value FROM cabinet_days/);
  assert.doesNotMatch(f.calls[0].sql, /cabinet_summaries/);
  assert.deepEqual(f.calls[0].args, [
    'synthetic:day:2035-01-01',
    'synthetic:day:2035-01-02',
    'synthetic:day:2035-01-03',
  ]);
  assert.equal(f.decoded.length, rows.length);
  assert.equal(
    f.reads.appointments('2035-01-01', '2035-01-03', { includeNames: false })[0].patientId,
    undefined,
    'public no-name calendar DTO remains unchanged',
  );
});
test('workspace rule outcomes and exact errors match the former contact-bearing reader', (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2035-01-01T20:00:00Z'));
  const next = (extra = {}) => ({
    patients: [
      {
        id: 'changed',
        appointments: [appointment('new', { patientId: 'changed', staffId: 'one', ...extra })],
      },
    ],
  });
  const cases = [
    ['adjacent', settings(), next(), [appointment('n', { time: '10:30' })], 200],
    ['room overlap', settings(), next(), [appointment('n', { time: '10:15' })], 409],
    [
      'staff overlap',
      settings(),
      next(),
      [appointment('n', { time: '10:15', staffId: 'one', roomId: 'r2' })],
      409,
    ],
    ['inactive staff', settings(), next(), [appointment('n', { staffId: 'absent' })], 409],
    ['unknown room', settings(), next(), [appointment('n', { roomId: 'absent' })], 409],
    ['ambiguous legacy room', settings(), next(), [appointment('n', { roomId: undefined })], 409],
    [
      'changed patient old row',
      settings(),
      next(),
      [appointment('old', { patientId: 'changed' })],
      200,
    ],
    ['completed row', settings(), next(), [appointment('n', { status: 'completed' })], 200],
    ['cancelled row', settings(), next(), [appointment('n', { status: 'cancelled' })], 200],
    ['no_show row', settings(), next(), [appointment('n', { status: 'no_show' })], 200],
    ['legacy active status', settings(), next(), [appointment('n', { status: undefined })], 409],
    ['expired neighbor', settings(), next(), [appointment('n', { date: '2035-01-01' })], 200],
    [
      'midnight overlap',
      settings(),
      next({ date: '2035-01-01', time: '23:45', duration: 60 }),
      [appointment('n', { time: '00:15' })],
      409,
    ],
    ['no selected patients', settings(), { patients: [] }, [], 200],
    [
      'empty selected appointments',
      settings(),
      { patients: [{ id: 'changed', appointments: [] }] },
      [],
      200,
    ],
    ['closed selected row', settings(), next({ status: 'cancelled', roomId: 'absent' }), [], 200],
    [
      'completed selected row',
      settings(),
      next({ status: 'completed', staffId: 'absent' }),
      [],
      200,
    ],
  ];
  const inactive = settings();
  inactive.rooms[0].active = false;
  cases.push(['inactive room', inactive, next(), [appointment('n')], 409]);
  const unassigned = settings();
  unassigned.rooms[0].staffIds = ['one'];
  cases.push(['unassigned staff', unassigned, next(), [appointment('n')], 409]);
  const unprotected = settings();
  unprotected.enabled = false;
  unprotected.rooms.forEach((r) => {
    r.preventOverlap = false;
  });
  cases.push(['no overlap protection', unprotected, next(), [appointment('n')], 200]);
  const staffOnly = structuredClone(unprotected);
  staffOnly.staffRules = [{ staffId: 'one', preventOverlap: true }];
  cases.push([
    'staff rule active while global/rooms disabled',
    staffOnly,
    next(),
    [appointment('n', { staffId: 'one', roomId: 'r2' })],
    409,
  ]);
  const explicitAllowed = settings();
  explicitAllowed.staffRules = [{ staffId: 'one', preventOverlap: false }];
  explicitAllowed.rooms.forEach((r) => {
    r.preventOverlap = false;
  });
  cases.push([
    'explicit staff/room allow despite global enabled',
    explicitAllowed,
    next(),
    [appointment('n', { staffId: 'one' })],
    200,
  ]);
  const stillRoom = settings();
  stillRoom.staffRules = [{ staffId: 'one', preventOverlap: false }];
  cases.push([
    'explicit staff allow retains room protection',
    stillRoom,
    next(),
    [appointment('n', { staffId: 'one' })],
    409,
  ]);
  const unique = settings();
  unique.rooms = [unique.rooms[0]];
  cases.push([
    'unambiguous legacy room/staff fallback',
    unique,
    next({ staffId: undefined, roomId: undefined }),
    [],
    200,
  ]);
  const samePatient = next();
  samePatient.patients[0].appointments.push(appointment('retained', { patientId: 'changed' }));
  cases.push(['existing next patient own collision retained', settings(), samePatient, [], 409]);
  const multipleChanged = next();
  multipleChanged.patients.push({
    id: 'changed-two',
    appointments: [appointment('changed-two-a', { patientId: 'changed-two', time: '12:00' })],
  });
  cases.push([
    'all changed patients exclude their old canonical rows',
    settings(),
    multipleChanged,
    [
      appointment('old', { patientId: 'changed' }),
      appointment('old-two', { patientId: 'changed-two', time: '12:00' }),
    ],
    200,
  ]);
  for (const [label, config, state, rows, expected] of cases) {
    const before = JSON.stringify({ config, state, rows });
    const legacy = check(config, state, rows, true),
      narrow = check(config, state, rows, false);
    assert.deepEqual(narrow.result, legacy.result, label);
    assert.equal(narrow.result.status, expected, label);
    assert.equal(
      narrow.calls.some((c) => /cabinet_summaries/.test(c.sql)),
      false,
      label,
    );
    assert.equal(JSON.stringify({ config, state, rows }), before, label + ' does not mutate input');
    if (narrow.result.message) assert.doesNotMatch(narrow.result.message, /SYNTHETIC/);
  }
});
