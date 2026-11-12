const { randomUUID } = require('node:crypto');
const { moveExecutionFixture } = require('./assistant-move-execution-fixture.cjs');
function managementCycleFixture(t, values = {}, constraints = {}, options = {}) {
  const f = moveExecutionFixture(t, {
    enabled: false,
    targetDate: null,
    targetTime: null,
    ...options,
    beforeStart(f) {
      f.addBooking({
        date: '2099-01-06',
        time: '12:00',
        service: 'Пилинг PRX-T133',
        serviceItems: [],
      });
      f.addBooking({ date: '2099-01-06', time: '15:00', service: 'Чистка', serviceItems: [] });
      f.members.push({
        accountId: 'staff-maria',
        firstName: 'Мария',
        lastName: 'Иванова',
        displayName: 'Мария Иванова',
        role: 'cosmetologist',
        status: 'active',
      });
      f.addBooking({
        date: '2099-01-06',
        time: '14:00',
        service: 'Чистка',
        staffId: 'staff-maria',
        serviceItems: [],
      });
      f.mutate((next) => {
        const p = structuredClone(next.patients[0]);
        p.id = randomUUID();
        p.firstName = 'Ольга';
        p.lastName = 'Семёнова';
        p.name = 'Ольга Семёнова';
        p.phone = '+79990005566';
        p.appointments = p.appointments
          .slice(0, 1)
          .map((row) => ({ ...row, id: randomUUID(), time: '17:00' }));
        next.patients.push(p);
      });
    },
  });
  f.start(values, constraints);
  const id = f.result.dialogue?.id;
  return {
    ...f,
    get result() {
      return f.result;
    },
    entry: () => f.flow.get(f.c, f.member, f.state, id),
    turn: (text) => f.answer({ text }),
    choose: (index) => f.answer({ choice: f.result.dialogue.options[index - 1].id }),
  };
}

module.exports = { managementCycleFixture };
