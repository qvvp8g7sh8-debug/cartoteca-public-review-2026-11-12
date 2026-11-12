const test = require('node:test');
const assert = require('node:assert/strict');
const { handoff } = require('../src/server/modules/assistant/actions/actions.cjs');
const clock = { date: '2026-10-16', hour: 8, minute: 0 };
function help(commands, role = 'owner', overrides = {}) {
  const c = {
    current: {
      accountId: 'synthetic-owner',
      organizationId: 'synthetic-org',
      role,
      globalAdmin: false,
      ...overrides,
    },
    platform: new Proxy(
      {},
      {
        get() {
          throw Error('Help must not read directories or clinical state');
        },
      },
    ),
    tenantStore() {
      throw Error('Help must not read clinical state');
    },
  };
  const state = { policy: { commands } },
    before = structuredClone(state);
  const result = handoff(c, { intent: 'help' }, state, clock);
  assert.deepEqual(state, before);
  assert.equal(result.action, null);
  return result.text;
}
test('help with every category disabled promises no hidden navigation, search or booking capability', () => {
  const text = help({ calendar: false, clients: false, prepareAppointment: false });
  assert.match(text, /выключен|недоступ|отключен/iu);
  assert.doesNotMatch(
    text,
    /могу показать|свободн|найти.*клиент|открыть.*карточ|нов.*запис|сохран/iu,
  );
});
test('calendar-only staff help asks one short question without offering disabled client or preparation actions', () => {
  const text = help({ calendar: true, clients: false, prepareAppointment: false }, 'cosmetologist');
  assert.equal(text, 'Что нужно сделать?');
  assert.doesNotMatch(text, /найти.*клиент|открыть.*карточ|нов.*запис|сохран/iu);
});
test('client-only help asks one short question without advertising disabled schedule or preparation', () => {
  const text = help({ calendar: false, clients: true, prepareAppointment: false });
  assert.equal(text, 'Что нужно сделать?');
  assert.doesNotMatch(text, /день|недел|месяц|расписан|свободн.*окн|нов.*запис|сохран/iu);
});
test('preparation help stays concise for every allowed role even when search and calendar are disabled', () => {
  const commands = { calendar: false, clients: false, prepareAppointment: true };
  for (const role of ['owner', 'salon_admin']) {
    const text = help(commands, role);
    assert.equal(text, 'Что нужно сделать?');
    assert.doesNotMatch(text, /найти.*клиент|карточ|недел|месяц|к вам/iu);
  }
  const staff = help(commands, 'cosmetologist');
  assert.equal(staff, 'Что нужно сделать?');
});
test('global administrators, missing organization and unknown roles are not promised clinical assistant capabilities', () => {
  const commands = { calendar: true, clients: true, prepareAppointment: true };
  for (const [role, overrides] of [
    ['owner', { globalAdmin: true }],
    ['owner', { organizationId: null }],
    ['global_admin', {}],
    [null, {}],
  ]) {
    const text = help(commands, role, overrides);
    assert.doesNotMatch(
      text,
      /могу показать|свободн.*окн|найти.*клиент|открыть.*карточ|нов.*запис|сохран/iu,
    );
  }
});
