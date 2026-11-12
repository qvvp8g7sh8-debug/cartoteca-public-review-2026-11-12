const assert = require('node:assert/strict');
const path = require('node:path');
const { createStorage } = require('../../src/server/infrastructure/cabinet-storage.cjs');
const { zonedClock } = require('../../src/shared/time-zone.cjs');
const { shiftDate } = require('../../src/server/modules/assistant/language/time/temporal.cjs');
const { assistantBoundariesFixture } = require('./assistant-boundaries-fixture.cjs');
const day = '2099-01-05';
async function availabilityFixture(t, options) {
  const f = await assistantBoundariesFixture(t, options);
  try {
    const clinic = createStorage(path.join(f.directory, 'synthetic-clinic99'));
    f.cleanup(() => clinic.close());
    const org = f.owner.organizationId,
      owner = f.current('owner').accountId,
      staff = f.current('cosmetologist').accountId,
      ownerToken = f.actors.owner.token;
    const clock = zonedClock(new Date(), f.store.organizationTimeZone(org));
    clinic.write({
      revision: 0,
      services: [
        {
          id: 'owner-service99',
          name: 'Тестовая чистка',
          category: 'other',
          staffId: owner,
          duration: '30',
          price: 100,
        },
        {
          id: 'staff-service99',
          name: 'Тестовая консультация',
          category: 'other',
          staffId: staff,
          duration: '30',
          price: 100,
        },
      ],
      patients: [
        {
          id: 'synthetic-patient99',
          name: 'Синтетический клиент99',
          createdBy: owner,
          phone: '+79990009900',
          visits: [],
          appointments: [],
        },
      ],
    });
    const workspace = f.store.workspaceSettings(org);
    f.store.saveWorkspace(
      org,
      owner,
      {
        ...workspace,
        enabled: true,
        mode: 'shared',
        rooms: workspace.rooms.map((room) => ({
          ...room,
          staffMode: 'multiple',
          staffIds: [owner, staff],
        })),
      },
      () => clinic.read(),
    );
    function schedule(staffId, dates, status = 'working', intervals = [['09:00', '18:00']]) {
      const view = f.store.workSchedules.view(ownerToken, staffId, dates[0], dates.at(-1));
      const result = f.store.workSchedules.save(
        ownerToken,
        {
          staffId,
          dates,
          status,
          intervals,
          revision: view.revision,
          expectedTimeZone: view.timeZone,
        },
        clinic,
      );
      assert.equal(result.saved, true);
    }
    for (const staffId of [owner, staff]) {
      schedule(staffId, [clock.date, shiftDate(clock.date, 1)]);
      schedule(staffId, [day, shiftDate(day, 1)]);
    }
    const payload = clinic.read();
    payload.patients[0].appointments.push({
      id: 'synthetic-busy99',
      date: day,
      time: '09:00',
      duration: 30,
      staffId: staff,
      roomId: 'main',
      status: 'scheduled',
      service: 'Тестовая консультация',
      notes: 'Synthetic occupancy proof; never returned in available-window output',
    });
    clinic.write(payload);
    function context(role = 'owner') {
      const c = f.context(role);
      return {
        ...c,
        token: f.actors[role].token,
        tenantStore(organizationId) {
          assert.equal(organizationId, c.current.organizationId);
          assert.equal(organizationId, org);
          return clinic;
        },
      };
    }
    function turn(text, values = {}, role = 'owner', api = f.api) {
      return api.turn(context(role), { text, policyVersion: f.revision(), ...values });
    }
    return { ...f, clinic, context, turn, clock, ownerId: owner, staffId: staff, day, schedule };
  } catch (error) {
    await f.close();
    throw error;
  }
}
module.exports = { availabilityFixture, day };
