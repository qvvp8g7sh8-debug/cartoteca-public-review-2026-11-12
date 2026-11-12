const { fail } = require('../../../shared/errors.cjs');
const { isActiveAppointment } = require('../../../shared/appointment-status.cjs');
const { startsAt } = require('../../../shared/time-zone-instant.cjs');
const { allAppointments, roomFor } = require('./policy.cjs');

function roomAssignmentValues(values, prior, members) {
  if (
    !Array.isArray(values.roomAssignments) ||
    !values.roomAssignments.length ||
    values.roomAssignments.length > 50
  )
    throw fail(400, 'Проверьте назначения сотрудников в кабинеты.');
  const rooms = new Map(prior.rooms.map((room) => [room.id, room])),
    people = new Map(members.map((member) => [member.accountId, member])),
    assignments = new Map();
  for (const entry of values.roomAssignments) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      Object.keys(entry).some(
        (key) => !['id', 'staffMode', 'staffIds', 'preventOverlap'].includes(key),
      ) ||
      typeof entry.id !== 'string' ||
      !rooms.has(entry.id) ||
      assignments.has(entry.id)
    )
      throw fail(
        400,
        'Можно изменить назначения и пересечения только в существующих кабинетах, без повторов.',
      );
    const hasStaffMode = Object.hasOwn(entry, 'staffMode'),
      hasStaffIds = Object.hasOwn(entry, 'staffIds'),
      hasOverlap = Object.hasOwn(entry, 'preventOverlap'),
      patch = {};
    if (
      hasStaffMode !== hasStaffIds ||
      (!hasStaffMode && !hasOverlap) ||
      (hasOverlap && typeof entry.preventOverlap !== 'boolean')
    )
      throw fail(400, 'Проверьте назначения сотрудников и правило пересечений кабинета.');
    if (hasStaffMode) {
      if (
        !['single', 'multiple'].includes(entry.staffMode) ||
        !Array.isArray(entry.staffIds) ||
        entry.staffIds.length > 100 ||
        new Set(entry.staffIds).size !== entry.staffIds.length
      )
        throw fail(400, 'Проверьте назначения сотрудников в кабинеты.');
      for (const id of entry.staffIds) {
        const member = people.get(id);
        if (
          typeof id !== 'string' ||
          !member ||
          !['owner', 'cosmetologist'].includes(member.role) ||
          (member.status !== 'active' && !rooms.get(entry.id).staffIds.includes(id))
        )
          throw fail(400, 'Назначить можно только действующего специалиста этой организации.');
      }
      patch.staffMode = entry.staffMode;
      patch.staffIds = entry.staffIds;
    }
    if (hasOverlap) patch.preventOverlap = entry.preventOverlap;
    assignments.set(entry.id, patch);
  }
  return {
    revision: values.revision,
    enabled: prior.enabled,
    mode: prior.mode,
    roomLayout: prior.roomLayout,
    staffRules: prior.staffRules,
    rooms: prior.rooms.map((room) => ({ ...room, ...assignments.get(room.id) })),
  };
}

function assertRoomAssignments(prior, next, state, zone, ownerId, now = Date.now()) {
  for (const saved of allAppointments(state)) {
    if (
      !isActiveAppointment(saved) ||
      startsAt(saved, zone) + (Number(saved.duration) || 60) * 60000 <= now
    )
      continue;
    const appointment = saved.staffId ? saved : { ...saved, staffId: ownerId },
      before = roomFor(prior, appointment),
      after = roomFor(next, appointment);
    if (!before?.active || !before.staffIds.includes(appointment.staffId)) continue;
    if (!after?.active || !after.staffIds.includes(appointment.staffId) || after.id !== before.id)
      throw fail(
        409,
        saved.roomId
          ? 'У сотрудника есть будущие записи в этом кабинете. Сначала перенесите их вручную, затем измените назначение.'
          : 'У сотрудника есть будущие записи без указанного кабинета. Сначала выберите кабинет в этих записях, затем измените назначение.',
      );
  }
}

module.exports = { roomAssignmentValues, assertRoomAssignments };
